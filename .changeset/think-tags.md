---
'light-code-vscode': patch
'@chosengeneration/light-code': patch
---

Qwen3's thinking no longer fills the context window

DeepSeek puts a reasoning trace in `reasoning_content` and several gateways use `reasoning`; both
were already routed to the reasoning channel. **Qwen3 does neither** unless whoever runs the server
switched a reasoning parser on — vLLM and SGLang need `--reasoning-parser` explicitly. Without it
the thinking arrives in `content`, wrapped in `<think>` tags, with no field to tell it from the
answer.

Untouched that costs three things, and the third is the expensive one: it is shown as the reply, it
is stored as assistant text, and it is therefore **re-sent on every later request for the rest of
the task**. A model with 32k of context spends a growing share of it re-reading its own discarded
reasoning — and the models that emit these tags are precisely the ones with the least room to
spare.

Tags are now split out of the content stream and sent to the reasoning channel, so they render as
a trace and never enter the conversation. A state machine rather than a regex, because a tag split
across two stream chunks — `<thi` then `nk>` — is ordinary, and a regex applied per chunk sees
neither half. Content that merely starts like a tag is passed straight through, and a stream cut
off mid-thought gives back what it was holding rather than dropping it.
