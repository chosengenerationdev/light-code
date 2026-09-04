# @chosengeneration/light-code

## 0.30.0

### Minor Changes

- Excel: fixed "there is no open session" being reported while a workbook was open. Excel does not
  reliably register its Application object with Windows, so a running Excel is now found through the
  open workbook instead. A failed connection also says which cause is likely rather than always
  telling you to open Excel first.

  New: `excel_open_workbook` opens a workbook by full path, starting Excel if it is not running. It
  opens read-only and with macros disabled, so investigating a file changes nothing and runs nothing.

## 0.29.0

### Minor Changes

- Excel: tracing a cell now follows blocks rather than individual cells, so investigating a formula
  over a large range finishes in about a second instead of timing out. A range feeding a formula is
  summarised — how many cells, how many numeric, and which cells are in error by address — which is
  usually the answer being looked for. Cross-sheet range references are followed too; previously only
  single-cell cross-sheet references were.

## 0.28.0

### Minor Changes

- Every tool can have its own timeout, and every tool is actually held to one.

  Settings → Tools now has a timeout box on each tool's row — built-in, MCP, Python, Excel and
  Outlook alike. It shows the number that will actually apply, and colours it only when that number
  came from the tool itself, so "120 because the server says so" and "120 because I set it here" are
  visibly different states.

  The limit is enforced in the agent loop rather than by each kind of tool. That is what makes it
  universal: a built-in tool had no timeout at all before, and anything added later would have had
  none either. It **aborts the tool's signal** rather than just giving up on the wait — walking away
  leaves ripgrep still scanning and the command still writing files — and what cannot be cancelled
  is at least bounded, with a result that says the work has not been undone rather than implying it
  has.

  Resolution is most-specific-first: the tool's own limit, then its server's, then the global one.
  An MCP tool's limit stays inside its server's entry, where a config pasted from another client
  puts it; everything else goes to a single store. One box either way.

## 0.27.0

### Minor Changes

- Excel reads stop timing out, and one timeout setting covers every tool.

  Reading a range asked each cell for its address, text, formula and value — four cross-process
  calls per cell. Measured against a real workbook: 400 cells took 2.2 seconds, while fetching the
  same block as array properties took 7 milliseconds. **315 times slower**, and at the cell cap it
  ran past the timeout entirely. It was reported as Excel timing out and "might be busy"; Excel was
  neither, it was being asked eight thousand questions one at a time. 720 cells now take 197ms.

  `Text` — the formatted string you see in the cell — has no array equivalent, so it is still read
  per cell for a small range and derived from the value beyond one. The result says which happened,
  because a currency column quietly losing its currency is worth being told about rather than
  noticing later.

  There is also now a single **tool timeout** in Settings → Tools, applying to MCP servers, Python
  tools and the Excel and Outlook tools alike, and to anything added later. It is a fallback: a
  timeout set on a particular tool or server still wins. "Everything on this machine is slow" is a
  property of the environment rather than of any one tool, and until now the only way to say it was
  to set the same number in three separate places.

## 0.26.0

### Minor Changes

- The browser UI can be told to be dark, rather than only inferring it.

  Dark mode existed and followed `prefers-color-scheme` — which follows the **browser's** appearance
  setting, not the operating system's. A corporate Edge pinned to light therefore shows a light UI
  on a dark Windows, with no way to change it and no clue why. Reported from exactly that situation.

  Appearance now offers System, Light and Dark in the browser, remembered in config and mirrored to
  local storage so a reload paints correctly on the first frame instead of flashing light while the
  connection opens. The choice is absent inside VS Code, where the editor's theme is the answer and
  a second control would fight it.

  Fixing it turned up the recurring fault again: `settings` was constructed in two places and they
  had already drifted, so the theme was written to disk and reported back as unset. There is one
  constructor now, as there is for host capabilities and the expert message.

## 0.25.0

### Minor Changes

