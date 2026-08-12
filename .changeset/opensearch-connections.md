---
'light-code-vscode': minor
---

Search OpenSearch indexes your organisation already runs.

Settings → Search takes multiple named connections, since different environments run
different clusters. Each has its own credentials, an optional default index, and its own
CA file or skip-verify setting for a cluster behind an intercepting proxy. Test Connection
reports the cluster name and version, and the index dropdown lists what is actually there —
with free-text entry always available, because `_cat/indices` is often denied to an account
that can still search perfectly well.

**Read-only, structurally.** The client the model uses exposes no write method at all, and
its one request helper refuses anything but `GET` and `POST` to `_search`. Nothing the model
does can create, change or delete anything in a cluster.

Search tools are offered only while a connection is active, so the tool set stays stable
within a session and search is off unless you turn it on.

Embedding-based codebase search is not in this release; this is the half that needs no
embedder and sends no source code anywhere.
