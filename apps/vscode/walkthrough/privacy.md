## What it does not do

- **No telemetry, ever.** No update checks, no analytics, no remote assets. Nothing is phoned
  home, at any point, for any reason.
- **No default endpoints.** A fresh install contacts nothing. The only hosts it ever reaches are
  the ones you configured: your model gateway, your MCP servers, and — only if you enable
  indexing — your vector store and embedding endpoint.
- **No cloud account, no sign-in, no hosted component.**

**Worth being clear about two things**

*Indexing is the largest egress in the product.* Enabling it sends the contents of your
workspace to the embedding endpoint you configured. It is opt-in, ships disabled, and confirms
the destination the first time.

*Nothing is sandboxed.* Shell commands, MCP servers, Python tools and the Claude CLI run with
your full privileges, exactly as if you had typed them yourself. That is the same trust model as
your own terminal — and it is why the approval prompt shows you the literal command.

Secrets go to the OS keychain and are never written to the config file, never included in an
export, and never in logs.
