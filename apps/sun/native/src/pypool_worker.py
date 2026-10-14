"""One worker of fire-fs's Python process pool (pypool.rs).

Each worker is its own process, so its own interpreter and its own GIL: the pool runs calls truly in
parallel however much of the library holds the GIL. The library is imported once per worker.

Protocol: one JSON line in to set up, one JSON line back ({"ready": ...}); then one JSON request per
line, one JSON answer per line. Answers go to a private copy of stdout; file descriptor 1 itself is
pointed at stderr, so anything the library prints - from Python or from C - cannot corrupt the stream.
"""
import importlib
import inspect
import json
import os
import pkgutil
import sys
import time
import traceback

_out = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr


def send(obj):
    _out.write(json.dumps(obj, default=str) + "\n")
    _out.flush()


def plain(value, depth=0):
    """A value as JSON: containers recursively, numpy/pandas by their own conversions, else repr."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if value == value and value not in (float("inf"), float("-inf")) else repr(value)
    if depth > 8:
        return repr(value)
    if isinstance(value, (list, tuple, set, frozenset)):
        return [plain(v, depth + 1) for v in value]
    if isinstance(value, dict):
        return {str(k): plain(v, depth + 1) for k, v in value.items()}
    kind = type(value).__name__
    if kind == "DataFrame" and hasattr(value, "to_dict"):
        try:
            return {"__type__": "DataFrame", **plain(value.to_dict(orient="split"), depth + 1)}
        except Exception:
            pass
    if hasattr(value, "tolist"):
        try:
            return plain(value.tolist(), depth + 1)
        except Exception:
            pass
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    if hasattr(value, "to_dict"):
        try:
            return plain(value.to_dict(), depth + 1)
        except Exception:
            pass
    if hasattr(value, "__dict__") and not callable(value):
        fields = {k: plain(v, depth + 1) for k, v in vars(value).items() if not k.startswith("_")}
        if fields:
            return {"__type__": kind, **fields}
    return repr(value)


def signature_of(obj):
    try:
        return str(inspect.signature(obj))
    except (TypeError, ValueError):
        # A compiled (pybind11, Cython, SWIG) function often has no signature object, but its
        # docstring starts with one.
        doc = (getattr(obj, "__doc__", None) or "").strip().splitlines()
        return doc[0] if doc else "(...)"


def first_line(obj):
    doc = inspect.getdoc(obj) or ""
    for line in doc.splitlines():
        if line.strip():
            return line.strip()[:200]
    return ""


def members(module, text):
    out = []
    for name, obj in inspect.getmembers(module):
        if name.startswith("_"):
            continue
        if text and text.lower() not in name.lower():
            continue
        if inspect.ismodule(obj):
            out.append({"name": name, "kind": "module"})
        elif inspect.isclass(obj):
            out.append({"name": name, "kind": "class", "signature": signature_of(obj), "doc": first_line(obj)})
        elif callable(obj):
            out.append({"name": name, "kind": "function", "signature": signature_of(obj), "doc": first_line(obj)})
        if len(out) >= 1000:
            break
    # Submodules of a package that have not been imported yet, named without importing them.
    if hasattr(module, "__path__"):
        known = {m["name"] for m in out}
        for info in pkgutil.iter_modules(module.__path__):
            if info.name not in known and not info.name.startswith("_") and (not text or text.lower() in info.name.lower()):
                out.append({"name": info.name, "kind": "module"})
    return out


def describe(module, path):
    obj = resolve(module, path)
    found = {"name": path, "signature": signature_of(obj), "doc": (inspect.getdoc(obj) or "")[:6000]}
    if inspect.isclass(obj):
        found["methods"] = [
            {"name": n, "signature": signature_of(m), "doc": first_line(m)}
            for n, m in inspect.getmembers(obj)
            if not n.startswith("_") and callable(m)
        ][:300]
    return found


def resolve(module, path):
    obj = module
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


def main():
    setup = json.loads(sys.stdin.readline())
    for folder in setup.get("paths", []):
        if folder not in sys.path:
            sys.path.insert(0, folder)
        # Python 3.8+ no longer searches PATH for a module's DLL dependencies; this is how the folder
        # holding the quants' DLLs is made visible to their .pyd files.
        try:
            os.add_dll_directory(folder)
        except (AttributeError, OSError):
            pass
        os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")
    started = time.perf_counter()
    try:
        module = importlib.import_module(setup["module"])
    except BaseException:
        send({"ready": False, "error": traceback.format_exc(limit=8)})
        return
    function = None
    if setup.get("function"):
        try:
            function = resolve(module, setup["function"])
        except AttributeError:
            send({"ready": False, "error": "%s has no %s" % (setup["module"], setup["function"])})
            return
        if not callable(function):
            send({"ready": False, "error": "%s.%s is not callable" % (setup["module"], setup["function"])})
            return
    send({"ready": True, "importMs": int((time.perf_counter() - started) * 1000), "python": sys.version.split()[0]})
    for line in sys.stdin:
        request = json.loads(line)
        if "list" in request:
            send({"members": members(module, request.get("list") or "")})
            continue
        if "describe" in request:
            try:
                send({"described": describe(module, request["describe"])})
            except BaseException as error:
                send({"error": "%s: %s" % (type(error).__name__, error)})
            continue
        began = time.perf_counter()
        try:
            value = function(*request.get("args", []), **request.get("kwargs", {}))
            send({"i": request["i"], "ok": True, "value": plain(value), "ms": round((time.perf_counter() - began) * 1000, 3)})
        except BaseException as error:
            send({
                "i": request["i"], "ok": False, "error": "%s: %s" % (type(error).__name__, error),
                "trace": traceback.format_exc(limit=6)[-2000:], "ms": round((time.perf_counter() - began) * 1000, 3),
            })


main()