- The Node host catches up with the extension, and two role gaps close.

  Everything built this week reaches the browser through shared core, but three things needed the
  host itself.

  **A report is shown, not pointed at.** `openDocument` said the content was "available in the task
  history" — which for a report written by an unattended run told the user it existed somewhere they
  could not reach. The host now shows the document, and can open a report by path, which is the
  whole point of writing it to a file.

  **Two messages defaulted to the wrong role on a shared server.** The verb rule catches
  `set*`/`save*`/`delete*` and lets everything else through, so `openStandingSkill` slipped past it
  — and on a shared server there is one workspace, so a skill marked `always: true` is prose
  injected into _every_ user's prompt on every request. That is what the review queue exists for.
  `measureExpertCost` slipped past too, spending the server's credit on two real consultations,
  while `clearExpertPricing` was already admin — the two exactly the wrong way round. Both are
  administrator-only now, and each is pinned by a test rather than left to the net.

## 0.24.0

### Minor Changes

- Per-project settings can now actually be set, not only hand-edited.

  The previous release added the mechanism and nothing that could reach it — which from the outside
  is the same as not having it. Each search connection now has a **Use in this project** button
  beside **Use in chat**, and the Search tab shows what this project has chosen for itself with a
  way to go back to your defaults.

  Two buttons rather than a button and a checkbox: "use this" and "use this here" are two different
  acts, and a checkbox that silently changes what a neighbouring button does is the kind of control
  people get wrong once and then distrust.

  What this project has overridden is listed rather than implied. A value that quietly differs here
  from everywhere else, with nothing saying so, leaves someone wondering why the same product
  behaves differently in two folders — and a setting that cannot be seen cannot be undone.

## 0.23.0

### Minor Changes

- 6c193e2: Settings can differ per project, without a repository being able to set them.

  Opening a second codebase on one machine meant it shared the first one's vector store, model,
  Python environment and read roots. Those are user-scope-only under invariant 5 — but that rule is
  about **who writes a value**, not about whether it may vary by project. `approvals` has always
  made exactly that split: scoped per workspace, stored user-side, keyed by path. This generalises
  it.

  A project may now differ on: which model answers, which model writes tool source, which vector
  store it indexes into, its mode, its step cap, its documentation index, its embedder index name,
  its Python paths, its read roots and `@` exclusions, and its skill folders. Everything else —
  provider list, credentials, TLS, the Office toggles, the expert — stays machine-wide, deliberately,
  and the list is an allow list so a key added later defaults to global rather than silently gaining
  a dimension nobody designed.

  **Schedules are now bound to the project they were written in.** They were a single global list,
  so a schedule written against one codebase fired against whichever happened to be open — running
  its prompt, with its granted tools, against the wrong repository. For a schedule granted editing
  that is not a scoping gap but a hazard. Schedules written before this keep firing anywhere, since
  silently binding them to whatever was open at upgrade time would have stopped them with no
  explanation.

- Scheduled runs write reports that survive the notification, and cannot run twice at once.

  A run that produced findings put them in a notification and an in-memory document. Both are gone
  by morning — which is precisely when an unattended run gets read — so the report now goes to a
  file, the toast offers to open that file, and the run log in the Schedules tab keeps a **Report**
  button pointing at it. Unattended runs are also told to use it: put the findings in `details` as
  Markdown, and make the one-line message say what happened rather than that something happened,
  because that line is all that appears on screen.

  **A schedule can no longer run twice because two windows are open.** Each window has its own
  timer and its own view of a schedule being due, so on one project both would run it, at the same
  moment, against the same files. A run now claims its schedule first, with a file created
  exclusively — one atomic filesystem operation, so two windows racing cannot both win. A claim
  left behind by a window that crashed is taken over after an hour: a nightly job that stops
  silently for ever is a worse failure than an occasional double run. Pressing Run by hand is never
  blocked, since that is an instruction from someone who can see what they are doing.

## 0.22.0

### Minor Changes

