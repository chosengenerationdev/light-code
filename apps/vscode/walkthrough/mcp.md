## Connect the servers you already run

**Settings → MCP** connects Model Context Protocol servers over stdio or HTTP. Paste a config
from another client unchanged — the format is the standard `mcpServers` shape.

Once connected, their tools are ordinary tools: same approval prompt, same mode filtering, no
special cases anywhere.

- Every tool is **namespaced** (`filesystem__read_file`), because collisions between servers
  are inevitable.
- Each server has an enable toggle, and each tool has **Always / Ask / Never** — a single
  server can expose forty tools and they all cost prompt space.
- Health, restart and the server's own error output are on the tab, so a mistyped command is
  visible immediately rather than the first time something tries to use it.
- Secrets are `${secret:NAME}` references resolved from secure storage, never written into
  the config file.

A server started with `npx` fetches from the network when the panel opens — the tab says so.
