---
'light-code-vscode': patch
---

Support VS Code 1.84 and later, down from 1.102.

The floor was a policy choice — "roughly a year old" at the time it was set — not an API
requirement, and it was quietly excluding people who had not updated recently. The newest
API the extension touches is `SecretStorage` (1.53), so lowering it costs nothing. 1.84 is
the same floor Roo Code's final release used.

`@types/vscode` is pinned to match, which is what makes using a too-new API a compile error
rather than a runtime failure on someone else's machine.
