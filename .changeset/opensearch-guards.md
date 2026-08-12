---
'light-code-vscode': patch
---

Guard rails so the model cannot run an expensive query against a production cluster.

It already could not change anything — the client has no write path — but a *read* can
still hurt. Every query now carries a per-shard timeout, an early-termination cap, and a
bounded hit count instead of an exact total that forces a full traversal. An unbounded
query against an index with a date field is limited to the last 24 hours, and the tool
result says so, so a document outside that window reads as a bounded search rather than
missing data.

A wildcard matching more than five indexes is refused with the count, and `*` or `_all` is
refused outright. The model's requested result count is a ceiling request, not a grant: the
connection's cap wins.

All five limits are editable per connection in Settings → Search, since only you know what
your cluster can take.
