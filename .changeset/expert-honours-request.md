---
'light-code-vscode': patch
---

Asking the model to consult Claude now actually consults Claude.

With the expert enabled, "can you say hello to Claude?" got "I don't have a way to
communicate with other AI assistants" — the tool was available and offered, but the
guidance to spend sparingly had talked the model out of a direct instruction, and it
reported that choice as an inability.

An explicit request now overrides the frugality rules: it is your money and your decision.
If the model does decide against consulting on its own initiative, it has to say it chose
not to and why, rather than claiming it cannot.

The `expert` badge in the composer also no longer hides itself when no provider profile has
loaded, so whether the expert is live is visible without opening Settings.