- A timeout per MCP tool, not just per server.

  A server's timeout is one number for everything it exposes, which is the wrong shape for the
  usual server: twenty quick lookups and one report that takes four minutes. Raising the
  server-wide limit to suit the slow one means a genuinely hung quick call now hangs for four
  minutes too — the limit stops doing the job it was there for.

  Each tool in the MCP tab has its own box beside its Always/Ask/Never control. Blank means the
  server's timeout, which means nothing changes unless you set one. Most specific wins: the
  tool's own limit, then the server's, then the SDK's default.

  Keyed by the bare tool name, matching `disabledTools`, so both halves of a server's per-tool
  configuration are keyed the same way and a namespaced name pasted in does not silently fail to
  match. The value is committed on blur rather than per keystroke — typing "120" would otherwise
  save 1, then 12, then 120, and the middle ones are real settings that briefly applied.

## 0.21.0

### Minor Changes

- Emails keep their colours.

  `MailItem.Body` is the plain-text rendering and discards every bit of formatting — which in work
  email is frequently the message itself. The red line is the failure, the highlighted cell is the
  one that changed, the struck-through row is the one to ignore. Flattened, they all read the same
  and there is no way to tell which one the sender was pointing at.

  Handing over the HTML instead would have been worse: an Outlook body is thousands of tokens of
  conditional comments, `mso-` declarations and nested layout tables, and the text would drown in
  it. So the text is extracted as text and formatting is added back **only where it departs from
  the default** — `[red: FAILED]`, `[highlight yellow: 42]`, bold, struck through. An ordinary
  message reads exactly as it did before; one that used colour to mean something now says so, and
  the colours used are listed once at the top so the notation explains itself.

  Colours are named rather than left as hex, matched on the worst channel rather than summed
  distance — the first version called a brown "grey", and naming a colour something it plainly is
  not defeats the point.

## 0.20.3

### Patch Changes

- Outlook folder listing no longer times out on a corporate mailbox, and separate reindex buttons.

  Reported from real use: `outlook_folders` failed twice, and the assistant confidently
  explained that Outlook must be showing a dialog — which it was not. The cause was the previous
  release's recursive walk reading each folder's item count. On a cached mailbox that is instant;
  on Exchange in online mode it is a server round trip _per folder_, and a few hundred folders
  runs past the timeout. Counts are now opt-in, the walk goes two levels by default, and it is
  capped and says so when it truncates.

  The timeout message offered a guess as fact. It now lists causes in order of likelihood, leads
  with the one that actually happened, and tells the assistant not to claim a dialog is open
  unless the user can see one. A confident wrong diagnosis costs someone a search as well as the
  failure.

  Tools and skills can also be reindexed separately, from where each of them changes: the Skills
  tab reindexes skills, the MCP tab reindexes tool documentation, and the Search tab does either
  or both. A partial run sweeps only its own kind — without that, reindexing tools would have
  deleted every skill in the store, silently.

## 0.20.2

### Patch Changes

- The expert budget is in the header in every mode, not only Junior.

  `ask_expert` is in the read group, so Code mode can consult and can spend — but the ceiling
  appeared only in Junior mode, or elsewhere once money had already gone. That was the wrong way
  round: it was hidden precisely while it was still worth setting, and became visible only after
  the first consultation had run under whatever default happened to apply.

  It starts from the limit saved in the Expert tab, and changing it in the header saves it as the
  new default, so the two agree rather than drifting.

## 0.20.1

### Patch Changes

- Telling the assistant which VBA line fails now actually helps it.

  `excel_read_macro` returned an unnumbered blob, so "it fails on line 47" meant the model had
  to count lines — which it does badly, and being confidently wrong about _which_ line failed is
  worse than not knowing. The source comes back numbered, in the VBA editor's own numbering, and
  `aroundLine` shows that part of the module with the line marked. A line past the end of the
  module says so, because that usually means the failure is in a different one.

  `excel_check_macro` takes `aroundLine` too: it quotes the line back — so a numbering mismatch
  is visible at once — and lists findings nearest it first. Ranked rather than filtered, because
  the cause is often nowhere near the symptom: a swallowed error thirty lines earlier is exactly
  the sort of thing that makes a later line fail quietly.

## 0.20.0

