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
import os
import re
import sys
import time
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


# --- running in somebody's live Jupyter kernel ---------------------------------------------
#
# Requested so that a notebook can drive Light Code and have its tools see the session's own
# state - the dataframe that is already loaded, the model that took ten minutes to fit.
#
# ## Why the kernel is named to us rather than discovered by us
#
# A kernel knows its own connection file (``ipykernel.get_connection_file()``); nothing outside
# it does. From another process all you can do is list ``<runtime-dir>/kernel-*.json`` and
# guess, and with more than one kernel running - the ordinary case for anybody who uses
# Jupyter - a guess means running somebody's tool inside the wrong notebook. That is the same
# refusal the Excel tools make about attaching: answering "the session I have open" with a
# different one is worse than asking.
#
# So the connection file arrives in ``LIGHT_CODE_JUPYTER_CONNECTION_FILE``, and the host has a
# discovery helper that only ever *offers* candidates.
#
# ## Why the result comes back behind a marker
#
# The same reason the identity and credential wrappers do it (CLAUDE.md section 14): a kernel
# is full of libraries that print. Licence banners, deprecation warnings and progress bars all
# arrive on the same channel as the answer, and reading "the output" would hand back a log line
# while looking like it had worked.

_KERNEL_MARKER = "__LIGHT_CODE_RESULT__"
_kernel_client: Any = None


def _kernel_connection_file() -> str:
    return (os.environ.get("LIGHT_CODE_JUPYTER_CONNECTION_FILE") or "").strip()


def _kernel() -> Any:
    """The client for the configured kernel, connected once and kept.

    Reconnecting per call would pay the handshake every time and, worse, would lose the
    channel's message ordering guarantees mid-conversation.
    """
    global _kernel_client
    if _kernel_client is not None:
        return _kernel_client

    connection_file = _kernel_connection_file()
    if not connection_file:
        raise RuntimeError("no Jupyter kernel is configured for this session")
    if not Path(connection_file).exists():
        raise RuntimeError(
            f"the kernel connection file is gone: {connection_file}. The kernel it described "
            "has probably been shut down or restarted - restart the notebook's Light Code "
            "session so it picks up the new one."
        )

    try:
        from jupyter_client import BlockingKernelClient
    except ImportError as error:
        raise RuntimeError(
            "running tools in a Jupyter kernel needs jupyter_client, which is not importable "
            "from this interpreter. It ships with Jupyter, so install it into the same "
            "environment the kernel runs in: pip install jupyter_client"
        ) from error

    client = BlockingKernelClient()
    client.load_connection_file(connection_file)
    client.start_channels()
    try:
        # Proves the kernel is actually there before any tool is run. Without it the first
        # failure is a silent timeout in the middle of somebody's tool, which reads as the tool
        # hanging rather than as the kernel being gone.
        client.wait_for_ready(timeout=20)
    except RuntimeError as error:
        client.stop_channels()
        raise RuntimeError(
            f"connected to the kernel described by {connection_file} but it never became "
            "ready. It may be busy running a cell, or it may have died."
        ) from error

    _kernel_client = client
    # Sent here, on the one path that produces a connected client.
    #
    # The first version defined `_kernel_preamble` and never called it, so every tool call
    # arrived at a kernel that had never heard of `_lc_json` and failed with a NameError on
    # line 1. Nothing in the TypeScript, the schema or the wiring was wrong, and no test of
    # any of them could have seen it - it took starting a real kernel and asking it. That is
    # the same shape as `s3.tools` shipping with nothing on the other end.
    _kernel_run(client, _kernel_preamble(), timeout=30)
    return client


