# Manual verification

Things that automated tests cannot reach: the approval prompt, the webview, and behaviour
against live provider endpoints. **Work through this before any release.**

Checks are ordered by consequence, not by phase. Session A first — those are security
properties where "it looked fine" is not evidence. Everything after that is functionality.

Each check states what must happen. If something does not match, stop and record it rather
than working around it; a surprise here is worth more than a passing tick.

---

## Setup (once)

1. **Build and launch.** From the repo root:
   ```
   pnpm build
   ```
   Then press <kbd>F5</kbd> in VS Code. A second window opens — the Extension Development
   Host. Everything below happens in *that* window.

2. **Create the fixture workspace.** In the repo root:
   ```
   node scripts/make-verification-workspace.mjs
   ```
   It prints a path under your temp directory. **Open that folder** in the Extension
   Development Host (`File → Open Folder`). It contains known files, a `.gitignore`, and a
   planted fake secret, which several checks below depend on.

3. **Open the panel.** Click the Light Code icon in the Activity Bar.

4. **Keep two things visible** while you work:
   - `View → Output`, then pick **Light Code** in the dropdown. Host-side logs land here.
   - The webview's own console, for UI errors:
     `Ctrl+Shift+P → Developer: Open Webview Developer Tools`.

5. **Optional — start from clean state.** Some checks read more clearly with no prior
   history or allowances. To reset (this deletes saved conversations, not your config):
   ```powershell
   $s = "$env:APPDATA\Code\User\globalStorage\chosengeneration.light-code-vscode"
   Remove-Item -Recurse -Force "$s\tasks","$s\tool-results" -ErrorAction SilentlyContinue
   ```
   Allowances live in `config.json` under `approvals`, keyed by workspace path — clear that
   key rather than the whole file, or you will lose your provider profiles.

**Where things are stored,** for the checks that inspect disk:

| What | Path |
|---|---|
| Config | `%APPDATA%\Code\User\globalStorage\chosengeneration.light-code-vscode\config.json` |
| Task transcripts | `…\chosengeneration.light-code-vscode\tasks\` |
| Spilled tool results | `…\chosengeneration.light-code-vscode\tool-results\` |
| Secrets | VS Code `SecretStorage` — **not** a file you can read |

---

## Session A — Security properties (~20 min)

These are the ones that matter most. A pass here is a real result; a failure is a blocker.

### A1. Deny actually blocks execution

- [ ] Ask: `create a file called denied.txt containing hello`
- [ ] When the approval prompt appears, click **Deny**.

**Must happen:** `denied.txt` does **not** exist. The model is told permission was refused
and gets another turn — the conversation continues rather than stopping dead.

### A2. The approval prompt shows ground truth, not the model's description

- [ ] Ask: `run the command: node --version`

**Must happen:** the prompt shows the literal string `node --version`. Not a paraphrase,
not "check the node version".

- [ ] Ask: `add a line saying // verified to the top of src/math.ts`

**Must happen:** the prompt shows a computed **diff** with the real surrounding lines from
the file — not the model's summary of its intended change. Approve it and confirm the file
matches what the diff showed.

### A3. Command "always allow" is exact-match — the sharpest check here

- [ ] Ask: `run the command: node --version`
- [ ] In the prompt, click **Always allow this command**.
- [ ] Ask again: `run the command: node --version`

**Must happen:** no prompt the second time.

- [ ] Now ask: `run the command: node --version && echo pwned`

**Must happen:** **it prompts.** If this auto-approves, stop — that is the exact hazard §8's
exact-match rule exists to prevent, and it is a release blocker.

Repeat with each of these; **every one must still prompt**:

- [ ] `npm  test` (two spaces) after allowing `npm test`
- [ ] ` node --version` (leading space)
- [ ] `NODE --VERSION` (different case)

### A4. Revoking an allowance works

- [ ] Settings (gear) → **Approvals** tab.
- [ ] Confirm `node --version` is listed under allowed commands. Click **Revoke**.
- [ ] Ask: `run the command: node --version`

**Must happen:** it prompts again.

### A5. Ask mode cannot edit or run commands

- [ ] Set the mode selector in the chat header to **Ask**.
- [ ] Ask: `create a file called should-not-exist.txt`

**Must happen:** the model says it cannot — it should not even attempt the tool, because
edit tools are withheld from the prompt entirely. `should-not-exist.txt` does not exist.

- [ ] Ask: `read src/math.ts and tell me what it does`

**Must happen:** this works. Ask mode is read-only, not disabled.

- [ ] Switch back to **Code** mode.

### A6. Nothing secret-shaped reaches disk

