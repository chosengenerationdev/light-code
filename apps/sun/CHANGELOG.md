# @chosengeneration/fire-code

## 0.31.0

- **A renamed first chat keeps its name.** The name was saved, but the list of codebases sent to the window left that one field out, so the tab still said "Chat 1". Names given to any chat now show at once and come back after a restart. A test now fails if a saved codebase field is not sent to the window.

## 0.30.0

- **Fire Code: double-click rename works**, for every chat including the first. Selecting a tab moved focus into the chat a moment later, which closed the rename box before anything was typed. Right-click a tab for Rename chat, New chat, View agent log and Close chat.
- Every greyed-out button in Fire Code's window, and in its chats, says why when hovered.
- **DevOps → AutoSys reads as username and password.** The username box now comes before the password and is no longer marked optional; the password field, its placeholder, the panel summary and the Remove button all say "password" instead of "token".

## 0.29.0

- **Rename any chat, the first one included.** Double-click a chat tab, or right-click it → **Rename chat**. "Chat 1" could not be renamed before, and renaming the others was only by a double-click nothing on screen mentioned. The name shows on the tab, in the window's title and in notifications. Right-clicking a tab also offers New chat, View agent log and Close chat.

## 0.28.0

- **GitHub Copilot as a provider.** If Copilot is signed in to in VS Code, choose the **GitHub Copilot (from VS Code)** preset in Settings → Providers and pick one of the models your Copilot plan offers - no key, URL or certificate. It goes through VS Code's own Language Model API: VS Code makes each request with Copilot's sign-in, Light Code never sees a token, and the first request asks in VS Code whether Light Code may use Copilot. Requests count against your Copilot plan. Fire Code, the Light Code host and the JetBrains plugin on the same machine use it through an open VS Code window with the Light Code extension, over a local pipe only your Windows account can use.

## 0.27.0

