---
'light-code-vscode': minor
---

Add MCP servers from a form instead of hand-writing JSON.

Settings → MCP now has **Add server**, with fields per server type rather than a raw
`mcpServers` blob:

- **Python (venv)** — point at your FastMCP script and press **Detect**. Light Code looks on
  disk for the interpreter, checking both `Scripts\python.exe` and `bin/python` regardless of
  platform, and searching `.venv`, `venv`, `env` and `.env` beside the script and one level
  up. What it finds lands in an ordinary editable **Python interpreter** field, so overriding
  it for a conda environment or a system Python is just typing over it. That field is what
  actually runs, so an unusual layout is never rewritten behind your back.
- **npm package** — the package name. `-y` is always passed, because without it `npx` waits
  on a confirmation prompt that nothing inside an extension host can answer, and the server
  appears to hang rather than to ask.
- **Command** and **HTTP** for anything else.

Environment variables and headers get key/value rows, with the `${secret:NAME}` reference
form spelled out inline. Arguments are one per line, so a path containing a space needs no
quoting. The exact command line that will be spawned is shown as you type — the same
ground-truth principle as the approval prompt.

The JSON editor is still there, now behind **Edit as JSON**, and the stored format is
unchanged: a config pasted from another MCP client still works, and yours still pastes out.
Servers can also be renamed and deleted from the list.
