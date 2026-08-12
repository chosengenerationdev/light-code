---
'light-code-vscode': patch
---

Fix "Save embedder" appearing to do nothing, and list the provider's models.

**Save embedder gave no sign it had worked.** The form resynced to the values it had just
sent, so a successful save looked identical to no save at all — and when a field was
incomplete the button was simply disabled, which looks identical to a broken one. The host
now confirms the write, the button shows "Saved.", and a disabled button names the field
that is missing rather than staying silent.

**The embedding model is now a dropdown.** Choosing a provider fetches its catalogue
immediately, using the profile's stored credentials and TLS. Free-text entry stays, always:
a gateway that publishes no catalogue — or publishes one that omits its embedding models —
is common, so the list is a convenience layered over the field rather than a gate in front
of it. When there is no catalogue, the reason is shown next to the field.
