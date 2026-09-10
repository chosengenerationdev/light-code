---
"light-code-vscode": minor
"@chosengeneration/light-code": minor
---

Team-wide codebase search. Set a team index alias in Settings -> Search and everyone on the team
can search each other's indexed projects with search_codebase scope:"team", while still writing to
their own index. Results from someone else are marked as not being in your workspace, checked
against the disk rather than assumed, so the assistant does not try to open files that are not
there. An existing index can be attached to the alias without re-indexing.

Each kind of corpus can now go to a different vector store, so team code can live in a shared
cluster while other indexes stay local.

Fixed: opening an older conversation now scrolls to the newest message instead of the oldest, and
the reply follows as it streams unless you have scrolled up.

Fixed: create_python_tool was hidden behind the tool dispatcher, so asking for a tool sometimes
produced a plain .py file in the workspace root instead. It is always offered now.
