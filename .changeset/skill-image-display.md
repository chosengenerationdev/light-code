---
'light-code-vscode': minor
'@chosengeneration/light-code': minor
---

A skill's pictures can be seen in the Skills tab

The screenshots a skill carries are shown where you would go to check them: Settings → Skills, on
the skill itself. **Show** fetches one and renders it beneath the description.

**On demand, not with the list.** The skill list carries file names; the bytes cross the bridge only
when somebody opens one. Shipping every picture of every skill so a panel can print a row of names
would be megabytes for something most people never look at.

A `data:` URI rather than a path or a served file, because that is what the webview's policy allows
— the same route the diagrams take. Already-fetched pictures are held above the tab, so closing and
reopening Settings does not re-fetch what you just looked at.

Both halves of a request are checked against what is on disk rather than trusted: the name must be
a skill that exists, and the picture one that folder actually has. A name arriving in a message is
supplied text, and joining it into a path unchecked is how a request for a screenshot becomes a
request for a private key.

Note what this does *not* do: the picture is shown to **you**, not to the model. A tool result is
text, so a skill's screenshots never reach it — what reaches it is the description written beside
them, which is the whole reason that description is required to be prose.