def _kernel_preamble() -> str:
    """Code run in the kernel before any tool is, exactly once.

    Everything it defines is prefixed and kept in one dict, because this is *somebody's
    notebook*: a bare ``json`` or ``run`` left in their globals would shadow their own name and
    break a cell they wrote, a long way from anything they would connect to us.

    ## It also installs ``light_code`` in the kernel, and that is not optional

    A tool written against ``light_code.call_tool`` imports that module. The worker registers
    it in *its own* ``sys.modules``, which the kernel has never heard of - so without this,
    moving a tool into a kernel turns a working tool into an ImportError whose message points
    at the tool rather than at the move. Found by running it, not by reading it.

    ``call_tool`` raises there rather than working, and says why: the callback rides on this
    worker's stdio and the kernel has no route back to the host. An honest refusal beats a
    name that exists and hangs.

    ``session`` is the point of the whole feature - it *is* the notebook's namespace, so a
    tool can read the dataframe that is already loaded.
    """
    return (
        "import json as _lc_json, io as _lc_io, pathlib as _lc_path, sys as _lc_sys, "
        "types as _lc_types, traceback as _lc_tb\n"
        "from contextlib import redirect_stdout as _lc_redirect\n"
        "_lc_tools = globals().setdefault('_lc_tools', {})\n"
        "if 'light_code' not in _lc_sys.modules:\n"
        "    _lc_helper = _lc_types.ModuleType('light_code')\n"
        "    _lc_helper.session = globals()\n"
        "    class _LcToolError(RuntimeError):\n"
        "        pass\n"
        "    def _lc_no_call(*_a, **_k):\n"
        "        raise _LcToolError('call_tool is not available to a tool running inside "
        "a Jupyter kernel: the callback channel belongs to the Light Code worker, and the "
        "kernel has no route back to the host.')\n"
        "    _lc_helper.call_tool = _lc_no_call\n"
        "    _lc_helper.ToolError = _LcToolError\n"
        "    _lc_sys.modules['light_code'] = _lc_helper\n"
    )


def _kernel_call_code(name: str, path: str, arguments: dict[str, Any], reload: bool) -> str:
    """The code sent to the kernel for one tool call.

    The tool's source is executed **in the kernel**, so its imports resolve against the
    kernel's environment and its ``run`` sees the kernel's globals if it asks for them. The
    module is cached there between calls, and reloaded on the same signal the local path uses.
    """
    payload = json.dumps(
        {"name": name, "path": path, "arguments": arguments, "reload": bool(reload)}
    )
    # A single JSON literal rather than interpolated values: every one of these is
    # model-supplied, and building source by concatenation is how a quote in an argument
    # becomes a syntax error at best (CLAUDE.md section 16's rule, applied to code rather than
    # to a command line).
    return (
        f"_lc_req = _lc_json.loads({payload!r})\n"
        "_lc_out = _lc_io.StringIO()\n"
        "try:\n"
        "    if _lc_req['reload'] or _lc_req['name'] not in _lc_tools:\n"
        "        _lc_mod = _lc_types.ModuleType('light_code_tool_' + _lc_req['name'])\n"
        "        _lc_mod.__file__ = _lc_req['path']\n"
        # The notebook's own namespace, as a module-level name, so the simplest possible
        # tool - `session['df']` - needs no import at all. This is the whole feature.
        "        _lc_mod.session = globals()\n"
        "        _lc_src = _lc_path.Path(_lc_req['path']).read_text(encoding='utf-8')\n"
        "        with _lc_redirect(_lc_out):\n"
        "            exec(compile(_lc_src, _lc_req['path'], 'exec'), _lc_mod.__dict__)\n"
        "        if not hasattr(_lc_mod, 'run'):\n"
        "            raise AttributeError(_lc_req['path'] + ' defines no `run` function')\n"
        "        _lc_tools[_lc_req['name']] = _lc_mod\n"
        "    with _lc_redirect(_lc_out):\n"
        "        _lc_value = _lc_tools[_lc_req['name']].run(**_lc_req['arguments'])\n"
        "    try:\n"
        "        _lc_json.dumps(_lc_value)\n"
        "        _lc_payload = {'ok': True, 'result': _lc_value, "
        "'stdout': _lc_out.getvalue()}\n"
        "    except TypeError:\n"
        # A DataFrame, a model, a connection - returned rather than refused. `repr` is what a
        # notebook would have shown, and losing the answer because it does not serialise would
        # be the worst outcome of a feature whose point is reaching live objects.
        "        _lc_payload = {'ok': True, 'result': repr(_lc_value), 'repr': True, "
        "'stdout': _lc_out.getvalue()}\n"
        "except Exception as _lc_err:\n"
        "    _lc_payload = {'ok': False, 'error': type(_lc_err).__name__ + ': ' + str(_lc_err), "
        "'traceback': _lc_tb.format_exc(), 'stdout': _lc_out.getvalue()}\n"
        f"print({_KERNEL_MARKER!r} + _lc_json.dumps(_lc_payload))\n"
    )


def _kernel_execute(code: str, timeout: float) -> dict[str, Any]:
    """Runs code in the kernel and reads back the marked result.

    Output that is not the marker is the kernel's own chatter and is kept separately, so a
    library's banner is never mistaken for the answer.
    """
    return _kernel_run(_kernel(), code, timeout)


