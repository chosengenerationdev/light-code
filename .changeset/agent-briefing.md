---
'light-code-vscode': patch
---

Keep the specialist's colour when the consultation finishes, and tell it what exists

The consultation block wore the specialist's colour while it ran and reverted to
the expert's the moment it finished: the call and its result were built in two
places, and the second forgot the role. One builder now makes both.

Specialists are also told what this workspace has — the tools the assistant can
call and the skills written for it, by name. A specialist has no tools and cannot
discover any, so without that it advises as though the assistant were a bare
shell: proposing by hand what a configured tool already does, or inventing a
procedure an existing skill documents.
