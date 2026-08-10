---
'light-code-vscode': patch
---

Fixes from the first real corporate deployment.

- **Add a CA certificate to any profile.** Previously a CA could only be supplied inside
  the Apigee mutual-TLS block, so an ordinary API-key profile behind a TLS-intercepting
  proxy had no way to trust the gateway and simply could not connect. Settings → Providers →
  Edit → Connection security now takes a CA file path for every auth type.
- **"Skip certificate verification"**, per profile and off by default, for when exporting
  the internal root is not practical. The UI states plainly that this lets anyone on the
  path read and modify the traffic, including the API key. Supplying the CA is the fix.
- **Qwen and Gemma are now recognised**, including gateway-renamed ids like
  `internal-qwen3-coder-480b`. Token counts for those models were falling back to a
  conservative 32k guess and were wrong.
- **Context window, image support, and tool support are editable inline** under the model
  field. They were always overridable, but buried behind a disclosure inside Advanced where
  nobody found them.
- **Pasting a screenshot works.** It silently did nothing whenever the model was not
  recognised as vision-capable — which is most models behind a gateway, since the id is
  renamed. The attach button is always offered now, and an unrecognised model gets a note
  pointing at the override instead of silence.
- **The model list loads by itself** once the base URL and credential are set, rather than
  waiting for the Refresh button. It fires on blur, never mid-typing, so a partly-typed URL
  never receives your API key.