### Minor Changes

- VBA debugging, with nothing changed unless you approve it.

  `excel_check_macro` reads a module for the faults visible without running it — missing
  `Option Explicit`, an `On Error Resume Next` that never gets turned off, unclosed blocks,
  error handlers jumping to labels that do not exist, and references to sheets the workbook no
  longer has. It changes nothing and reports _every_ fault it finds rather than stopping at the
  first, which is what running does. A renamed tab is the commonest way a working macro starts
  failing, and VBA's own error for it — "subscript out of range" — names nothing at all.

  `excel_evaluate` works out what a formula would return, in the workbook's own context, without
  writing it into any cell. Testing a fix by putting it in a spare cell is a modification nobody
  asked for.

  `excel_run_macro` executes a macro and reports its result or the VBA error, and can snapshot a
  range before and after to show exactly which cells moved. It always asks first — no
  auto-approve setting reaches it, and it is never available to a scheduled run — and the prompt
  shows **the source that will actually run**, not the macro's name, because "run DoTheThing"
  tells you nothing about what you are agreeing to.

  What this cannot do, stated plainly: COM cannot drive the VBA debugger, so there are no
  breakpoints, no stepping, and no reading of locals while stopped.

  Two faults found by running it against real Excel rather than reasoning about it. An Excel
  error value arrives over COM as a signed integer — `#N/A` is -2146826246 — which reads as a
  number a formula produced; those are translated back now. And with the Trust Center setting
  off, `VBProject` returns null rather than throwing, so every caller was reporting "this
  workbook contains no VBA modules" when the truth was that access was blocked. It now names
  the exact setting to change.

## 0.19.0

### Minor Changes

- Tool calls say what they are for, and the standing-instructions skill has a home in the UI.

  The transcript showed a bare tool name and nothing else — a list of verbs with no account of
  what any of them was for. Assistant text alongside a tool call would have carried that, but
  most models emit none, and asking for prose beforehand fails in exactly the cases where it
  matters. Every tool now advertises an optional `why`: one sentence, shown beside the name in
  the collapsed row. It is added in one place so built-ins, MCP servers and Python tools all
  get it identically, and stripped before the tool runs, so a server never sees a property it
  did not declare.

  A side effect worth knowing: `why` is a fixed cost per _advertised_ tool, so hiding tools now
  saves that cost too and the dispatcher pays for itself on smaller catalogues than before.
  The test that measured the old break-even records the change rather than being re-baselined.

  The `always: true` skill shipped without any way to see or create one, which made a feature
  paid for on every request invisible and hand-edit-only. The Skills tab now names the skill
  that is included in every session, or offers to create it from a template with the frontmatter
  already correct.

## 0.18.1

### Patch Changes

- Outlook: sub-folders are listable, and "the last two hours" is one argument.

  Folder listing stopped at the top level, so a message filed under `Inbox\Projects\Acme` was
  reachable by path but impossible to _discover_ — the tool could already walk a nested path,
  nothing would ever show you one existed. It now walks the tree, indented by depth, with the
  full path on every line, because a nested name on its own is not something you can pass back.

  `outlook_search` takes `withinMinutes`, which is how people actually ask: 50 for the last
  fifty minutes, 120 for two hours. It is computed against this machine's clock — the clock
  Outlook stamped the mail with — and wins over an absolute `since` when both are given.

## 0.18.0

### Minor Changes

- Excel and Outlook, opt-in and off by default.

  The assistant can attach to the Office applications **already running** on this machine —
  not to a file on disk, which is the point: the question people have is about the workbook
  they are looking at, with unsaved edits, mid-investigation.

  Excel: list the open workbooks, read cells with their values and formulas, read or replace
  VBA modules, and **trace a cell back to what produces it** — following the formula chain
  across sheets until it reaches raw input, which is how you find the cell that is actually
  zero behind a `#DIV/0!` three sheets away.

  Outlook: search and read mail. Read-only — nothing can send, reply, delete or move.

  Windows only, because it uses COM to attach to a live application and that exists nowhere
  else; the tools are absent on other platforms rather than present and failing. Nothing is
  started, spawned or read until one of the two toggles is switched on in Settings → Tools,
  and neither can be enabled by a workspace: the setting is user-scope only, since a
  repository able to set it would read your mail the moment you opened the folder.

  Neither will _launch_ an application that is closed. Starting Outlook from COM takes a
  minute and can put a profile dialog on screen where nobody is expecting one, so it says to
  open it instead. Replacing a macro always asks and shows the code — it is code that runs on
  your machine as you — and the workbook is left unsaved so you can run it before keeping it.

