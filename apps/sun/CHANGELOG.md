# @chosengeneration/fire-code

## 0.7.0

- **Python tools from a bucket are reviewed once, not once per codebase.** Every codebase and chat now uses one copy of each bucket folder, and the approval is kept with it; approve in one codebase and the others stop asking within a few seconds. They ask one more time after this update.
- **Right-click a codebase to see its @ name**, with a Copy button.
- **Credentials shared from VS Code**: a username and password for the same connection now arrive as one login (offered as "— username" and "— password"), replacing the two loose entries earlier versions made.
- `@payments-api` on its own attaches that codebase's top folder (it used to look for a file called payments-api).
- A search connection's Username can be a saved credential, like its Password.
- Hovering a dropdown, or any choice in it, shows the full text when it is cut short.
- Carries Light Code 0.112.0.

## 0.6.1

- **Sharing keys from VS Code no longer fails with EPERM.** Fire Code hung up before VS Code had read its answer, so a share that had worked was reported as failing; and between two callers there was a moment when Windows refused a connection outright (EPERM). It now waits for the answer to be read and always has the next connection open.
- Carries Light Code 0.111.0 (unchanged).

## 0.6.0

- **Renamed to Fire Code.** Install `@chosengeneration/fire-code` and run `fire-code`. Codebases, chats and credentials move across from Sun Code (or Sun Light Code) on first start; then `npm uninstall -g @chosengeneration/sun-code`.
- **See at a glance which codebase is waiting for you**: a "!" on top of its tile, an amber row saying what it needs (your approval, an answer to its question, a form), a marked chat tab, a "2 waiting" button that jumps to each in turn, the count in the title bar, and a flashing taskbar button when Fire Code is in the background.
- An agent that ends its turn by asking you a question now counts as waiting for you, not finished.
- Carries Light Code 0.111.0.

## 0.5.3
## 0.5.3

- **Refer to other codebases.** Type `@` and the other codebases are listed first; pick one (`payments-api:`) and the picker carries on inside it, or type `@payments-api:src/app.py`. Every agent also knows the other codebases by name and may read them; writing there asks every time.
- **`@` search runs on the Rust helper**: faster in big codebases, and files your .gitignore excludes stay out.
- **Parallel chats, safer**: a shell command naming a file another chat changed since this chat read it is refused until it reads the file again; Rollback asks before undoing changes another chat also made to the same file.
- Carries Light Code 0.110.0.

## 0.5.2

- **Git changes in the sidebar**: a codebase managed by git shows how many files are new, modified and deleted (+3 ~5 −1), with the branch on hover. Refreshed every 30 seconds, when you open the codebase, and when an agent finishes; it never takes git's lock.
- Carries Light Code 0.109.0.

## 0.5.1

- **Sun runs the schedule timetable.** A codebase no longer has to stay awake all day for its schedules: Sun wakes it a minute before a job is due — asleep, or never opened this session — and lets it sleep again a couple of minutes after.
- Fixed: earlier versions never noticed a codebase's schedules, so a sleeping codebase's jobs did not run.
- Fixed: with several chats open on one codebase, each ran the same scheduled job. Only the first chat runs them now.
- Carries Light Code 0.109.0, where `@` always finds the file you mean in a large codebase.

## 0.5.0

- **Renamed to Sun Code.** Install `@chosengeneration/sun-code` and run `sun-code`. Your codebases, chats and credentials move across from Sun Light Code on first start. Uninstall the old package with `npm uninstall -g @chosengeneration/sun-light-code`.
- **Settings → Environment**: a startup script (.cmd, .bat or .ps1) whose variables and PATH changes reach every codebase's agents; folders put in front of PATH; variables with plain values or saved credentials.
- **Reports open in Sun**: Markdown and HTML reports in Sun's own viewer, from a notification or a codebase's Reports… list. HTML reports keep their styling; scripts and remote content are blocked.
- **Copy, move and zip** with the Rust helper: `transfer_files` and `archive_files`, which always ask and show exactly what will be copied, moved, replaced or extracted.
- **Exporting credentials**: choose which ones; nothing is ticked to begin with.
- Carries Light Code 0.108.0: code highlighted as in VS Code, white text on teal, a Review icon of its own.

## 0.4.0

- **Several chats per codebase.** Tabs above the chat: + (or Ctrl+T) opens another chat on the same codebase — its own agent, working at the same time, with the same settings and keys. Rename with a double-click, close with × or Ctrl+W. The sidebar shows how many are working.
- **Safe in parallel**: an edit is refused when the file changed since that chat read it, and Rollback undoes only the files that chat changed.
- **Language servers**: after every edit the agent sees the errors its change produced, for every language with a server installed on this machine.
- Carries Light Code 0.107.0.

## 0.3.0

- **Reach beyond the codebase** (Settings, on by default): read any drive or shared folder; write anywhere, asking every time outside the codebase, with the diff and a warning that Rollback cannot undo it. Keys, passwords and Windows folders stay off-limits.
- **Parallel Rust file tools**: find files across drives and shares, summarise folders, find duplicates, read many files at once, and work through huge logs and CSV/Excel files part by part.
- Carries Light Code 0.106.0.

## 0.2.1

- Carries Light Code 0.105.0.
- Credentials → **From IntelliJ / PyCharm** brings in the keys Light Code keeps for those IDEs on this computer, by name, after you confirm.

## 0.2.0

- Credentials: save keys and passwords once, by name, and pick them in any codebase's settings; changing one updates everything that uses it. Values are never shown again.
- Keys are encrypted for your Windows account (DPAPI); existing keys are moved in automatically.
- VS Code can hand its keys over: run **Light Code: Share API keys with Sun Light Code** while Sun is open.
- Export and import credentials in a passphrase-encrypted file, for another computer or a colleague.

## 0.1.1

- The Variables tab in each codebase shows only your own variables; the administrator sections belong to a shared server and are no longer shown. Carries Light Code 0.103.0.

## 0.1.0

- First release: every codebase in one Windows window, each with its own Light Code agent working in parallel. Link, copy or start a codebase's Light Code settings; Windows notifications; idle codebases sleep to free memory; Sun's theme and accent apply to every chat, and a codebase may keep its own accent. Carries Light Code 0.102.0.
