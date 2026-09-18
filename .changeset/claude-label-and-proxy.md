---
'light-code-vscode': minor
'@chosengeneration/light-code': minor
---

Claude is named and coloured as Claude, and the extension honours your proxy

**"Informed by expert" now says "informed by claude"** when the Claude command line answered.
`consultationFromToolCall` returned the *seat* rather than the answerer, which was right when there
was one expert and is not any more: the expert seat can be held by a configured provider, reached
through `ask_agent`, and a reply from that was labelled identically to one from Claude.

`ask_claude` and the legacy `ask_expert` are the command line and nothing else — the tool is only
registered when the CLI is runnable — so this is the one case where the answerer is known by name.
Old stored transcripts relabel with it, correctly, because those calls were the CLI too.

**And Claude has its own colour.** It shared the expert's coral, so a consultation answered by
Claude and one answered by a configured profile were painted the same — which is exactly what this
colour family exists to prevent, since it marks authorship. Configurable like every other, in
Appearance.

**The extension now honours `HTTPS_PROXY`.** It was constructing its HTTP client with no proxy
support at all, so on a corporate network anything not reachable directly failed — reported against
S3 as "the host could not be resolved", from a machine where nothing external resolves without the
proxy. The Node host has had this since it was written; the extension simply never did.

Not a widening: `proxyForUrl` returns nothing for loopback and obeys `NO_PROXY`. If you have
`HTTPS_PROXY` set and an internal gateway that should be reached directly, list it in `NO_PROXY` —
the same variable every other tool on that machine already needs.
