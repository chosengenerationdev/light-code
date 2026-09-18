---
'light-code-vscode': patch
'@chosengeneration/light-code': patch
---

Choosing Claude's colour no longer says "There is no claude role"

Reported immediately after the colour shipped. The picker was there and the save refused it — a
control that exists and cannot work, which is worse than one that is missing.

**Colourable and assignable are not the same question**, and one guard was answering both. A colour
marks *authorship* and belongs to anything that can author a reply; a role is a *seat* a model can
be put in. Claude is the first thing that is one without being the other, and the colour handler
was asking about seats.

Only that handler changed. The four that configure a role still refuse anything that is not one —
a "claude" role would be assignable and mean nothing, since nothing consults it.
