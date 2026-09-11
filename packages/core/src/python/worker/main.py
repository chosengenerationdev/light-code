"""Light Code's Python tool worker.

One long-lived process per workspace, speaking JSON-RPC over stdio. It owns three jobs the
TypeScript side cannot do for itself:

* deriving a JSON Schema from ``run``'s type hints, so tool metadata is never hand-written
  and therefore never drifts from the code (CLAUDE.md §13);
* importing and reloading tool modules, so a tool edited mid-session takes effect without
  restarting;
* running the tool.

Framing is one JSON object per line. Length-prefixing would be sturdier, but a tool that
prints to stdout is *common* — so the reader tolerates unparseable lines instead, treating
them as the tool's own output rather than corrupting the channel.
"""

from __future__ import annotations

import importlib.util
import inspect
import io
import json
import re
import sys
import traceback
import types
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

# Loaded modules, keyed by tool name, so a reload replaces rather than shadows.
_MODULES: dict[str, Any] = {}


def _respond(payload: dict[str, Any]) -> None:
    """Write one frame.

    Always to the real stdout, captured at import time — a tool that reassigns
    ``sys.stdout`` would otherwise silently swallow every subsequent reply.
    """
    _REAL_STDOUT.write(json.dumps(payload) + "\n")
    _REAL_STDOUT.flush()


_REAL_STDOUT = sys.stdout
_REAL_STDIN = sys.stdin

# Counts nested calls out to the host, so a loop is stopped rather than left to fill the pipe.
_CALL_DEPTH = 0
_MAX_DEPTH = 4
_CURRENT_TOOL = ""
_CALL_SEQ = 0


class ToolError(RuntimeError):
    """A tool this one called came back with a failure."""


def call_tool(name: str, **arguments: Any) -> Any:
    """Calls another tool and returns its result.

    Available to every tool as ``light_code.call_tool``. Only other Python tools and MCP
    tools can be reached; see the host for why.

    This blocks the worker, which is correct: the tool asked for something and cannot
    continue without it. The host may prompt the user before running it, so it can take as
    long as a person takes to answer.
    """
    global _CALL_DEPTH
    if _CALL_DEPTH >= _MAX_DEPTH:
        raise ToolError(
            f"tool calls are nested {_MAX_DEPTH} deep, which is almost certainly a loop - "
            "a tool calling itself, or two calling each other"
        )

    global _CALL_SEQ
    _CALL_SEQ += 1
    # A counter, not ``id()``: CPython reuses an address the moment the object is collected, so
    # two calls in a row could be handed the same token.
    token = f"cb{_CALL_SEQ}"
    _CALL_DEPTH += 1
    try:
        _respond(
            {
                "callback": token,
                "method": "call_tool",
                "name": name,
                "arguments": arguments,
                "caller": _CURRENT_TOOL,
            }
        )
        # Read until the answer to *this* call arrives. Anything else on the stream would be a
        # protocol error rather than something to skip, so it is reported rather than ignored.
        while True:
            line = _REAL_STDIN.readline()
            if not line:
                raise ToolError("the host closed the connection while waiting for " + name)
            line = line.strip()
            if not line:
                continue
            frame = json.loads(line)

            if frame.get("callback") == token:
                if frame.get("ok"):
                    return frame.get("value")
                raise ToolError(frame.get("error") or f"{name} failed")

            # An ordinary request, arriving while this tool is blocked.
            #
            # It happens for real: the tool this one called is *another Python tool*, so the host
            # sends it down the same pipe while we are still waiting. Skipping it would deadlock —
            # the host waits for a reply that nobody is reading for — and treating it as an
            # out-of-order answer, which the first version did, fails every nested call between
            # two Python tools. So it is served here and the wait resumes.
            if "method" in frame:
                request_id = frame.get("id")
                try:
                    _respond({"id": request_id, "ok": True, "value": _handle(frame)})
                except Exception as error:  # noqa: BLE001 - every failure goes back as a result
                    _respond(
                        {
                            "id": request_id,
                            "ok": False,
                            "error": f"{type(error).__name__}: {error}",
                            "traceback": traceback.format_exc(),
                        }
                    )
                continue

            raise ToolError(
                "unexpected frame while waiting for " + name + "; this is a bug in Light Code"
            )
    finally:
        _CALL_DEPTH -= 1


def _install_helper_module() -> None:
    """Publishes ``light_code`` so a tool can ``import light_code`` and call other tools.

    A real module in ``sys.modules`` rather than a builtin or an injected global: a tool is
    an ordinary Python file that must also be readable, lintable and runnable on its own
    terms, and magic names appearing from nowhere break every one of those.
    """
    if "light_code" in sys.modules:
        return
    module = types.ModuleType("light_code")
    module.call_tool = call_tool  # type: ignore[attr-defined]
    module.ToolError = ToolError  # type: ignore[attr-defined]
    sys.modules["light_code"] = module