- **A second chat no longer says the scheduler is stopped.** Only a codebase's first chat runs its schedules, so a job never runs twice; the others said "The scheduler is not running — nothing will fire" and offered a Restart that started a second timer. They now say the first chat runs them, and offer no Restart.
- **The company-directory lookup no longer uses PowerShell.** It ran `powershell -EncodedCommand` with an Active Directory search, which raised a security alert on a managed machine; machines doing the same lookup through the Rust helper raised none. It now goes only through the Rust helper (Windows' own LDAP client), and with no helper it is simply not used. In the background only you are looked up; authors and colleagues are looked up when the usage dashboard is opened.
- The helper's `dataframe` operation (Polars) is now a build feature, on in Fire Code; the VS Code extension carries the helper built without it.

## 0.26.0

- **Monthly roll-up of usage statistics.** Three days after a month ends, each machine merges its own day files for that month into one month file, reads it back to check every event is there, and only then deletes those day files - so a year is about a dozen files per person and machine instead of a few hundred, and dashboards over long ranges stay fast on S3 and vector stores. Only a machine's own files are touched; nothing is ever counted twice, even mid-way; a late day for a finished month still counts. Fire Code's helper reads month files and skips their leftover days the same way.

## 0.25.0

- **`usage_stats`: the usage data as a tool.** Ask the assistant for any metric the dashboard does not draw - it reads the same data (summary, every use as a row, installed skills and tools, who people are) and works it out with `dataframe`.
- **Usage collection is safe with several windows or chats open at once.** Each session now writes only its own queue files, a day is sent again whenever any of its files grew, and whoever sends a day checks afterwards that nothing changed meanwhile - so no event is lost, none is counted twice, and the one-time import of past chats cannot run twice. No locks, so nothing can be left stuck by a window that closed. The older queue file is moved over automatically.

## 0.24.0

- **People on the usage dashboard come from the company directory.** On a domain-joined Windows machine, display name, email, department (the team), title and office are read in the background for you, every author of a skill or tool, and every colleague in the numbers - by Fire Code's Rust helper when it is installed, otherwise a fixed PowerShell script; search only, as the signed-in user. Off a domain, a user-info tool or a skill describing the lookup is used instead.
- **Leaderboard.** Rank authors by most written, most impact (uses × people reached) or most active this period (skills and tools added or updated in the range), with a This period column.
- The helper gained a `directory` operation (wldap32, read only).

## 0.23.1

- **Help: user-info tools for the usage dashboard.** `light_code_help` now says which tool names are found automatically (the `py__` or MCP prefix does not matter - `py__whoami`, `py__get_user_info`, `py__employee_lookup` are; `py__getuserinfo` is not and has to be named in Settings → Usage), and how to have the assistant create a `whoami` tool: the six fields to return, credentials through `__credentials__`, and a skill to teach it the directory.

## 0.23.0

- **The usage dashboard collects by itself.** Wherever the team already shares a store - an OpenSearch connection first, then any other vector store, then a team S3 bucket - collection starts without being switched on (Settings → Usage can pick a shared folder instead, or stop it on one machine). The first time, conversations already saved on the machine are imported so the dashboard has history from day one - by Fire Code's Rust helper when it is installed. If a tool that looks users up is available (whoami, user_info, employee_lookup, ...), the assistant calls it once and records your name and team, so the dashboard shows people and a By-team table instead of login names. The helper gained a `usage` operation: shared-folder shards written atomically and read in parallel, and the import of saved conversations.

## 0.22.0

- **Usage dashboard (Settings → Usage).** Which skills and tools are used most, by whom, who writes them, and what has gone unused - for you or the whole team, over 24 hours to a year or any date range, each figure compared with the previous period. It lists problems (the same name with different content, identical skills under two names, near-identical names, failing tools, tools not loaded, skills colleagues use that are missing here) and lets you open or delete unused skills and tools from this project's folder. Collection is off until you choose a shared folder, S3 bucket or vector store the team can reach; only names and times are recorded, never arguments or files.

## 0.21.0

- **Large tool results become tables, and joins can be built in steps.** When a tool returns more JSON records than fit in the reply, `dataframe` reads them by the handle in the truncation note - nothing is retyped. `steps` names intermediate results (totals per owner, then join the owners' teams) that later queries can join and alias like any source.

## 0.20.0

- **Join data from anywhere with `dataframe`.** A source can now be a SQLite table or read-only query, a JSON file of records, or records the assistant already has (results from Jira, an API call, a mail search) passed straight in - and joined in one SQL query with CSV, Excel and clipboard data.

## 0.19.0

- **Search file contents across folders and shares** (`grep_files`, Fire Code's Rust helper): text or a regular expression with context lines, several folders, drives or shares in one search, filtered by file name, extension and date; reads UTF-16 files, and lists every file or folder it could not read with Windows' reason.
- **DFS shares work.** A DFS path was followed to the server behind it and opened there, which can be refused even when the DFS path works for you (a NAS share was never affected). DFS paths, and drive letters mapped onto DFS, are now used exactly as written.

## 0.18.1

- **Switching to the lighter prompt is fully automatic.** Adding a search index, or switching on another integration later, now indexes the tool documentation in the background within seconds; before, it waited for an unrelated change, and the hidden tools were found only by name meanwhile.

## 0.18.0

- - **Much less context used by tool descriptions when a search index is configured.** The Excel, Outlook, Confluence, Jira, Bitbucket, Jenkins, AutoSys, JupyterHub, S3, API, data and Python tools now keep their full instructions in the documentation index instead of every request: the prompt lists them by name and tells the assistant to look them up with `search_docs` before using them or planning a job. With everything switched on that is about 38,000 tokens of tool definitions down to about 11,000 per request. Without a search index nothing changes.

## 0.17.0

- **Proxy for API calls** (Settings → Network): an HTTP and an HTTPS proxy for `http_request`, written with the login in the address (`http://user:password@proxy:8080`) - the password goes into secret storage, never into settings - plus hosts to reach directly. Works for ordinary and negotiate (Kerberos/NTLM) requests.
- Light Code's help now knows the fast Rust tools and where they are available (Fire Code, or VS Code with Fire Code installed), and lists the settings tabs as they are now.

## 0.16.0

- **Call REST APIs** (`http_request`): GET and POST with headers, to hosts you name in the chat - give it an API's documentation and it can try the API. Kerberos/NTLM negotiate as your Windows login, a provider profile's auth (an Apigee gateway token), CA and client certificates, and 202 Accepted polled until done. Credentials go in as `${secret:NAME}`, never pasted; every request asks first.
- **Use Python libraries in parallel** (`python_library`): list, describe and call the functions of a library kept in a folder with its DLLs (pricing libraries, say) - thousands of calls at once across worker processes, each with its own interpreter, so the GIL does not serialise them. Tell it the folder, or save it in Settings → Python → Library folders; without one it asks. Lists of lists come back as tables.
- **Data analysis** (`dataframe`): Polars SQL over CSV, Excel sheets and the clipboard - joins across files, grouping, window functions and pivot - with forgiving reading that never drops a value: a column becomes numbers or dates only when all of it converts, and the answer says which columns stayed text and why.
- **VS Code uses Fire Code's Rust tools when Fire Code is installed**: big files, tables, SQLite, dataframes and the Python library pool, with nothing extra in the extension.
- Fire Code now records where its Rust helper is, so Light Code in VS Code can use it.

## 0.15.0

- **Read SQLite databases fast, safely.** A new `query_sqlite` tool (Fire Code's Rust helper) shows a database's tables and row counts, runs read-only SQL, filters and groups big tables on every CPU core, and finds text anywhere in the database. It never creates a database - a wrong path is reported, not turned into an empty file - refuses writes, and never blocks the application that owns the database: classic databases are read without taking any lock (and checked for writes that landed mid-read), and WAL databases as a WAL reader, which never blocks a writer.

## 0.14.1

- **Asking it to message someone in Teams now sends the message.** "Message Ravi about the PR" opens the chat and presses Enter (after you approve, with the same safety checks); only asking for a draft leaves Send to you.

## 0.14.0

- **No Review or Variables tab on your own machine.** Both belong to a shared server (`--server`); a local run, which is every Fire Code chat, no longer shows them.
- **Teams can send, when you say so.** Ask for the message to be sent and `teams_open_chat` presses Enter in Teams for you - only once a Teams window has been in front and steady for a couple of seconds, and still is at that moment. Otherwise nothing is pressed and it tells you the message was not sent. The approval says plainly that it will send.

## 0.13.0

- **Merge an approved Bitbucket pull request, and tag it.** `bitbucket_merge_pull_request` merges a pull request once a reviewer has approved it - refused while nobody has, anyone marked it needs-work, it has conflicts or Bitbucket's merge checks say no - and can then create a tag on the merge (e.g. `v1.4.0` on master). Always asks first; never runs in a schedule. It still cannot approve or decline.
- **Tell a colleague in Teams.** `teams_open_chat` (Settings → Tools, off by default) opens a Teams chat with the people you name, the message already typed in - such as the new pull request's link. You press Send; it cannot send by itself. Uses the Teams app installed here and your own account, no Graph API.

## 0.12.1

- Light Code's help now describes VS Code's commit-message button by its own icon rather than as a sparkle.

## 0.12.0

- **Bitbucket files can be read behind single sign-on.** Reading a file sent the request to Bitbucket's web `/raw/` address, which a SAML site answers with its login page whatever the token, so pull requests could be listed and files could not. Files are now read through the REST API, like everything else. A login page where data was expected is now reported as single sign-on, naming what to check.

## 0.11.1

- **A formatted answer no longer collapses into a paragraph as the reply ends.** When the assistant wrote its answer and then finished with a short summary, the summary replaced the answer on screen. Both now show, the summary below; a summary that only repeats the answer is shown once.

## 0.11.0

- **Git for JupyterHub codebases.** The repository is on the hub, so the change counts, **Commit and push**, **Pull** and **Write with agent** now run git there, through the codebase's agent (while its chat is running). Commit saves your local edits to the hub first; pull is fast-forward only and copies the changes here afterwards. The agent can run any other git command with `hub_run`.
- **Browse a hub from any codebase.** `hub_browse` lists folders, finds files and reads them anywhere your hub user can see, read only - in the hub codebase beyond its added folders, and in every other codebase for each hub codebase, by its @name, without a second token.
- **`hub_run` works.** On the Node host the WebSocket a kernel needs was dropped on the way, so every hub run failed with "This host cannot open the WebSocket a kernel needs".
- **A chat woken from sleep opens at its newest message**, not its first.
- **Compaction follows the model actually deployed.** A self-hosted model's real window (vLLM's `max_model_len`, or the number in its "maximum context length" refusal) is learned and used; a window set on the profile still wins.
- **Long chats keep their context.** A model Light Code did not recognise (most gateway aliases, and newer families such as Claude 5, GPT-5, Gemini 3, DeepSeek V3) was treated as a 32k window, so history was summarised after a few steps and only the last dozen messages survived. History is now compacted **only when you say so** - **Compact now** under the token bar, or tick **Compact automatically** beside it - and then only against a window Light Code actually knows. Summaries keep about a third of the window verbatim, and **your own messages word for word**, every time.
- **A reply that hangs is retried.** A request that sends nothing at all for 5 minutes is stopped and sent again, instead of showing "thinking" for ever.
- **Connection problems are retried by themselves.** A dropped connection, a gateway error (5xx), rate limiting (429) or overload is retried up to 3 times, waiting a little longer each time, and the chat says "Retrying in Ns". A rejected key, bad request or certificate problem is never retried. Both numbers are in Settings → Approvals → "Unresponsive or failing model".
- Carries Light Code 0.118.0.

## 0.10.0

- **Commit and push, and pull, from a codebase's row** (hover it). The commit dialog lists what changed and has **Write with agent**: the codebase's model drafts a message from the diff, you edit it, and nothing is committed until you press the button. Pull is fast-forward only and says so when the branches have diverged.
- **Hover the git counts to see the changed file names.**
- **Code blocks in replies** have a tinted background, as in VS Code, instead of disappearing into the page.
- **Drop any file or Outlook email into the chat.** Big logs, PDF, Word, Excel and messages dragged out of Outlook (up to 20 MB) used to be refused with "too large - save it and tell me where"; they are now saved to a temporary folder and read, an email's own attachments included. A long one is cut with its path, and the assistant reads the rest without asking.
- **`outlook_read_email` reads the attachments** - PDF, Word, Excel, attached emails and text; pictures are shown to a model that can see.
- **What you type is kept** when you switch away (Settings, History) and come back, and when the page reloads.
- **Compaction when the token limit is reached.** If the model refuses the conversation as too long, older messages are summarised at once and the request is sent again; if it still cannot fit, the message says what to do. A **Compact now** button under the token bar does it on request.
- **Excel recalculation** (`excel_calculate`): a range, a sheet (Shift+F9), a workbook or everything open (F9, Ctrl+Alt+F9). Reports manual calculation mode and what the cells now show; can select the range.
- Carries Light Code 0.117.0.

## 0.9.1

- **The agent now uses the fast Rust file tools without being reminded.** They were always available, but nothing said when to prefer them, so the agent read big logs with read_file and listed folders with shell commands. The instructions now say which job each one is for (finding files, reading several at once, big logs, CSV/Excel, copy/move, zip), in Auto mode too.
- Carries Light Code 0.116.0.

## 0.9.0

- **Approve a Python tool once for every codebase.** Approving records the tool's exact code for this machine; every codebase holding the identical file approves it too, within seconds, with a note saying so - wherever the copies live. A changed byte still asks; a decline stays a decline.
- **Python tools can read saved credentials safely.** A tool declares what it needs, `__credentials__ = ["Corp LDAP"]`, and reads it with `light_code.credential("Corp LDAP")`. Only declared credentials are given, only to the approved tool, and any value handed out shows as [REDACTED] in what reaches the model. The approval card and diff say "Reads saved credentials: ..." (Fire Code; elsewhere use a secret variable).
- **Fix: JupyterHub copies moved out of Fire Code's protected data folder** (to `fire-code-hub` beside it). Inside it, the fast Rust search and file tools refused the codebase's own files. Copies made by 0.8.0 are moved on the next start.
- Carries Light Code 0.115.0.

## 0.8.0

- **JupyterHub folders as a codebase.** Add codebase → **On JupyterHub**: the hub address, your user name, the folders, and an API token (kept encrypted in Credentials, only ever sent to that hub). Fire Code keeps a copy here so reading and searching are fast; every edit the agent makes is saved back to the hub, and never over a change made there meanwhile - that edit is kept here and reported instead. Changes on the hub are fetched every few minutes.
- **Code runs on the hub**, where its libraries are: `hub_run` runs Python in a kernel kept for the session, a script from its own folder, or a shell command; `hub_inspect` looks up a library that exists only on the hub. Every run asks first and shows the code.
- Right-click a hub codebase → **JupyterHub settings…** to change the address, folders, kernel or token.
- Carries Light Code 0.114.0.

## 0.7.1

- **A codebase's own @ name works in its own chats** (`@tyj:src/main.rs` in tyj's chat). Before, only other codebases' names did, so the picker stayed empty.
- When @ finds no file or folder name matching what you typed, the picker says so instead of disappearing.
- Carries Light Code 0.113.0.

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