## 0.17.0

### Minor Changes

- Five fixes from daily use, and three things that were missing.

  **The `@` picker was asking the wrong question.** A glob's `*` does not cross a path
  separator, so typing `src/api` matched almost nothing — the picker went emptiest exactly
  when you were being most specific. It now globs the last segment and judges the whole path
  in code, matching letters in order rather than as a contiguous run, so `mrank` finds
  `mentionRanking.ts`.

  **The mention highlight moved out of the input.** Painting colour inside the box meant two
  independently laid-out layers over each other, and they stopped agreeing: the caret sat
  behind the last character typed. Mentions are listed as chips under the message instead —
  nothing there can touch the caret, and a long prompt's attachments are still countable at
  a glance.

  **A skill added by hand appears immediately.** The watcher could not watch a folder that
  did not exist yet, which is exactly the moment a first skill is added; the parent is
  watched too now.

  **The expert budget set from the chat header is kept.** It expired with the conversation,
  which read as the setting being forgotten.

  **Editing MCP servers as JSON works, and gained a timeout.** Unknown keys were silently
  dropped, so a pasted `timeout` vanished and the save appeared to do nothing. There is now a
  real per-server timeout — in the form and in the config — and anything else dropped is
  reported rather than discarded in silence.

  **Junior mode consults on its own.** The guidance said "consult once, at the start", which
  a capable model reads as permission to decide it does not need to. Consulting is now the
  default action with the exceptions named, so the mode stops behaving like Code mode with a
  larger bill.

  **`recall_expert_advice`** returns advice already given in this task, free, so a plan lost
  to an error is recovered rather than bought twice.

  **A skill marked `always: true` in its frontmatter goes into every session in full** — the
  standing instructions a workspace wants followed without being asked.

  **`list_files` and `search_files` can reach ignored folders.** Both go through ripgrep,
  which honours `.gitignore`, so `.venv` came back empty with no hint that a rule had been
  applied. `includeIgnored` reaches in, and an empty result now says why it might be empty.

## 0.16.0

### Minor Changes

- The Expert tab shows what Junior mode has avoided — today, over thirty days, and all time.

  Every figure is a floor rather than an estimate, and the panel says so. Two things are
  counted, both priced from the measurement taken on this machine rather than from published
  rates: turns the cheap model handled alone, each priced at the cheapest an expert turn can
  possibly be, and cold starts that resuming a live session avoided.

  What is deliberately not counted is what the strong model would have charged to do the work
  itself — nothing can know that, so no multiplier is applied. The working is on the page,
  because a number about money whose derivation is hidden is one nobody can check.

  Before a consultation has been priced the panel shows a dash, not a zero: with nothing
  measured the honest answer is "unknown", where zero would read as "this saved you nothing".

## 0.15.0

### Minor Changes

- Scheduled runs can find out what exists, and whether they may use it.

  A schedule's tools are an allowlist, which left an unattended run unable to look anything up.
  Looking things up is
  now always available: searching the documentation, the dispatcher itself, and re-reading a
  result this same run had truncated. None of those reaches the workspace, the network or a
  process, so nothing is widened by it — the inner call a dispatched tool stands for is still
  checked against the allowlist exactly as if it had been named.

  A search result for a tool the run may not call now says so, rather than leaving it to find
  out by being refused. It can report what it needed and who should tick it.

  Schedules can also search for skills, unless the schedule named a specific set — in which
  case listing them is how that choice is honoured.

## 0.14.0

