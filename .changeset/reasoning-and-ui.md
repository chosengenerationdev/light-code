---
'light-code-vscode': minor
---

See what the model is thinking, and tell expert-influenced work apart.

- **Reasoning traces are shown.** Where a provider exposes them — DeepSeek and Qwen's
  `reasoning_content`, Anthropic's `thinking`, Gemini's thought parts — they stream into a
  collapsed "Thinking…" block above the answer. They are never fed back as assistant
  content on the next turn.
- **Icons instead of repeated labels.** Assistant and user messages, tool status, and the
  provider list actions now use icons with the wording as a tooltip. Approve and Deny stay
  as words on purpose — a security decision should not depend on recognising a glyph.
- **Expert-influenced work is marked.** The consultation itself carries an expert icon, and
  so does anything the model did afterwards with that advice in context.
- **The composer is one aligned field.** The input and its buttons share a border and grow
  with the text instead of the input sitting at a fixed height beside taller buttons.
- **Dropdown popups follow the theme.** Every `<option>` is styled, so lists no longer open
  white against a dark editor.
- **The expert model is a dropdown** of tier aliases (Opus / Sonnet / Haiku), with free text
  still available for a specific id.
