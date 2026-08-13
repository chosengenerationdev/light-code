---
'light-code-vscode': minor
---

The 25-step limit is now adjustable, and says what to do when it trips.

Settings → Approvals → **Maximum steps per message** (1–500, default 25). The limit exists so
a model looping on a failing edit stops costing money, not to cut short real work — so a long
refactor is a good reason to raise it.

Hitting it never loses anything, and the message now says so: the transcript is intact and
another message ("continue") carries on from where it stopped. Previously it read
"Stopped after reaching the maximum of 25 steps", which sounds like a crash.

CLAUDE.md has described this as configurable since the first phase. It was not; the loop
accepted the option and nothing ever passed it.