### Minor Changes

- A form the assistant can ask with, and the config file no longer corrupts.

  The assistant can now ask for structured input instead of a sentence: string, number, yes/no
  and one-of-a-set fields, rendered as ordinary controls in the transcript. The turn continues
  with the answers, so it does not have to describe four values in prose and read them back out
  of prose — the step where the wrong value looks exactly like the right one. Available to
  anything the assistant is doing, not only to skills, and it grants nothing: acting on what it
  learns still goes through approval.

  **Settings could be destroyed by an ordinary save.** The config file was written straight over
  itself and read-modify-written without serialising, so two saves at once could lose one of them
  or leave the file half-written — after which every read failed and the provider, the approvals
  and the expert all appeared to vanish at once, repairable only by editing JSON by hand. Writes
  are now atomic, saves are serialised, and a file that will not parse is restored from the last
  good copy with the damaged one kept beside it.

  Skills kept as a folder with `SKILL.md` inside — the layout Claude uses — are now loaded, where
  before a whole folder of them was invisible with no error to notice.

  The `@` picker asked the file index for thirty matches and showed those thirty, so in a large
  repository the truncation decided what you saw rather than the query. It now searches widely and
  ranks: a file named for what you typed comes before files merely inside a folder of that name.
  Mentions are also coloured in the composer, so the attachments in a long prompt can be counted
  at a glance.

  Approvals are found whatever case the workspace path arrives in, so "always allow" is no longer
  forgotten between sessions on Windows.

## 0.13.0

### Minor Changes

- Tools are found on their own again, and three things from daily use that read as breakage.

  The dispatcher defaults to on, but two checks still tested the old default directly. Tools were
  hidden from the prompt by one code path while the documentation index was never built by another,
  so searching for a tool could only match names — which is what "I have to tell it which tool to
  use" looks like from the outside. The Tools tab reported the dispatcher off at the same time,
  which is how the two halves managed to disagree unnoticed.

  The `@` picker listed every file in `.venv`. Naming one folder to exclude silently turned off
  every folder already hidden in the editor's own settings, because an explicit exclude replaces
  that list rather than adding to it. There is now a folder list of its own, defaulting to the usual
  build and virtualenv folders.

  A skill added by hand did not appear until the panel was reopened. The skill folders are watched
  now.

  Tool documentation can be reindexed from the MCP tab, where you are when you add a server, rather
  than only from Settings → Search.

## 0.12.2

### Patch Changes

- The cost measurement now checks that its second sample actually resumed.

  If the Claude CLI returns no session id, the resume is silently skipped and both samples are cold
  starts — reported as "cold" and "resumed" with a ratio read off them. That is worse than no
  measurement, because the conclusion drawn from it is that caching saves nothing here, which is
  exactly wrong.

  It records whether the resume happened and says so plainly when it did not, rather than presenting
  two cold starts as a comparison.

## 0.12.1

### Patch Changes

- The measured consultation price now actually appears in the Expert tab.

  The measurement was working — the log said so and the value was saved — but the panel showed
  nothing. The message reached the browser and was then unpacked field by field, by name, so every
  field added since that code was written was dropped on the last hop: the price, whether the plan
  reports a cost, the measuring step, the keep-alive setting.

  It assigns the message whole now, and a type-level test fails the next time the two diverge.

## 0.12.0

### Minor Changes

- **Keep the expert's session warm**, so a break does not cost a cold start.

  The cache lasts an hour, and that is Anthropic's limit rather than ours. With this on, a task with
  an open expert session sends one trivial resumed consultation every fifty minutes — about a
  fiftieth of the cold start it avoids.

  Off by default and it stays that way: it spends with nobody at the screen. **Its cost is counted in
  the meter**, so nothing is spent that you cannot see. It is deliberately not counted as a
  consultation, because a long task must not spend its consultation allowance on automated pings and
  then refuse the expert when the work needs it.

  It only ever refreshes a session a real consultation created, stops the moment the budget is spent,
  and stops when the task ends.

  Also fixes the measured price not appearing after measuring it: two places built the expert message
  and only one of them carried it. They share one construction now.

