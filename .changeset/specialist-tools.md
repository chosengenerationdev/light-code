---
'light-code-vscode': minor
'@chosengeneration/light-code': minor
---

Specialists are told the truth about what they can do, and tool access is per role

A correction first. Every specialist's preamble opened with "You cannot see the workspace and
cannot read files, run commands or search". That was true when a consultation was a single
request, and false from the moment `agents/consult.ts` gave provider-backed specialists the read
tool group and the CLI expert its own Read/Grep/Glob. The sentence stayed.

So the **librarian** — whose entire job is what has been written down in this workspace — was
being told it could not go and read any of it, and answered from whatever happened to be pasted
into the question. It is the weakest of the five roles for exactly that reason, and the reason was
a stale sentence. Worse, the fix written earlier for a misallocated librarian step asserted the
same falsehood to the expert, telling it not to allocate the librarian the one kind of work it is
equipped for.

Tool access is now a per-role flag. On for the **expert** (planning spans files nobody can paste),
the **reviewer** (most of what a review turns on is around the diff) and the **librarian**
(definitionally). Off for the **programmer**, handed a spec and asked to write, and the **tester**,
reasoning about the change in front of it — for those a lookup budget buys a slower answer that is
no better. An assignment can override the role's default, because it depends on who is answering.

Read-only remains absolute: no specialist can edit or run anything, which is §12b's line and the
whole security story in `consult.ts`.

The preamble is also appended when a consultation is assembled rather than stored inside each
prompt, so editing a role — or writing one from scratch — can no longer delete the sentences that
say what it may and may not do.