- [ ] Ask: `read secrets/fake-credentials.env and summarise it`
- [ ] Approve the read. Let the turn finish.
- [ ] Now search the stored transcripts:
  ```powershell
  Select-String -Path "$env:APPDATA\Code\User\globalStorage\chosengeneration.light-code-vscode\tasks\*.json" -Pattern "corp-gateway-key","sk-","Bearer "
  Select-String -Path "$env:APPDATA\Code\User\globalStorage\chosengeneration.light-code-vscode\tool-results\*.txt" -Pattern "corp-gateway-key","sk-","Bearer "
  ```

**Must happen:** no matches in either directory. `[REDACTED]` in place of the values is the
expected result.

### A7. Certificate paths are unreadable by tools

Only if you have `certDir` configured. Skip otherwise.

- [ ] Ask the model to read a file inside your configured `certDir`.

**Must happen:** refused, naming the path as not readable. Not a file-not-found error —
that would mean the deny list was never consulted.

---

## Session B — The agent loop and checkpoints (~15 min)

### B1. A multi-step task completes

- [ ] Ask: `list the files in src, then read src/math.ts, then tell me what add() returns`

**Must happen:** two tool blocks appear in sequence, each collapsible and showing real
arguments and results, followed by a plain-text answer. The final answer is **not** buried
inside a collapsed tool block.

### B2. Rollback

- [ ] Ask: `add a doc comment to every function in src/math.ts`
- [ ] Approve the edit.
- [ ] A bar appears: "Files were changed this task." Click **Undo all changes**.

**Must happen:** `src/math.ts` returns to its original contents. The model is told the
workspace was reverted.

- [ ] Check `git status` in the fixture workspace.

**Must happen:** clean, or exactly what it was before. Light Code uses a *shadow* git
directory — your own index, branches, and stash must be untouched.

### B3. Read-before-edit

- [ ] Start a **new task** (the `+` icon in the header).
- [ ] Ask: `change the word hello to goodbye in src/greet.ts` — without reading it first.

**Must happen:** the edit is refused until the model reads the file. It will usually read
it and then retry, which is the correct behaviour; the point is that it cannot edit blind.

### B4. Cancel mid-stream

- [ ] Ask something long: `explain every file in this workspace in detail`
- [ ] Click the stop button while it is streaming.

**Must happen:** streaming stops, the partial response is kept (not blanked), and the next
message works normally.

---

## Session C — Task history (~10 min)

> **Partly confirmed already.** Inspecting global storage on 2026-08-09 found a task written
> by a real Extension Host run: correct shape, title derived from the first user message,
> system prompt excluded from the message count, and a matching index entry. So the *write*
> path works outside tests. The restore paths below are still unproven.

### C1. Survives hiding the panel

- [ ] With a conversation on screen, click Explorer in the Activity Bar, then Light Code again.

**Must happen:** the transcript is still there.

### C2. Survives a window reload

- [ ] `Ctrl+Shift+P → Developer: Reload Window`.

**Must happen:** the panel reopens on **the same conversation**, tool blocks and all.

### C3. Survives a full restart

- [ ] Close the Extension Development Host entirely. Press <kbd>F5</kbd> again.

**Must happen:** same conversation restored.

### C4. History list

- [ ] Click the history icon.

**Must happen:** past tasks, newest first, each with a readable title taken from your first
message, a relative time, and a message count. The current one is marked.

- [ ] Open an older task.

**Must happen:** the full transcript is restored, including tool calls and their results.

### C5. Resuming does not inherit read-before-edit

- [ ] Reopen a task in which a file was read and edited.
- [ ] Immediately ask for another edit to that same file.

**Must happen:** refused until it re-reads. The file may have changed since the transcript
was written, so a resumed session must not trust the old read. This is deliberate.

### C6. Delete cascades

- [ ] Note a task's spilled results, if any, in the `tool-results` folder.
- [ ] Delete that task from the history list and confirm.

**Must happen:** it disappears from the list, its `tasks\*.json` is gone, and its spilled
`tool-results` files are gone too.

---

## Session D — Providers (~20 min)

### D1. Model dropdown against a live endpoint

- [ ] Settings → Providers → edit your DeepSeek (or OpenAI) profile.
- [ ] Click **Refresh** next to the model field.

**Must happen:** a dropdown appears listing real models from the gateway. The **text field
stays editable** — the dropdown only fills it in.

- [ ] Now set the base URL to something wrong, e.g. `https://api.deepseek.com/nope`, and
      click Refresh again.

**Must happen:** a note explaining the failure, an empty dropdown, and the text field still
usable. It must not block you.

- [ ] Restore the correct base URL.

### D2. Test Connection

- [ ] Click **Test Connection**.

**Must happen:** three labelled steps. For an API-key profile: certificates *skipped*,
credential *ok*, models *ok*.