## 0.11.0

### Minor Changes

- **Measure what a consultation costs on your plan**, from the Expert tab.

  The published figures — a cold consultation costing about nineteen times a resumed one — came from
  one plan on one day. An enterprise agreement, a subscription or a gateway can report something
  different, or nothing at all, and those numbers are what the budget is set from and what the expert
  is told when it plans to fit.

  The button makes **two real consultations**, one cold and one resumed, and says so before it spends
  anything: one sample cannot show the ratio, and the ratio is the number that actually matters. The
  result is stored, shown with the date it was measured, and sent to the expert with the budget so it
  plans in your units rather than from what it believes consultations cost in general.

## 0.10.2

### Patch Changes

- The Expert tab says whether your plan's spending limit can actually apply.

  The cost shown per consultation is whatever the Claude CLI reports in `total_cost_usd`. Some plans
  report nothing there — and then the spending limit can never be reached, because the running total
  stays at zero. A cap that silently never fires is worse than no cap, because it is believed.

  This is now learned from real consultations rather than asked for: probing would mean making a
  call, and the first call in a session is the expensive one. After one consultation the panel either
  says nothing, or says plainly that the spend cap cannot bind and to use the consultation limit,
  which is checked first and works on any plan.

## 0.10.1

### Patch Changes

- The programming provider is offered by the host, not assumed by the panel.

  Nominating a different model to write Python tool source is a shared-server idea, and the picker
  was reaching the VS Code extension because it was passed unconditionally. A host now declares the
  capability and only this one does — the same rule the Variables and Review tabs already followed.

  The check is in the bridge as well as the panel, because the tool's _parameters_ change shape when
  a generator exists: without it, a hand-edited config would make the extension ask for a
  specification instead of source with nothing in the panel to explain why.

## 0.10.0

### Minor Changes

- `--guide` opens the operator guide as a page instead of printing markdown.

  A guide is something you read, and a wall of markdown in a console is the format people were
  trying to get away from. It renders to a self-contained HTML file and opens it with the OS
  handler — no port, no process left running, and no network at all, which matters because the
  deployment this guide is written for is often airgapped.

  `--guide --no-open` still prints, which is the right answer over SSH and when piping into a pager.

## 0.9.0

### Minor Changes

- Python tools and skills written by a non-administrator go to a review queue.

  The in-chat approval gate assumes the approver is present, which is false on a shared server: the
  person who may approve is not the person asking. So the work is staged, the author's turn is told
  and carries on, and an administrator reads the source in Settings → **Review**.

  Nothing is written where the workspace can see it until it is approved — the bytes live in the
  queue, which is §13's own rule (the registry is the boundary, and a file with no registry entry
  never loads) rather than a second mechanism beside it. A rejection leaves nothing behind, and an
  approval writes the bytes that were read rather than whatever is on disk by then.

  Rejections take a reason and the author sees it. Resubmitting the same name replaces the pending
  item rather than queueing a second copy. Administrators keep the ordinary in-chat prompt.

  MCP server configuration is pinned admin-only by name, alongside Python, search and schedules.

## 0.8.0

### Minor Changes

- A model chosen for code can write Python tool source.

  Set `programmingProfileId` to one of your provider profiles and `create_python_tool` changes
  shape: the chat model sends a _specification_ of what the tool must do, and the named profile
  writes the file. A cheap model is good at deciding a tool is needed and describing it, and much
  worse at writing it.

  Nothing about approval changes. The prompt shows a real diff of the bytes that will be written —
  now with a line saying which profile produced them, because source a second model wrote is judged
  differently from source the assistant you are talking to wrote — and the approved text is what
  gets hashed into the registry.

  Absent, which is the default, the chat model writes the source exactly as it always has, down to
  the shape of the tool's parameters.

## 0.7.0

### Minor Changes

