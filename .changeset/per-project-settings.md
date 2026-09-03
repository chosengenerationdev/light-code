---
'light-code-vscode': minor
'@chosengeneration/light-code': minor
---

Settings can differ per project, without a repository being able to set them.

Opening a second codebase on one machine meant it shared the first one's vector store, model,
Python environment and read roots. Those are user-scope-only under invariant 5 — but that rule is
about **who writes a value**, not about whether it may vary by project. `approvals` has always
made exactly that split: scoped per workspace, stored user-side, keyed by path. This generalises
it.

A project may now differ on: which model answers, which model writes tool source, which vector
store it indexes into, its mode, its step cap, its documentation index, its embedder index name,
its Python paths, its read roots and `@` exclusions, and its skill folders. Everything else —
provider list, credentials, TLS, the Office toggles, the expert — stays machine-wide, deliberately,
and the list is an allow list so a key added later defaults to global rather than silently gaining
a dimension nobody designed.

**Schedules are now bound to the project they were written in.** They were a single global list,
so a schedule written against one codebase fired against whichever happened to be open — running
its prompt, with its granted tools, against the wrong repository. For a schedule granted editing
that is not a scoping gap but a hazard. Schedules written before this keep firing anywhere, since
silently binding them to whatever was open at upgrade time would have stopped them with no
explanation.
