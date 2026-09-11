---
'light-code-vscode': patch
---

Fix an Agents tab that showed nothing

The tab rendered its empty starting state and nothing ever replaced it: no roles
to assign, providers reported as not configured when they were, and Claude
reported as absent on machines where it is installed. Three symptoms, one cause —
nothing ever asked the host for the tab's state.

Claude is also detected for the tab now whether or not the old expert feature was
ever switched on. Detection used to run only when that flag was set, which was
right while the expert was the whole feature and wrong once Agents offered Claude
as one choice among several.

Adding or removing a provider refreshes the pickers, and detection pushes its
answer when it finishes rather than only when asked — the panel asks on mount,
which is before any probe has replied.