- Users bring their own provider profiles and API keys.

  Profiles were admin-only in shared mode. That was a blanket rule which treated a second user as
  the same threat as a hostile repository — but the threat that reasoning is about is one user
  repointing _another's_ gateway, and a per-user profile cannot do that. Everyone can now add their
  own profiles, set their own keys, choose which to use, and run Test connection against them.

  Administrators can publish a **shared** set in `shared.json`, with a `defaultProfileId` that
  applies to anyone who has not chosen. Those appear in every user's list marked **provided**, with
  no Edit and no Delete — a user's file never stores them, so an edit would silently vanish on the
  next save. Duplicate is offered instead, which is how someone starts from the organisation's
  gateway and points a copy at their own key.

  A shared profile's key lives in `shared-secrets.json` rather than in whichever user happened to
  save it, so it survives one user clearing their own secrets.

## 0.6.0

### Minor Changes

- `light-code --guide` prints the operator guide.

  Setting up shared mode, the flags, who can change what, session variables, and what it
  deliberately does not protect against — the same document as `docs/hosting.md`, baked into the
  bundle so it exists in a published install where there is no `docs/` directory to read.

  Printed rather than opened in a browser: this is read while standing a server up, often over SSH
  on a box that has no browser, and it pipes into a pager cleanly.

  Shared mode's startup banner now prints both URLs instead of a handoff link with an empty token —
  there is no handoff in shared mode, and instructions for a mechanism that is not running send
  people looking for a token that was never minted.

## 0.5.0

### Minor Changes

- A Variables tab, and user variables moved out of `config.json`.

  Both scopes in one panel: your own, and the administrator's that apply to everyone. Where a name
  collides the administrator's wins, and the row says so and shows the value that is actually in
  force — a user editing an overridden variable would otherwise change something that never takes
  effect with nothing to indicate it.

  The panel says, where a value is typed, that these are **not secret**: everything a session runs
  does so as the server's account, so another user's assistant can read them. API keys belong in
  Providers.

  Administrators can edit the administrator list from the interface, so adding a colleague no longer
  means a restart. `--admin-id` still wins at startup, which is the way back for someone who removes
  themselves.

  Fixes a data-loss bug before it shipped: user variables were kept in `config.json`, and the config
  schema strips keys it does not know — so they would have survived until the first unrelated save
  and then vanished silently. They now live in `variables.json`, and a test asserts the stripping so
  the reason is visible rather than a claim in a comment.

## 0.4.0

### Minor Changes

- Real users, and an administrator's URL. Node host only — the extension is untouched.

  `ProxyHeaderIdentity` reads the user from a header your reverse proxy sets, and believes it only
  from an address you name with `--trust-proxy`. The header is not the trust boundary: anything
  that can reach the port can type one, so the check is on the socket's peer address, which a
  client cannot choose. With no trusted proxy configured every request is refused — a deployment
  that refuses everyone is a support call, one that believes everyone is a breach.

  `/admin` serves the administrator's interface and `/` serves everyone's. Reaching `/admin` is
  assumed to be restricted upstream; the admin id list still decides who is actually treated as one.

  `--admin` is now a boolean that opens the admin URL. The old `--admin <id>` form is an **error**
  naming `--admin-id`, not silently reinterpreted — it would otherwise name nobody and open admin
  mode instead.

## 0.3.0

### Minor Changes

- First-run guide in the browser.

  `npx light-code` opened on an empty chat with no provider, no onboarding, and nothing to say that
  eleven settings tabs existed — VS Code had a fourteen-step tour and the browser had none of it.
  The tour now renders in-app, one step at a time, and each step about a settings tab has a button
  that opens it.

  The content is shared with the extension (`GUIDE_STEPS` in core) so the two cannot drift; only the
  rendering differs. The diagrams are served from this origin under `/guide`, from a fixed table
  derived from the step list rather than from the request path.

  Also fixes the `files` glob, which listed `.js`, `.html` and `.css` — so the diagrams were built,
  copied and served locally, and then left out of the published tarball. Every install from npm
  would have shown broken images. `pnpm verify:npm` now checks the packaged tarball for them, and
  that check was verified to fail without the fix.