def _kernel_run(client: Any, code: str, timeout: float) -> dict[str, Any]:
    """The same, against a client already in hand.

    Split out so the preamble can be sent from inside ``_kernel`` - going through
    ``_kernel_execute`` there would call back into ``_kernel`` before it had returned.
    """
    msg_id = client.execute(code, store_history=False)

    answer: dict[str, Any] | None = None
    chatter: list[str] = []
    deadline = time.monotonic() + timeout

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(
                "the kernel did not answer in time. It is probably busy running a cell - a "
                "kernel runs one thing at a time, so a tool waits for whatever is already going."
            )
        try:
            message = client.get_iopub_msg(timeout=min(remaining, 1.0))
        except Exception:  # noqa: BLE001 - an empty queue is the ordinary case, so poll again
            continue

        if message.get("parent_header", {}).get("msg_id") != msg_id:
            # Somebody else's cell. Ignored rather than read: this is a shared kernel and the
            # user is still using it.
            continue

        kind = message.get("msg_type")
        content = message.get("content", {})
        if kind == "stream":
            for line in content.get("text", "").splitlines():
                if line.startswith(_KERNEL_MARKER):
                    answer = json.loads(line[len(_KERNEL_MARKER):])
                else:
                    chatter.append(line)
        elif kind == "error":
            # Raised *before* the tool's own code could print the marker: a bad compile, or the
            # kernel dying. The tool's own exceptions come back inside the payload instead.
            raise RuntimeError(
                "the kernel refused the call: " + "\n".join(content.get("traceback", []))
            )
        elif kind == "status" and content.get("execution_state") == "idle":
            break

    if answer is None:
        if _KERNEL_MARKER not in code:
            # Setup rather than a call: it is not meant to print anything.
            return {}
        raise RuntimeError(
            "the kernel finished without returning a result. If it was restarted mid-call, "
            "reconnect the notebook's Light Code session."
        )
    if chatter:
        answer["stdout"] = (answer.get("stdout") or "") + "\n".join(chatter)
    return answer


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
        connection_file = _kernel_connection_file()
        # Reported rather than merely configured, so the Python tab can say *which* kernel
        # tools run in. "It is using my notebook" is not something anybody should have to
        # infer from a tool seeing a variable it should not have.
        return {
            "ok": True,
            "python": sys.version,
            **({"jupyterConnectionFile": connection_file} if connection_file else {}),
        }

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

        if _kernel_connection_file():
            """Run it where the user's own session is.

            The whole call goes over, source and all, so the tool's imports resolve against
            the kernel's environment rather than this one - which is the point: the notebook
            has the libraries and the loaded data, and this process has neither.

            The registry is unchanged by this. A tool still had to be approved here, with its
            source shown, before it could ever be called - so running it elsewhere widens
            where the code runs and not who may run it.
            """
            answer = _kernel_execute(
                _kernel_call_code(
                    name,
                    params["path"],
                    params.get("arguments") or {},
                    bool(params.get("reload")),
                ),
                # Generous, and bounded anyway by the host's own per-tool timeout. A kernel
                # runs one thing at a time, so a tool legitimately waits behind whatever cell
                # the user just ran.
                timeout=float(params.get("timeoutSeconds") or 600),
            )
            if not answer.get("ok"):
                # Re-raised rather than returned, so it reaches the model as a failure with a
                # traceback exactly as a local one does. Section 13 wants the traceback: it is
                # what lets the model fix its own code.
                error = RuntimeError(answer.get("error") or "the tool failed in the kernel")
                error.kernel_traceback = answer.get("traceback")  # type: ignore[attr-defined]
                raise error
            return {
                "result": answer.get("result"),
                "stdout": answer.get("stdout") or "",
                "ranInKernel": True,
                # Said out loud when the value could not be JSON, so nobody reads a repr as
                # the structure it is a picture of.
                **({"resultIsRepr": True} if answer.get("repr") else {}),
            }

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
                    # The kernel's own traceback when the failure happened there. Ours would
                    # be a stack through this file, which says nothing about the tool and is
                    # the one thing section 13 wants the model to be able to act on.
                    "traceback": getattr(error, "kernel_traceback", None)
                    or traceback.format_exc(),
                }
            )


if __name__ == "__main__":
    main()
