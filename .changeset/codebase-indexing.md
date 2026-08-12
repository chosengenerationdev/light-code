---
'light-code-vscode': minor
---

Search your codebase by meaning, not just by exact text.

Settings → Search gains **Codebase indexing**: pick a provider profile to embed with, name
an embedding model and its vector width, and press **Index workspace**. The model then gets
a `search_codebase` tool that answers questions like "where do we decide to retry" when the
code actually says `shouldAttemptAgain` — the query ripgrep cannot serve.

It supplements `search_files`, it does not replace it. A vector search misses *silently*,
returning plausible neighbours rather than nothing, so both the tool description and every
result say the hits are approximate and must be read before being relied on.

**Indexing is the largest egress in the product, and the UI says so before you press the
button** — naming the embedding endpoint your code will be sent to and the index it lands
in. It only ever runs from that button; the model cannot start it.

What is never sent: anything gitignored, anything on the tool deny list, `.env`, lockfiles,
binaries, files over 1MB, and anything outside the indexable file types. The rule is that
anything `read_file` may not read must never be embedded, or indexing becomes a second route
around the deny list — with the payload going to a third party rather than staying local.

Reruns are incremental via a content-hash manifest, so only changed files are re-embedded.
Changing the model, its width or the chunk shape reindexes everything, because vectors from
two different models cannot be compared and mixing them silently produces confident nonsense.
