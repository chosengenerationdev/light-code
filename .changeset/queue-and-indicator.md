---
'light-code-vscode': minor
---

Queue messages mid-turn, and a working indicator.

- **Type while it works.** Sending during a turn queues the message instead of being
  refused. The queue is visible above the input and each entry can be removed before it is
  used. The model picks them up at the next step boundary, so it sees them while still
  working rather than after it has finished.
- **A working indicator.** Animated, with elapsed seconds once a reply takes more than a
  few, and it names what is happening — "Thinking" versus "Running search_files". It gets
  out of the way as soon as text starts streaming, since the words are their own evidence
  of progress.

Also fixes two latent provider bugs the queue exposed: a user message following a tool
result, or two user messages in a row, produced consecutive user turns that Anthropic and
Gemini both reject. Both adapters now merge them.
