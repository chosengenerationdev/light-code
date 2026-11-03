# @chosengeneration/fire-code

## 0.78.0

- **Checked contracts.** A connector's **Required items** (one per line) are checked after every hand-over: the specialist is told the format, and Light Code asks it again - twice at most - for any it left out before anything moves on. The main agent is told if a hand-over is still incomplete; the exchange log marks each contract kept or what was missing. **The agent proposes contracts** for connectors without one (`set_strategy_contracts`), and you approve each change.
- **Help is up to date**: checked contracts and agent-proposed contracts, editable observer instructions, the Rust helper in the Windows Node host and its two agent modes, and the Settings tabs as they are now (Team reviews, Add-ons, Strategy beside the mode picker).

## 0.77.0

- **A chat reopened from history keeps its strategy and its plan.** Both were dropped when a chat was read back from disk, so after reopening one the agent no longer followed either. **The record of what passed between specialists holds what the main agent asked**, not the specialists' own instructions, so it no longer reaches the main agent's context. A strategy is now tested end to end against a running host - set, followed, its rounds counted and the last refused, recorded, explained, and reopened - with specialists in the host and in their own Rust processes.

## 0.76.0

- **The agent now knows the strategy in every mode**, from your next message: it was given only in Agent team mode, so with Auto selected it was never told. The Strategy button shows in every mode once a specialist is assigned. **Fixed: a scheduled run removed the chat's plan and strategy** - it put the conversation back afterwards but not those two. **New chat with handoff keeps the strategy.** The window lists every contract when nothing is selected.

## 0.75.0

- **"Start a chat" from a monitoring alert carries the alert again.** The new chat's box was empty: the text was sent to the page in a shape it did not read. It now holds the alert, its history pointer and the dashboard's explanation, ready to send.
- **Agent team mode no longer needs the expert**: any assigned specialist enables it.
- **Help knows strategies**: ask Light Code how to draw one, connect steps, set a back-and-forth, use a parallel box or see what the specialists agreed (`light_code_help`, topic Strategy).
- **Connecting steps is easier to find.** Select a step and press **Connect to…**, then click the step it should lead to (connect them again the other way for a back-and-forth). Dragging from the dot still works. An empty chart lists the steps to follow.

## 0.74.0

- **Code mode is gone; Auto is the default.** Auto has the same tools; a chat or setting that used Code opens as Auto.
- **Strategy** (Agent team mode, beside the mode picker): draw how the main agent uses its specialists - click a role to add it as a step, drag to arrange, drag from a step's dot to another to connect them. A two-way connector is a back-and-forth (the programmer works, the tester checks, and back) that repeats until a condition you write is met, or at most N rounds. A step can be read-only - it cannot change anything. Strategies are saved and reusable; each chat uses one or none. With one in use, the agent first proposes a plan that follows it, and Light Code counts each loop's rounds from the consultations that ran, asks the judging role for a verdict, and stops a loop at its maximum.
- **Each step can carry your instructions** (the ✎ on it), sent to that specialist whenever it is consulted under the strategy; a step without them is left to the main agent's plan. **The window shows what is running**: the step at work glows, the Now panel names it with each loop's round and verdict, and the Strategy button shows who is working.
- **Parallel boxes**: draw a box and drop steps into it; those specialists are consulted at the same time, each in its own process (`ask_agents`). **Contracts**: a connector can say what passes along it, and both specialists are told. **What passed between them**: every consultation under the strategy - what was asked, answered, the loop's round and verdict - is kept with the chat and shown in the window per step or connector; "Ask the agent why" has the main agent explain it from that record (`strategy_history`). Approvals from specialists working in parallel are shown one at a time.
- **Each specialist works in its own process with its own context**, in every mode: it remembers earlier questions in the chat, and near its context limit it writes its own key points and starts a fresh session with them. The main agent sees only its answers. Its tool calls run through your approvals, and the prompt names which specialist is asking.
- **The Auditor's and Anti Hallucinator's instructions can be edited** (Settings → Project), with Reset to default; the reply format they must follow is always added, so an edit cannot break them.

## 0.73.0

- **Team admins and owners' approval** (Settings → Project → Team admins, kept in the team's OpenSearch index): the first admin list saved for a project wins, and after that only an admin can change it - read-only for everyone else. Ids are Windows user ids, never names. Whoever creates a skill or tool owns it; a change by anybody else is not written but sent to the owner or an admin, and nobody - its author included - uses it until it is approved. **Settings → Team reviews** (admins, and owners with something to decide) lists what waits, for how long, with the diff, to approve and publish or reject.
- **Auditor** (Settings → Project, per project): records everything the agent does - your requests, its reasoning, every tool call, every approval with the literal action you were shown, every result, how each turn ended - to a journal on this machine with secrets removed, and to your own OpenSearch index (`light-code-audit-<you>`) when OpenSearch is connected. It tells you at once when the agent does something dangerous or not allowed (a command marked risky, a change outside the workspace, a refused path, a tool outside the mode) - a Windows notification. With a model chosen it also reviews each batch of steps and raises its own alerts.
- **Anti Hallucinator** (Settings → Project): watches the agent's reasoning and results, and when it states something the evidence does not support, contradicts a result, drifts from what you asked or loops, sends it a short note at its next step - shown in the chat as the reviewer's, never counted as your words, granting no permission.
- **Each runs as its own process with its own context and its own model** (Rust: `fire-fs watch`), using the chosen profile's auth and certificates exactly as the chat does. Every reply carries the observer's running notes, so near its context limit a fresh process starts from them - nothing has to be written when the context is full. A process that keeps failing is stopped and said so; recording never depends on it.
- **`read_audit_log`**: agents can read the audit record back for later analysis - a summary (counts by tool and day, alerts, sessions), then the records with filters; rows go straight into the dataframe tool.

