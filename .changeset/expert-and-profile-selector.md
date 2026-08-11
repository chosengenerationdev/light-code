---
'light-code-vscode': minor
---

Profile selector in the composer, a Claude CLI expert, and the assistant knows which model it is.

- **Switch provider from the chat.** A selector under the input shows the profile and model
  answering the next message, so changing it no longer means a trip to Settings.
- **Ask "what model are you?" and get the truth.** The system prompt now states the
  configured model and profile. Models otherwise answer from training data, which is wrong
  behind a gateway that renames things — and was wrong for a DeepSeek deployment during
  development.
- **Claude as a consulting expert** (Settings → Expert, off by default). Your everyday model
  can call `ask_expert` for planning a multi-file change, diagnosing a bug it has already
  failed to fix, or weighing two designs. Each consultation appears in the transcript with
  its cost.

  The expert is **read-only**: it can read and search the workspace to gather its own
  context, but cannot edit files or run commands. Everything that changes the workspace
  still goes through Light Code's tools and your approval. Any tool it asks for and is
  refused is reported alongside its answer rather than hidden.
