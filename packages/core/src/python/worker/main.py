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


def _load(name: str, path: str) -> Any:
    """Imports a tool module from an explicit path, replacing any previous version."""
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