## 0.72.0

- **A crashing Python tool no longer crashes the agent.** When `python.exe` crashed (Windows' "stopped working"), the next request written to the dead worker raised an error nothing listened for, and that ended the whole agent. Every program Light Code starts now has that error handled, and the agent logs a stray error and keeps running instead of stopping. The failed call says why the worker crashed - the Windows code in words and Python's last lines (`PYTHONFAULTHANDLER` is on for tools).
- **Nothing typed or done is lost to a crash.** The conversation is saved during a turn - after your message and after each tool result - not only when it ends, and the message you are typing is kept by the agent as well as the page, so a restart on a new port brings it back.
- **No "python.exe stopped working" box for programs Fire Code starts**: it kept a crashed worker alive until dismissed, and the agent waited out its timeout. The crash now ends the worker at once and is reported in the chat.
- **Tokens burned by each team member**, in Settings → Usage: input, output and cached tokens by person - with each person's share, a trend line and their models - and by model, against the previous period. The providers' own counts (estimated, and said to be, where a provider gives none). Recorded only into the team's usage store, like the rest of the dashboard: counts and the model, never the text. `usage_stats` can return them as rows.

## 0.71.0

- **The token bar shows the real count.** It read 175k of 262k while the gateway refused the request as too long: the bar was a 4-characters-per-token estimate, and code, JSON, paths and logs take more tokens than that. OpenAI-compatible gateways and vLLM are now asked for their count (Anthropic and Gemini already send it), the bar shows it after every reply, and it corrects the estimate for that model - so the bar, and the point where compaction starts, follow what the model really holds. A refusal that states the prompt's size corrects it too. A gateway that rejects the usage request is asked again without it.
- **AutoSys patterns use `=@`**: `JOB*UK` is sent as `filter=name=@JOB*UK`. It was sent as `name==JOB*UK`, an exact match, and found nothing. A single job name keeps `==`.
- **Export and import AutoSys on its own**: a new **AutoSys** section carries the site, addresses, gateway, test job and read-only setting - not your user name or any secret. Imported alone it replaces only the importer's AutoSys settings. DevOps now covers Confluence, Jira, Bitbucket, Jenkins and the team repository.

## 0.70.0

- **A grid made for filtering.** A funnel beside every column's name lists its values with their counts - search them, tick the ones to show. The filter box under each name takes text or a condition: `>50`, `10..50`, `<5, >=298` (either), `>10 & <50` (both), `!text`, `"exact"`, `=` for empty. **Columns** in the toolbar hides and shows columns, remembered per monitor. The row count says how many rows the filters leave, with Clear filters.
- **Fast with big grids.** Only the rows in view are in the page - the rest are spacers - at fixed column widths; each column's values are prepared once per check; typing in a filter waits for the pause. 100,000 rows filter and sort in well under a second.

## 0.69.0

- **"Updated by" comes from the file's history.** A monitor kept in the team repository takes who changed it, and when, from its commits in Bitbucket; one in a git checkout from `git log`. Otherwise from its labels - and a file saved before `updated_by` existed no longer shows its *author* as the last to change it. Changes lists the file's commits with their messages. The header and tooltip say "(Bitbucket)" or "(git)" when it came from a commit.
- **Never "Next 36 min ago".** A check that is due and not started says **Due since** the time it should have started, with the waiting reason when there is one; outside its active hours, Next is when they open.
- **The grid window's buttons are no longer cut off** in a window that is not maximized. The page's column grew to the table's width and the window clipped its right side; it is held to the window now, and the toolbar wraps.
- **Copy from the grid**: click a cell, Shift+click for a block, Ctrl+C; right-click for a cell, row, column or the whole grid; or the copy button for every row shown, with headers. Pastes into Excel as cells and into Word or Outlook as a table.
- **The scheduler starts with Fire Code**, even if it was stopped before closing.
- **Asked for a personal check, got a team one**: your own words decide now - personal, private or just for me makes it personal whatever the agent passes.
- **Refresh syncs the team's skills.** The host refused the sync request 0.68.0 sent, so Refresh only re-read the folders.

## 0.68.0

- **Checks start on time, and say why when they do not.** A tile says **waiting…** with the reason on hover (checking it can run here, its turn behind 4 running checks, a colleague's window, the executor starting) or **due N min ago**; the grid window says the same. The monitoring executor starts as soon as a monitor uses a tool, not when a check falls due, and a tool's timeout counts from when the executor is up. A share path is checked in the background, so an unreachable share no longer holds the window up. A check marked running with nothing in flight is let go rather than never running again.
- **A window whose winner never reports is taken over** - once, by one other member, three minutes past the check's timeout - so a colleague's Fire Code closing mid-check no longer leaves it unchecked.
- **Is the scheduler working?** A line at the top of the dashboard: running and when it last looked, with **Stop**; stopped, with **Start**; not responding, with **Start again**, which lets go of anything stuck and restarts its timer. Stopped stays stopped after a restart; Run now still works.
- **Refresh** on the dashboard syncs the team's bucket folders and repository now, reads the folders again, and says which monitors are new and which are gone.
- **Who wrote it, who changed it, and when**: in the tile's tooltip and the grid window's header, and **Changes** lists every version - when, by whom, what changed, and the monitor as it was. Team monitors' changes are shared in the team index, so everyone sees the same list. Editing the schedule on the dashboard labels the skill like any other save.
- **The grid window's buttons are icons with tooltips**, wrapping in a narrow window instead of being cut off.
- **Underscores in replies are kept.** `job_status_flag`, `PAY_*_USD`, `__init__` and other names with underscores lost them in a formatted reply, read as italics or bold. An underscore inside a word, or around a single dunder name, is now text; `_this_` and `__these words__` still emphasise.
- **Skills and Python tools record who saved them last** (`updated_by:` / `__updated_by__`), beside the author, version and time they already carried. The author stays whoever wrote it.

## 0.67.0

(0.66.0 is skipped.)

- **Delete history older than N days**: right-click a tile → Delete its history… offers everything, or checks older than 7, 30, 90 or any number of days; **Clean up…** in Monitoring settings takes the same choice for every monitor. Both remove checks here (with their grids) and your own records in the team index; colleagues’ stay theirs.

## 0.65.0

- **Every member sees every row of a team check.** The computer that runs it shares its whole grid in the team index, once per distinct grid and day, and the others fetch it: the newest check and past ones in History, whoever ran them. (Before, others saw only the alerted rows.) A grid over 5,000 rows or about 2 MB stays alerted-rows-only.
- **Big grids are drawn as you scroll**: 200 rows at once, more as you near the bottom; filters, search and sorting still cover every row. Before, the grid stopped drawing at 3,000 rows.
- **Clicking a check in History shows its whole grid straight away**, under the bars - every row, coloured as it was - with **Open in grid view** for filters and sorting. No button to press first. A check without a whole grid says why in one line: recorded before 0.64.0, or run on a colleague’s computer.

## 0.64.0

- **Show the grid as it was**: a check chosen in History opens its whole grid - every row, coloured as it was - read-only, with Back to now. Kept on the computer that ran it, once per distinct grid, for as long as its history.
- **Delete this check**: one check out of the history, here and your own record of it in the team index.
- **Monitors can use Fire Code’s Rust tools directly** (`records: true`): a feed file late, ERROR lines across logs, a table filtered - no Python in between.

## 0.63.0

- **History on a chosen day**: a date box beside 24 h / 7 d / 14 d / 30 d / 90 d.
- **A check chosen in History shows its details where you clicked**: under the bars, with the time, result, who ran it, rows read, how long it took and its alerts; a clear check says why it has no rows. It used to appear below the alert patterns, out of sight.
- **The card’s Run history button** no longer has a cut-off label; the tooltip says what it does.
- **Interval checks run on the clock**: every 10 minutes is once in each 10-minute window (10:00, 10:10 …), not 10 minutes after each machine’s own last run. Team members who started at different times now always claim the same window, so a check can no longer run twice around a window’s edge.
- **Only a computer that can run a team check claims it**: the source's path is reachable, or its tool exists, is approved here and is allowed - checked without running it. One that cannot shows **Runs elsewhere** (reason on hover) and leaves it to colleagues. After a check fails here, colleagues get the next windows for a while, unless nobody else is running it.
- **Team checks keep running offline**: without the team history, the check still runs here (tile: **Offline · N not shared**); once it is reachable, each offline check is written only if no colleague already checked that window.
- **Team checks are collected once**: Run now on a team check claims a two-minute slot, so several people pressing it together make one check and see it, instead of one each. Each computer keeps only the newest 200 checks of a team monitor; the full history is stored once, in the team index.

## 0.62.0

- **Context menus close on a click outside them** again, even after a click inside (a disabled item, a separator). Before, that first click used up the listener and only Esc closed the menu.
- **Team monitors can be edited and deleted**: a monitor that is a copy from the team’s bucket or team repository was greyed out in the menu and its Save did nothing. A schedule change is now uploaded to the bucket or committed to the repository; Delete removes it there and here, for everyone. The window says where it is saving and waits for the answer.
- **Check for new team tools** (Settings → Python): a colleague’s new tool is offered for approval at once.
- **The Python tab opens straight away** with the tools already approved, while Python starts.
- **Review all…**: monitors waiting for your review are listed together, each definition shown, and the ticked ones approved.
- **Snooze until…** a date and time, on a tile and in its window; and **snooze one row** of the grid (right-click it, or Snooze row in its details).
- **Run history button**: the bars across the bottom of a tile are one wide button that opens the monitor’s History (earlier days too); a bar opens that check.
- Monitoring tools are told to use Polars when it is installed, and the tool template’s call to another tool works (it passed a dict).

## 0.61.0

- **Edit a check’s schedule**: **Schedule** in its window, or right-click a tile → Edit schedule… - every N minutes or hours, only between two times, at set times of day, on chosen days. Only those fields of the skill file change, and an approved monitor stays approved.
- **Delete a monitor for good**: right-click a tile → Delete this monitor… (or ⋯ → Delete in its window), after a confirmation naming what goes: its skill file, results and history here, and your own checks in the team history. A copy synced from the team’s bucket or repository says why it cannot be changed here.
- **Personal checks need nothing set up**: an agent asked for a check makes a personal one when team history is not configured.
- **Monitoring tools that call other tools** work in the background check when they call another Python tool more than once.
- **Closing a chat shows the tab beside it** (to its right, else its left) instead of the codebase’s first chat.

## 0.60.0

- **Team monitors keep their history in the team’s OpenSearch index** (Settings → Monitoring → Team history) and need it. Every member may run a team monitor, but each check slot is claimed first, so it runs once across the team; everyone sees the newest check and who ran it. Writes never overwrite and cleanup removes only your own.
- **When checks run**: every N minutes within a run window (or from/until a time), at exact times of day ("07:30", or several), on chosen days.
- **History**: the grid’s History view - a bar per check, each alert’s pattern (new, ongoing, recurring at a time, comes and goes), and any past check’s rows. Kept 90 days by default; Clean up now; Delete its history per monitor.
- **Alerts explained**: double-click a coloured row for the author’s advice and the agent’s explanation; **Start a chat** opens a chat named after the alert in the codebase you pick, with what is known already typed in.
- Snoozed or paused monitors no longer colour the Monitoring button. Less memory: only summaries are kept, rows are read when a grid opens.
- Python tools may call the tools they declare (`__tool_calls__`): MCP tools, other Python tools and Fire Code’s reading tools - in a monitor’s check without a prompt.
- Test connection Details now lead with the likely cause; AutoSys says when its server pages an answer (a pattern finding only some jobs).

## 0.59.0

- **Monitoring.** A full-window dashboard of glowing tiles, one per monitor, under Team alerts and Personal, with search and filters by colour: red (failure), amber (warning), purple (no fresh data), blue (information), green (all clear), grey (paused, or waiting for your review). Hover a tile for what it watches; click it for its grid in a window of its own - cells and rows coloured by its alert rules, filters on every column, double-click a row for its breakdown, acknowledge an alert until it gets worse.
- **Run by Fire Code itself (Rust).** Monitors are skills holding a `monitor` block: what to read, how often, the columns and the alert rules. Fire Code finds them (personal, codebases, buckets, team repository), checks them on schedule with no model call, keeps their history and sends Windows notifications. SQLite and CSV/Excel sources are read by the Rust helper; a Python or MCP tool runs in a background agent with no window.
- **Notifications at your level**, per colour: off, counted on the dashboard, silent, with sound, staying on screen, or a looping alarm - with reminders, quiet hours and a per-monitor override. A team monitor runs only after you approve it on this computer.
- **Agents create and control monitors**: they reuse or write the tool, create the monitor (you approve the file), read its alerts and rows, run it, open it, and - with your approval - pause, snooze or acknowledge. Settings → Monitoring switches it on.

## 0.58.0

- **AutoSys on a server with its own addresses.** A pattern such as `JOB*UK` now works where the server has no pattern status address: the matching jobs are listed and each one's status read in turn (one job falls back to a definition carrying its status). Test connection passes on the job list too, and a 404 says what to do next.
- **The assistant finds and keeps the addresses.** `autosys_check_addresses` tries the saved addresses, the usual layouts (`/v1`, `/AEWS`, `/AEWS/v1`, `/api/v1`) and anything read on the office wiki, with a job you name, and shows what each answered. `autosys_set_addresses` saves the working ones after you approve - always asked, each changed address tried live in the prompt, paths on your own site only, never in a schedule or with read-only access.
- **Share them with the team**: Settings → Export → **AutoSys addresses** carries only `autosys.paths`; importing it changes nothing else of the importer's.

## 0.57.0

- **Open a branch chat's folder in VS Code to run and debug it.** Right-click a chat tab → **Open this branch in VS Code** (or **Open in File Explorer**) opens that chat's own folder - for a branch chat, its branch folder - where VS Code runs and debugs that branch. The agent in Fire Code can read the paused debug session from there. The sidebar's Open in VS Code still opens the codebase's own folder.
- **Copying a folder into a new branch folder.** `branches.copyFiles` now takes folders as well as files - for example an uncommitted `.vscode` - copying only what the branch does not already have. Help explains .vscode and virtualenvs in branch folders (a venv is never copied: it records absolute paths).

## 0.56.0

- **A repository with no commits yet now says so** when you open a branch, instead of showing an empty list and an empty "starting from" box. Git makes a branch with the first commit, so make one (Commit and push, or ask the agent) and the branches appear. Make branch is also disabled, with the reason on hover, whenever there is nothing to start from.

## 0.55.0

- **A new branch starts from the main branch by default.** In VS Code's New branch… and Fire Code's New chat on a branch, the "starting from" choice now defaults to the repository's main branch - the one the remote marks as default, else main, else master - instead of whatever branch is checked out. Any other branch can still be picked; the list marks the main branch and the one the codebase is on.

## 0.54.0

- **Every chat tab shows its branch.** Chats working in the codebase's own folder show the codebase's branch under their name, as the first chat does; a branch chat shows its own.
- **The + button offers New chat on a branch.** It always opens a small menu - New blank chat, New chat on a branch…, and any archived chats - instead of making a blank chat straight away when nothing was archived. Ctrl+T is still a quick blank chat. The codebase's right-click menu in the sidebar has New chat on a branch too.

## 0.53.0

- **Several branches of one repository at once.** VS Code: **Light Code: Open Branch in New Window** (also a branch button in Source Control) opens a branch - existing, fetched from the remote, or new - in its own folder beside the repository and its own VS Code window, where running, debugging, terminals and Light Code all use that branch. **Light Code: Branches** lists the branch folders with their state and closes one safely. Fire Code: **New chat on a branch…** opens a branch as a chat tab working in its own folder; each tab shows its chat name with the branch underneath (trimmed when long, keeping a Jira key whole, full name on hover) and renaming a chat never changes its branch; **Close branch…** removes the folder. Git keeps it safe: one branch in one folder at a time, a close checks for uncommitted and unpushed work first, and the branch itself is never deleted. Optional per project: files to copy into a new branch folder (such as .env) and a setup command (such as pnpm install), run once. Commands and debug sessions get LIGHT_CODE_BRANCH and LIGHT_CODE_PORT_OFFSET so two branches can run at once. Codebase instructions, settings and approvals are shared by a repository's branches.

## 0.52.0

- **Create, copy and change Jenkins jobs.** `jenkins_write_job` creates a job, copies an existing job into a new one, or changes a job - most often its parameters: add one, change a default, its choices or its description, or remove one (string, text, boolean and choice parameters). Anything else - script path, branch, schedule, agent label - is an exact edit of the job's configuration. "A job like platform/api but with a hotfix branch parameter" is one copy with new parameters. It always asks first, showing the diff of the configuration Jenkins will be sent, and cannot be set to always allow. It never deletes a job, never creates or copies over an existing one, refuses to save if the job was edited on Jenkins after you were shown the change, and is removed by "My access is read-only".

## 0.51.0

- **New skills and tools are for the team by default.** The assistant no longer asks; a skill or tool becomes personal only when you say so ("just for me", "keep it private").
- **Delete everywhere.** Each skill (Settings → Skills) and tool (Settings → Python) has **Delete everywhere**: the first press lists exactly what will go - every copy on this computer, the objects in each S3 bucket folder and its files in the team repository - and the second removes them. Bitbucket cannot delete a file through its REST API, so each repository file is replaced by a one-line "deleted by you on <date>" marker; history keeps the old version, and every Light Code treats it as gone - colleagues' unchanged copies in folders Light Code syncs are removed at their next sync, while a copy someone changed or keeps in their own project folder is reported in red rather than removed. The repository goes first, and if it refuses (someone changed the file meanwhile) nothing else is removed. Writing a new one of the same name brings it back. A button only - the assistant cannot delete for the team; on a shared server only an admin can.

## 0.50.0

- **Choose "Only me" or "The team" when a skill or Python tool is created.** The assistant asks who it is for (unless you said). **Only me** keeps it in your personal folder on this computer (%LOCALAPPDATA%\light-code\personal), used in every project in VS Code, Fire Code and the Node host, and never uploaded to a bucket, committed to the team repository or sent to the team skills pool. **The team** saves it where your team shares - the team repository and/or the bucket folder marked "Publish". The approval prompt says which before anything is written, and updating one keeps it where it is. Personal skills are marked **only you** in Settings → Skills and can be removed there. Not offered on a shared Node server.

## 0.49.0

- **New skills and Python tools are saved outside the project while the team repository is on**, in a folder of the repository's own (the panel shows the path), so they never land in the project's git. A folder you chose in Settings → Skills or Settings → Python, or an S3 bucket folder marked "Publish", still takes precedence. Skills and tools already in the project's .lightcode folders keep loading and are still committed.
- **Fixed: the agent could not read skills kept outside the project.** Skills in S3 bucket folders or the team repository's copy were outside every folder the agent may read: VS Code asked permission for each one, and Fire Code refused them. Every skill and tool folder is now readable without asking.
- **Fixed: after switching the S3 bucket folders off, editing a skill that came from the bucket showed as a conflict.** It is now committed as an ordinary update.
- The team repository needs no S3 bucket: a new user can set up Bitbucket, fill in the panel and press Sync now.
- **Hitting the model's context limit now suggests a new chat with a handoff.** The error offers **New chat with a handoff** (beside + at the top) alongside Compact now: the assistant writes up the chat - goal, decisions, what is done, next steps - and a new chat starts from it, so the work carries on.

## 0.48.0

- **Switch the S3 bucket folders off safely once the team repository has everything.** Settings → DevOps → Team repository → *Use the repository instead of the S3 bucket*. **Check** syncs the bucket and the repository, then confirms every skill and tool in the bucket folders is in the repository with the same content, and lists anything that is not (not committed yet, or different). **Switch bucket folders off** is offered only after a clean check, and checks once more before acting. It switches the skills and tools bucket folders off together, and only unticks them: nothing is deleted in the bucket or on disk, and ticking them again in Settings → S3 undoes it. Afterwards new skills and tools are saved in the project's folders and committed to the repository, and what came from the bucket keeps loading from the repository's copy. Both buttons are disabled, with the reason, when no bucket folder is syncing skills or tools.

## 0.47.0

- **Fixed: the team repository panel showed false "Not synced - changed both here and in the repository" warnings.** When a colleague's edit reached the repository before your S3 bucket sync brought it to your machine, your unchanged copy was reported as a clash. Now only a file changed on both sides is red. A file that is newer in the repository while yours is unchanged is listed in grey as "Newer in the repository" and clears once the bucket catches up. Line-ending differences (Windows CRLF against LF) and a leading byte-order mark no longer count as changes. Existing sync records carry over; the next sync clears the false warnings.

## 0.46.0

- **Fixed: the team repository committed almost nothing when skills and tools live in an S3 bucket.** It committed only the folder new skills are saved in and skipped every file a bucket sync had brought down, so a team keeping its skills and tools in a bucket saw one skill and no tools reach the repository. It now commits everything skills and tools load from - the save folder, the project's `.lightcode` folders and every S3 bucket folder (never the repository's own copy). Two people committing the same bucket file agree rather than conflict, and an edit made in the bucket is committed by the next sync. The same name in two folders on one machine: identical is one file; if they differ, the one Light Code uses is committed and the other is listed under Needs attention. Press **Sync now** once after updating.

## 0.45.0

- **AutoSys: runs today or in the last N hours, and who started them.** `autosys_runs` takes a list of jobs and reports each run's start, end, status and exit code, and whether it ran on its schedule, was started **by hand** (with who sent the start and when) or was an automatic retry. It reads the server's run history and event history; where your server keeps those elsewhere, set `autosys.paths.runHistory` / `eventHistory` - the tool says which is missing. A run with no event record is reported as "not known", never guessed.
- **AutoSys Test connection can check a named job.** Fill in *Job to check in Test connection* and the test reads that job's definition - the same request as `<site>/job/<name>` in Postman.
- **Python tools that always ask.** A tool with `__always_ask__ = True` at module level asks before every run for everyone who has it: no "Always allow", and no auto-approve covers it. Ask the assistant to add it when it creates the tool.
- **Banned calls for Python tools.** Settings → Python → *Banned calls*: functions or modules no tool may use (`os.system`, `subprocess`, `someLib.someFunction`). Every tool is checked when it loads and before each call, through import aliases, and refused with the line named.
- **A team repository for skills and tools.** Settings → DevOps → *Team repository for skills and tools*, offered once Bitbucket is set up and using its token: a project, repository, branch (created from the default branch if main is protected) and folder. Existing skills and tools are committed on the first sync, changes are committed as you make them, and colleagues' are brought back every few minutes. Nothing is overwritten - a file changed on both sides is listed, not replaced; a deleted skill or tool stays in the repository. Only your own files are committed, never copies synced from an S3 bucket, so the two syncs cannot bounce files. Included in export/import under DevOps.
- **"Needs attention" shows background failures**: a team repository or bucket sync that failed or skipped a file, and Python tools that did not load, first in Settings → Usage.
- **Fixed: a tool approved in VS Code had to be approved again in Fire Code.** Approved tool code is now one list per Windows user (`%LOCALAPPDATA%light-codeapprovals`), shared by the extension, the Node host and Fire Code; Fire Code's earlier approvals are carried over.
- A skill identical in two folders (yours and a synced copy) is no longer reported as shadowed.

## 0.44.0

- **Fixed: AutoSys requests went to the wrong address (HTTP 404).** Every request added /AEWS to the site address, so an address that already ended in /AEWS asked for /AEWS/AEWS/... . The site address is now used exactly as you type it - include the web services prefix, e.g. https://autosys.example.com:9443/AEWS - and only the resource and its query are added (/job-run-info?filter=...). Test connection's Details show the exact address used. If you set request paths by hand in config (autosys.paths), they are unchanged.

## 0.43.0

- **"My access is read-only" on every DevOps connection** (AutoSys, Jira, Confluence, Bitbucket, Jenkins). Ticked, the tools that would change something there are left out entirely and the reading tools tell the assistant the access is read-only - so it explains what someone with access would need to do instead of trying, and you are never asked to approve a change the server would refuse.
- **More ways to read AutoSys.** Status can be narrowed by machine ("what is running on host X"), by time ("what failed in the last 6 hours") and to long runners ("running longer than 2 hours", with how long). Finding jobs can be narrowed by machine, owner, box, type, calendar or text in the command ("which jobs call load_gl.sh"). New: `autosys_machines` (machines like autorep -M, with the jobs running on and defined on one), `autosys_schedule` (what starts in a time window or on a day, from start times, days and run calendars), `autosys_calendar` (a calendar's dates, or whether a day is in it) and `autosys_global_variables` (like autorep -G). A server that answers one of these somewhere else is told which address setting to change.
- **Test connection shows its details.** Under the result, **Details** lists every request it made - the gateway's token request first - with the address, HTTP status, response headers and the start of the body; passwords, tokens and secrets are masked, and **Copy details** puts it on the clipboard for whoever runs the service. It opens by itself when the test fails.
- **Clearer sign-in errors from DevOps sites**: messages now name the HTTP status (401 not signed in, 403 forbidden) so they can be compared with Postman, and AutoSys and Jenkins are no longer told about a "personal access token" they do not use.

## 0.42.0

- **Fixed: Save SVG and Save PNG on a diagram did nothing** in VS Code and Fire Code. They used a browser download link, which neither window acts on. They now open a Save dialog (VS Code's own; a Windows one in Fire Code, starting in Downloads), show "Saving…" while it works, then say where the file went - or why it could not be saved. In a plain browser they still download.
- **Buttons show they are working.** A button that sends something to Light Code (Save, Test connection, Sync, Send…) now shows a small spinner and a busy cursor until the answer comes back, instead of looking like nothing happened for a few seconds.
- **Fire Code's own buttons press visibly**: dialog buttons sink and darken when clicked (the secondary ones did not react at all).

## 0.41.0

- **Close or archive a chat, and new chats start blank.** Fixed: a new chat could open showing an earlier chat's conversation - it was given the number of a closed chat and so opened that chat's folder. Numbers are never reused now. Closing a tab (×, middle-click, Ctrl+W, right-click) asks **Archive** (keeps the conversation and takes the tab away) or **Close and delete** (removes its conversations, reports and log). With chats archived, + offers *New blank chat* or any archived chat, which opens where it was left; archived chats can also be deleted from there. Ctrl+T is always blank.
- **Choose which skills go to the team.** Settings → Project → Team skills → *Choose which skills to send*: untick a skill to keep it to yourself. The choice is remembered, the Send button counts what goes, and a skill you untick after sending it is taken back from the pool on the next Send (only your own copy). Check status shows it as "kept to yourself".
- **Defaults for a skill's inputs.** Settings → Skills → a skill → *Defaults for its inputs*: placeholders written `{{name}}` or `<NAME>` are offered as boxes, and any other input can be added by name. The assistant uses them instead of stopping to ask, says which it used, and still asks for anything without a default; a value you give in the chat wins. Kept in your own settings, never in the skill.
- **Fixed: codebase instructions were easy for the model to ignore.** They sat in the middle of a long prompt, followed by thousands of words of tool and mode guidance. They now come last (before only a chat's plan) and are named at the very start, with plainer wording that they apply to every reply.
- **AutoSys through a gateway: paste the sign-in header value yourself.** With *Also send an AutoSys sign-in header* ticked, a new *Header value* field takes the whole value (for example `Basic ` + base64 of username:password). It is sent exactly as stored on every AutoSys call, beside the gateway's Bearer token, in the header you name (for example `x-api-authorization-header-for-service-provider`), and kept in secure storage - the username and password are then not needed.

## 0.40.0

- **Fixed: enabling an add-on could fail out of sight and leave no tab.** If starting it threw, the add-on list never came back to Settings, so no Linux tab appeared, and the reason went to the chat behind the Settings page (Fire Code showed nothing at all). Now the add-on stays enabled and its tab appears whatever happens; the reason is shown on the Add-ons tab, with the add-on's log and a **Start again** button; a failure preparing one add-on no longer stops the other MCP servers starting; and a start-up failure when Light Code opens is shown on the Add-ons tab too, with the full error in the log.

## 0.39.0

- **Set up SSH key**, one press on a Linux machine that signs in with a password: makes one key for this PC (`.ssh\light-code_ed25519`, reused for every machine), adds its public half to the machine's `authorized_keys` using the stored password, proves the key works, then switches the machine to it. A button only - the assistant cannot call it.
- **An add-on's tab lists the tools it gives the assistant**, with whether each asks first.
- **Add-ons installed globally are found with nothing to set**, also where `npm config set prefix` moved npm's folder, and beside node.exe (nvm-windows).
- **Fixed: "New chat with a handoff" refused straight after a reply** with "A reply is still running": the reply had said it was done but was still saving the chat. The button now waits for that instead of refusing.
- **Settings → Add-ons** (puzzle piece): installed add-ons, Enable, and the folders to look in - now with **Browse…**. The MCP tab lists only the servers you configured yourself. An add-on's own tab (Linux) shows only while it is enabled - disable it and the tab goes, keeping what you entered - and lists its tools with Ask first / Always allow / Never, changed right there.
- **Browse buttons work in Fire Code**: they open a Windows file or folder dialog. Before, every Browse button in a chat's settings did nothing there.

## 0.38.0

- **Add-ons can bring their own settings tab.** An add-on declares its fields in `package.json` and Light Code draws the tab, with the add-on's own icon; it appears only while the add-on is installed. What you enter is kept in your settings, passwords in secret storage, and the add-on receives them when it starts.
- **New: the Linux add-on** (`npm i -g @chosengeneration/light-code-addon-linux`). Add your Linux machines with short labels on its Linux tab; the assistant can then run read-only commands there (disk, processes, logs, services, containers) and download files to investigate. SSH runs inside Node - no plink, no ssh.exe, no new program - with one sign-in per machine reused and a refused sign-in never retried. Commands that could change a machine are refused before they are sent, and every command is approved like any other tool.

## 0.37.0

- **Fixed: chat tabs stuck on "That link has already been used".** A chat page loaded a second time with its first, single-use link was refused - after a restart, or when a page unloaded while hidden came back. The fresh link that followed never reloaded it, because it differs only after the `#`, and changing only that part of an address does not reload a page. Now a page that already holds its session in that window carries on with it; Fire Code gives a fresh link a new frame, which always loads, unless the page is already connected; and the page reloads itself if a fresh link arrives anyway.

## 0.36.0

- **`.hubignore` for JupyterHub codebases.** Files and folders it lists are never synced, in either direction: `.gitignore` syntax (`dist/`, `*.log`, `/build/`, `!keep.me`), in any synced folder, applying beneath it. Dot-files, `node_modules`, `.git`, virtualenvs and Python caches were skipped already and still are; a `!` line brings one back (`!.editorconfig`). The `.hubignore` itself is synced, so the hub and other machines follow it. A file synced before a rule listed it simply stops being synced; nothing is deleted on either side. The agent writes one when it sets up a Node, Angular or other build project in a hub folder, before installing or building.

## 0.35.0

- **Codebase instructions, edited in Fire Code.** Right-click a codebase → *Codebase instructions…*: what every chat on that codebase is told with every message, ahead of the standing instructions (where they disagree these win; what you say in a chat wins over both). A save reaches every chat from its next message - nothing restarts. *Edit standing instructions* in the same dialog opens those too.
- **Much less memory.** Each chat's agent process is about 130 MB smaller (237 MB → 103 MB idle): its bundle had been carrying old exported copies of itself. Chat pages you are not looking at are unloaded after 5 idle minutes while their agents keep running (Settings → *Unload hidden chat pages after*; never while working or waiting for you) and reload when opened. WebView2's disk cache is capped at 32 MB.
- **Less disk per chat.** A codebase's chats share one checkpoint store, one Python venv and one set of index bookkeeping, so a new chat no longer adds another copy of the codebase's snapshots or another venv.
- **Add-ons: more tools from Node packages you install.** An add-on is an npm package whose `package.json` carries `"lightCode": { "addon": { "main": "server.js" } }`, where `server.js` is an MCP server. Install it with `npm i -g`, then Settings → MCP → Add-ons lists it; press Enable, read the program it will run, and confirm. Its tools appear as `addon-<name>__<tool>` and are approved like any other tool. Installed is not enabled, an update stays off until you enable the new version, and a repository's own settings can never switch one on. `examples/light-code-addon-hello` in the source is a complete one to copy.

## 0.34.0

- **New chat with a handoff.** A button beside + starts a new chat from a handoff of this one, instead of compacting: the assistant writes up the goal, what is done and decided, the current state, open questions and next steps, and the new chat opens with it as its first message. Your own messages are quoted word for word, and the files read and changed and the commands run are listed from the actual tool calls, so nothing important rests on the summary alone. A progress panel shows each step and how much has been written, with Cancel; a failure leaves the chat as it was. The old chat stays in History.
- **Read a program paused in VS Code's debugger.** With a VS Code window open (Light Code 0.166.0 or later there), `read_debug_session` reads its call stack, variables and recent output - every open window is asked, and the one stopped at a breakpoint wins. Read-only. IntelliJ and PyCharm are not supported yet.

## 0.33.0

- **Edit skills, tools and the standing instructions without leaving the app.** Where there is no code editor - Fire Code, the browser host, JetBrains - *Open* (and the standing-instructions button) now opens Light Code's own editor: a full-panel text box with Save (Ctrl+S), Close (Esc) and a Markdown preview. Before, it only pasted the file's text into the chat. A save is refused if the file changed on disk after you opened it, rather than overwriting that change; line endings are kept as the file had them. Editing a Python tool sends it back for approval, as any change to its code does. On a shared server only an admin can save.

## 0.32.0

- **Copying a reply keeps its formatting.** Select part of a reply and press Ctrl+C, or use the new **Copy** button on a reply: tables (with borders and a header row), headings, lists, quotes and code paste into Word, OneNote, a wiki or an email as they look in the chat, in dark text on white whatever the editor's theme. Before, a copy carried the theme's colours (white text that vanished in Word) and lost table borders.
- **Confluence pages look like the chat.** The assistant can now write a page as the same Markdown it uses in replies, converted to Confluence's own format: real headings, tables with a header row, code in Confluence's code macro, quotes, lists and links. Before, it had to hand-write Confluence's XHTML, which came out plain. The approval shows the converted page.
- **Links in a reply open in your default browser.** In Fire Code a click opened the site inside the chat, where most sites refuse to appear ("content is blocked"); in the browser-based host it replaced the chat page. Links now always open in a new window, which VS Code and Fire Code send to the default browser (mail links to the mail app).
- **AutoSys behind Apigee says what goes where.** The token is fetched with the consumer key and secret alone; your AutoSys username and password go only with job calls, never to the token URL. The panel used to read as if the gateway replaced the username and password, and called the key and secret "client id" and "client secret". It now uses Apigee's names and says so; a test pins that the token request carries no AutoSys sign-in.

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
