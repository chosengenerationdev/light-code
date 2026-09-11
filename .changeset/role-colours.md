---
'light-code-vscode': patch
---

Colour a consultation by the specialist who answered it

An `ask_agent` result was not recognised as a consultation at all, so it rendered
in no colour — only the older `ask_expert` was. Now the block takes the colour of
whichever role answered: the reviewer's answer is the reviewer's colour, the
tester's is the tester's.

A call whose role cannot be read is attributed to nobody rather than to the
expert. The colour exists to say who spoke, and saying Claude answered when
something else did is worse than saying nothing.

The Appearance tab also showed two Expert colour pickers, backed by two different
settings. The one that has always owned it stays, and the roles listed beside it
are the others.