def _load(name: str, path: str) -> Any:
    """Imports a tool module from an explicit path, replacing any previous version."""
    _install_helper_module()
    spec = importlib.util.spec_from_file_location(f"light_code_tool_{name}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    # Executed with the tool's own stdout captured: a print at import time would otherwise
    # land in the middle of the JSON-RPC stream.
    with redirect_stdout(io.StringIO()):
        spec.loader.exec_module(module)
    if not hasattr(module, "run"):
        raise AttributeError(f"{path} defines no `run` function")
    _MODULES[name] = module
    return module


def _google_arg_docs(doc: str) -> dict[str, str]:
    """Pulls parameter descriptions out of a Google-style ``Args:`` block.

    Best-effort by design. A missing description costs the model a hint; a parser that threw
    would cost it the whole tool.
    """
    docs: dict[str, str] = {}
    match = re.search(r"^\s*Args:\s*$(.*?)(?=^\s*\w+:\s*$|\Z)", doc, re.MULTILINE | re.DOTALL)
    if not match:
        return docs
    for line in match.group(1).splitlines():
        entry = re.match(r"\s*(\w+)\s*(?:\([^)]*\))?\s*:\s*(.+)", line)
        if entry:
            docs[entry.group(1)] = entry.group(2).strip()
    return docs


#: Annotations the fallback can map without pydantic. Anything else becomes a string,
#: which is lossy but callable.
_PRIMITIVE_TYPES: dict[Any, str] = {
    str: "string",
    bool: "boolean",
    int: "integer",
    float: "number",
    list: "array",
    dict: "object",
}


def _fallback_schema(run: Any) -> dict[str, Any]:
    """Derives a schema from bare annotations, for when pydantic is not installed.

    Worth doing properly rather than declaring everything a string: a ``bool`` advertised as
    a string means the model sends ``"true"`` and the tool receives the string ``"true"``,
    which is truthy for every value including ``"false"``. Silent, and wrong.
    """
    signature = inspect.signature(run)
    properties: dict[str, Any] = {}
    required: list[str] = []

    for name, parameter in signature.parameters.items():
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        annotation = parameter.annotation
        # A string annotation appears under `from __future__ import annotations`; resolving
        # it properly needs typing.get_type_hints, which can itself fail on a forward ref.
        if isinstance(annotation, str):
            annotation = {"str": str, "bool": bool, "int": int, "float": float}.get(annotation, inspect.Parameter.empty)
        properties[name] = {"type": _PRIMITIVE_TYPES.get(annotation, "string")}
        if parameter.default is parameter.empty:
            required.append(name)

    return {"type": "object", "properties": properties, "required": required}


def _schema_for(module: Any) -> dict[str, Any]:
    """Derives the parameter schema from ``run``'s type hints.

    pydantic when available, because it handles unions, defaults, nested models and
    ``Optional`` correctly. The fallback treats every parameter as a string, which is worse
    but still callable — better than refusing to register a tool because pydantic is missing.
    """
    run = module.run
    try:
        from pydantic import TypeAdapter

        schema = TypeAdapter(run).json_schema()
        properties = schema.get("properties", {})
    except Exception:  # noqa: BLE001 - any pydantic failure falls back rather than failing
        schema = _fallback_schema(run)
        properties = schema["properties"]

    doc = inspect.getdoc(run) or inspect.getdoc(module) or ""
    for name, description in _google_arg_docs(doc).items():
        if name in properties:
            properties[name]["description"] = description

    schema.setdefault("type", "object")
    schema["properties"] = properties
    return schema


def _describe(name: str, path: str) -> dict[str, Any]:
    module = _load(name, path)
    # The module docstring, not run's: it describes the tool, whereas run's docstring
    # usually documents the parameters.
    description = (inspect.getdoc(module) or inspect.getdoc(module.run) or "").strip()
    return {"name": name, "description": description, "schema": _schema_for(module)}


def _handle(request: dict[str, Any]) -> dict[str, Any]:
    method = request.get("method")
    params = request.get("params") or {}

    if method == "ping":
        return {"ok": True, "python": sys.version}

    if method == "describe":
        return _describe(params["name"], params["path"])

    if method == "validate":
        # Parsed before importing, so a syntax error is reported as one rather than as
        # whatever the import machinery happens to raise.
        source = Path(params["path"]).read_text(encoding="utf-8")
        compile(source, params["path"], "exec")
        return _describe(params["name"], params["path"])

    if method == "call":
        name = params["name"]
        # Recorded so a nested call can say *who* is asking. An approval prompt naming only the
        # callee is the prompt people click through.
        global _CURRENT_TOOL
        _CURRENT_TOOL = name
        module = _MODULES.get(name)
        if module is None:
            module = _load(name, params["path"])
        # Reloaded when the caller says the file changed, so an edit mid-session takes
        # effect without a restart.
        if params.get("reload"):
            module = _load(name, params["path"])

        captured = io.StringIO()
        with redirect_stdout(captured):
            result = module.run(**(params.get("arguments") or {}))
        printed = captured.getvalue()
        return {
            "result": result,
            # Returned rather than discarded: a print is how people debug, and swallowing it
            # makes a misbehaving tool impossible to diagnose from the chat.
            "stdout": printed,
        }

    raise ValueError(f"unknown method: {method}")


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        request_id = request.get("id")
        try:
            _respond({"id": request_id, "ok": True, "value": _handle(request)})
        except Exception as error:  # noqa: BLE001 - every failure goes back as a result
            # The traceback is the payload: §13 requires a failed tool to return it to the
            # model so it can fix its own code, rather than a one-line summary it cannot act on.
            _respond(
                {
                    "id": request_id,
                    "ok": False,
                    "error": f"{type(error).__name__}: {error}",
                    "traceback": traceback.format_exc(),
                }
            )


if __name__ == "__main__":
    main()
