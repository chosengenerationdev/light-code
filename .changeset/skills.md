---
'light-code-vscode': minor
---

Teach it once and it keeps the note: skills.

Explain an internal library, a house convention, or a gotcha specific to your codebase, and
the model now offers to record it as a **skill** — a markdown file in
`.lightcode/skills/`. Next conversation it already knows, and when it later learns something
that contradicts a skill it offers to update that one rather than writing a near-duplicate.

**Only the one-line description enters the prompt.** Bodies are read on demand with the
ordinary `read_file`, so a skill costs a handful of tokens whether it is three lines or three
hundred — write as much detail as the subject deserves: package names, import paths,
signatures, a worked example.

It asks before writing, and the approval shows the exact markdown, because a skill is prose
the model injects into its own future context. They live in your workspace as plain files, so
they land in git and get reviewed like anything else.

Particularly useful with Python tools: describe your internal SDKs once, and tools it writes
afterwards use them properly instead of reaching for whatever it knows from training.
