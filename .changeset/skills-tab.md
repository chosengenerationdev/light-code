---
'light-code-vscode': minor
---

See and manage skills in Settings → Skills.

Skills shipped with no way to view them: the only way to know what the assistant had been told
to remember was to browse `.lightcode/skills/` yourself. The tab now lists each one with its
description and file, and lets you delete any of them.

It also surfaces skills that were **not** loaded — a file missing a `description` is skipped,
because without one the model has nothing to decide on, and previously that was a log line
nobody saw.