- [ ] Clear the API key (Replace, then leave blank is "no change" — instead delete the
      profile's key by entering a deliberately wrong one), and test again.

**Must happen:** the credential step fails and the models step is **skipped**, not attempted.
Which step failed must be obvious.

### D3. Capability display

- [ ] Type `gpt-4o` into the model field.

**Must happen:** below it, something like "128,000 token context · vision · tools".

- [ ] Type `some-internal-alias-7`.

**Must happen:** it says the id is unrecognised and states the conservative assumption.

### D4. Anthropic — **not yet verified against the live service**

Only if you have a key.

- [ ] Add a profile with the **Anthropic** preset, paste a key, model `claude-sonnet-4-20250514`.
- [ ] Use it, then ask a multi-step question that requires tools:
      `list the files in src and then read the largest one`

**Must happen:** streaming text, tool calls execute, the session completes. Watch for
"invalid alternation" style errors in the Output channel — that would mean tool results are
not being merged correctly.

### D5. Gemini — **not yet verified against the live service**

- [ ] Add a profile with the **Google Gemini** preset, model `gemini-2.5-pro`.
- [ ] Ask the same multi-step question.
- [ ] Then specifically: `read src/math.ts and src/greet.ts` (two calls to the same tool).

**Must happen:** both reads complete and are matched to the right results. Gemini supplies
no call id, so results are paired by name — two calls to one tool in a single turn is the
case most likely to expose a problem.

---

## Session E — Phase 7 features (~15 min)

### E1. Token bar

- [ ] Have a conversation with several tool calls.

**Must happen:** a bar above the composer showing total tokens and a proportional
breakdown. Expand it: system prompt, tool definitions, conversation, tool results, each with
a number. It says "(est.)" when the provider reports no usage.

### E2. Superseded reads

- [ ] Ask: `read src/math.ts` — then `read src/math.ts again`.
- [ ] Expand the token bar.

**Must happen:** it reports a superseded read was dropped. The transcript still shows both
reads with their full content — only what is *sent* is trimmed.

### E3. `@` mentions

- [ ] In the composer, type `@math`.

**Must happen:** an autocomplete list of matching workspace paths. Arrow keys move,
<kbd>Enter</kbd> or <kbd>Tab</kbd> inserts, <kbd>Esc</kbd> dismisses.

- [ ] Select `src/math.ts` and ask `what does @src/math.ts do?`

**Must happen:** the model answers *without* calling `read_file` — the contents were
attached. Your message in the transcript still reads as a question, not a wall of source.

- [ ] Now try `@../../../etc/passwd` (or any path outside the workspace).

**Must happen:** an error saying it is outside the workspace. **Not** the file contents.

### E4. Image attachment

- [ ] With a vision-capable model selected (e.g. `gpt-4o`), confirm a paperclip button is
      present next to Send.
- [ ] Take a screenshot, paste it into the composer with <kbd>Ctrl+V</kbd>.

**Must happen:** a thumbnail chip appears with a remove `×`.

- [ ] Ask `what is in this image?` and send.

**Must happen:** the model describes the screenshot.

- [ ] Switch to a text-only model (e.g. `deepseek-chat`).

**Must happen:** the paperclip button **disappears** entirely.

### E5. Compaction

Hard to trigger deliberately; check opportunistically during a long session.

- [ ] Run a long, tool-heavy task until the token bar approaches the window size.

**Must happen:** a message saying N earlier messages were summarised, and the session
continues coherently. The saved transcript must still contain the full history — check by
reopening the task from the history list.

---

## Session F — MCP (~15 min)

Needs a real MCP server. The filesystem one is easiest:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "<your fixture workspace path>"]
    }
  }
}
```

- [ ] Settings → MCP → paste that into the raw JSON editor and save.

**Must happen:** a package-runner warning appears, because `npx` fetches from the network.

### F1. Startup and health

- [ ] Reload the window and open the panel.

**Must happen:** the server connects **when the panel opens**, not on first tool use. Its
status is visible, and its log is expandable.

### F2. Per-server toggle

- [ ] Untick the server's Enabled checkbox. Ask the model to use one of its tools.

**Must happen:** the model does not have the tool at all — not a refusal at call time.

### F3. Per-tool permission

- [ ] Re-enable the server. Set one tool to **Never**.

**Must happen:** that tool vanishes from the model's options while the rest still work.

- [ ] Set a tool to **Always**, use it once.

**Must happen:** no approval prompt for that tool; others still prompt.

### F4. A broken server is isolated

- [ ] Add a second server with a deliberately wrong command, e.g. `"command": "nope-not-real"`.

**Must happen:** it shows as failed with a readable reason, and **the working server is
unaffected**.

---

## Recording results

Note anything that did not match, with what you did and what happened. Two things are worth
capturing even when a check passes: anything that felt confusing, and anything that took
longer than it should have.

Findings go into `CLAUDE.md` §19 so the next session starts from what is actually known
rather than what was assumed.
