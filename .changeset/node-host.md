---
'light-code-vscode': patch
---

Internal: the chat bridge moved from the extension into core, behind a `HostServices` seam,
so the new Node server (`npx light-code`) runs the same code. No behaviour change to the
extension — `apps/vscode` is now ~400 lines of activation, webview plumbing and three VS
Code-specific platform implementations.
