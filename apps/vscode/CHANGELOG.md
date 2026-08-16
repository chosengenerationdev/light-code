# light-code-vscode

## 0.29.0

### Minor Changes

- The Python tab now shows what is saved, and lets you choose the environment.

  **Settings looked as though they were not persisting.** They were — the tab simply never
  received them. It was sent the *resolved* status (which interpreter won, which tools loaded)
  and used that only for placeholders, so every field rendered empty on each mount. A saved
  value looked lost, and saving again from those empty boxes would quietly have cleared it. The
  saved settings are now sent alongside the status and every field is resynced from them.

  **You can choose the Python environment.** `venvPath` existed in the config schema and had no
  control anywhere, so "which Python is this actually using?" was answerable only by reading the
  status line and unanswerable if you disagreed with it. There is now a field, with Browse:
  leave it blank to prefer the project's own `.venv`, or give a venv folder or a `python.exe`
  directly.

## 0.28.2

### Patch Changes

- The global CA covers the new vector backends too — verified rather than assumed.

  Qdrant and Chroma already inherited the CA from Settings → Network, because they share the
  connection builder OpenSearch uses. That is now pinned by a test asserting each backend sends
  the resolved TLS material on *every* request, not merely the first — a client that
  authenticated over TLS and then queried without it would be worse than one that never used it.

  The builder was still called `openSearchConnectionFor`, which was accurate with one backend
  and a lie with three: exactly the sort of name that has someone add a second, subtly different
  one rather than reuse it.

## 0.28.1

### Patch Changes

- The result of a hand-run search can be dismissed.

  Settings → Search shows the answer to a query you run yourself, and it stayed until something
  replaced it — which meant scrolling past an answer you had finished with to reach the log
  below. There is now a **Clear result** on the result itself, naming the query it belongs to.

  Separate from the Clear on the recent-searches log, deliberately: dismissing an answer should
  not erase the record of having asked.

## 0.28.0

### Minor Changes

- Creating a tool or a skill always asks, and approval diffs are syntax highlighted.

  **Auto-approve can no longer cover writing a Python tool or a skill.** These are the one place
  the assistant writes code that later *runs*, or prose that is later injected into its own
  context — and auto-approving their creation compounds, because an injected instruction could
  install a persistent capability that the same setting then approves on every later call.
  "Auto-approve edits" is a statement about editing the files you are working on, not about
  granting new abilities, and reading it as the latter is a grant nobody knowingly made.

  Creating, updating and deleting a Python tool, and writing or deleting a skill, now always
  show you the source first — whatever the toggles say, and even if the tool is on the
  always-allow list. Nothing the assistant can do is restricted; a human just sees it once.

  **Approval diffs are syntax highlighted**, in whatever language the file's extension implies.
  Added and removed are still carried by the row background and the gutter marker, so the
  colours do not fight — this is the view you read to decide whether an edit is safe, and a wall
  of monochrome is where a stray line hides.

## 0.27.1

### Patch Changes

- Three fixes from real use.

  **A new file's diff showed one line as unchanged.** Splitting an empty string yields one empty
  line rather than none, and that phantom line was matched against the first blank line in the
  new content and reported as context — numbered against a file that does not exist, which made
  the numbering look like a line had been skipped. The approval view is what you read to decide
  whether an edit is safe, so a row claiming a line was already there is the prompt getting
  ground truth wrong.

  **A finished assessment could vanish from the Expert tab.** It was saved correctly; the final
  refresh re-probed for the Claude CLI, and if that probe failed it reported the expert as
  disabled with no assessment — a claim about your configuration based on a failed process
  spawn. The refresh no longer re-probes when the CLI has just been used, and a failed probe now
  reports only availability as unknown instead of wiping everything.

  **Asking for a "tool" wrote a plain script.** Both `create_python_tool` and `write_to_file`
  write Python to disk, and only one registers it as callable — so the descriptions now say
  which is which, from both sides.

## 0.27.0

### Minor Changes

- The expert estimates what a task will cost, and can assess the model it works with.

  **An estimate, before you set the budget.** The expert is the only participant that knows the
  shape of the work before it starts — it has just read the code and decided how many
  checkpoints there are. So it now ends its plan with an estimate of the whole task, and the
  budget control shows it with a **Use it** button that fills in the fields with a little
  headroom. It rides along with the plan and costs nothing extra.

  It is labelled as an estimate and kept visually apart from the spend beside it, because one is
  a model guessing about its own future behaviour and the other is a measurement.

  **A skill assessment of the junior**, in Settings → Expert. The junior answers five short
  probes — following an exact format, admitting it does not know something, writing a small
  function, finding a bug, noticing a contradiction — and the expert grades the actual answers.

  Deliberately not "ask Claude what it thinks of that model name": that would be a recollection
  from training data that may predate the release or describe a different quantisation, and
  would say nothing about your deployment, where a gateway's own prompt and context limit change
  the behaviour anyway. Grading real answers makes the judgement falsifiable — and the answers
  are kept and shown, so you can judge the judgement.

  The verdict is given back to the expert on later tasks, so its plans are sized to what your
  model can actually do. It costs one consultation, which is counted in the meter like any
  other, and it is a button rather than something that happens on its own.

## 0.26.0

### Minor Changes

- Local vector storage with Qdrant and Chroma, and syntax highlighting everywhere.

  **Semantic search no longer needs a cluster.** Point Light Code at a Qdrant or Chroma
  container on your own machine and your code is embedded and stored locally — nothing about
  the codebase leaves except what goes to the embedding endpoint you configured. Settings →
  Search now asks which backend you are using and suggests the usual local address, with the
  `docker run` line if you have not started one yet.

  Both are hand-written REST clients rather than vendor SDKs, so every byte still leaves through
  the one HTTP client that mutual TLS, corporate CAs and proxy settings are wired into. Both
  refuse to write to a collection Light Code did not create, exactly as the OpenSearch writer
  does, so a mistyped name cannot overwrite somebody else's vectors.

  OpenSearch keeps one capability the others cannot have: querying indexes your organisation
  already runs, with raw query DSL. That tool is simply absent when a local backend is active
  rather than present and broken.

  **Code in replies is syntax highlighted**, in any language — including ones it has never heard
  of, which fall back to a profile that recognises every common comment and string syntax. Done
  without a highlighting library: the alternatives are the largest thing in the bundle and, since
  VS Code does not expose its grammar colours to a webview, would have arrived with a theme of
  their own and looked wrong beside the editor. Colours come from the theme instead.

## 0.25.0

### Minor Changes

- Network paths the assistant mangled now work, plus a proper view of tools and skills.

  **Over-escaped Windows paths are repaired.** Asking for a file on a share could produce eight
  backslashes in the tool call, which collapses to four — and four is not a UNC prefix, so it
  was read as a drive-relative path and failed with `ENOENT` naming a `C:\` path you never
  mentioned. Models get this wrong often, the intent survives the mangling completely, and the
  collapsed forms are not valid paths in the first place, so they are now repaired rather than
  refused.

  **Tools and skills can be inspected, edited and removed.** Both tabs list what each one is
  and what it does, with **Open** to see the source in an editor tab, and **Delete**. A Python
  tool you edit by hand is refused on a hash mismatch — that is the pin working — so there is
  now an **Approve this version** button for the "yes, that was me" case. It runs the same
  validation a model-written tool gets, so a file that does not load cannot be approved.

  **Duplicate an MCP server or a schedule**, as you already could a provider profile. Copies
  start disabled or paused: a clone is made to be edited, and one that started running the
  moment it existed would run something nobody had finished writing.

  **The Python tab wears Python's own mark** instead of a terminal glyph.

  The marketplace listing has been rewritten — it was several releases out of date, still
  claiming nine tools and no semantic search.

## 0.24.2

### Patch Changes

- Settings could silently stop answering while a schedule was running.

  Scheduled runs were changed in 0.22.0 to stop writing into your conversation, and that was
  done by permitting only two kinds of message through while a run was in progress. Everything
  else was dropped — including replies to things you had just asked for. With a schedule firing
  every minute, opening Settings during a run meant the answer never arrived: the Expert tab sat
  on "Checking…", and pressing Re-check afterwards worked. That looked like broken CLI detection
  and was nothing of the kind; the answer was thrown away in transit.

  Only conversation traffic is held back now, and everything else is sent. The two failure modes
  are not symmetric: a stray transcript message during a background run is a cosmetic flicker,
  while a dropped reply is a control that never answers and gives no clue why.

## 0.24.1

### Patch Changes

- The Expert tab could stick on "Checking…" forever. Fixed, and made recoverable.

  Two faults, either of which was enough on its own. Detection waited on a child process to
  exit — and on Windows, killing the `.cmd` shim does not kill the program it launched, so a
  process holding its output open meant the check never returned. Separately, if working it out
  failed for any reason the result was simply never sent, with nothing logged, so the tab waited
  for an answer that was not coming.

  Detection now bounds the *wait* rather than trusting the process to die, and there is a budget
  for the whole search rather than only for each candidate — several candidates each waiting out
  their own timeout added up to most of a minute, which looks stuck whether or not it is. The
  state is now always reported, including when the check itself failed, and it says so.

  **The budget control only appears in Junior mode**, which is the mode built around consulting
  the expert. It still appears in other modes if a consultation has actually happened there, so
  a session that is spending money always has a way to adjust the ceiling it is about to hit.

  **A Re-check button**, always available, including while it says "Checking…". A program can
  hang however carefully it is bounded, so there has to be a way out short of reloading the
  window.

  **Browse to the executable.** When detection cannot find the CLI, pointing at the file always
  works, and beats trying to remember where npm put a shim. The field stays typeable for a path
  that is easier pasted than picked.

## 0.24.0

### Minor Changes

- Junior mode works in checkpoints, and the expert has a budget.

  **The expert now plans in checkpoints and reviews each one.** It splits the work into coherent
  slices, the assistant implements one, reports what it actually did, takes the feedback, and
  moves on — until the work is finished.

  This is a cost measure, not a quality ritual, and the guidance says so in those terms. The
  expensive failure was never a consultation; it was building the wrong thing for twenty turns
  and having the whole approach redone. Because consultations after the first continue one
  conversation, a review costs about as much as a cheap follow-up. The instructions are explicit
  that a checkpoint too small costs more to review than the mistake it could catch, that only
  the delta is reported rather than the context again, and that a mechanical checkpoint should
  skip its review entirely.

  **A per-task budget for the expert**, in Settings → Expert: stop after so many dollars, or so
  many consultations, whichever comes first. Both default to no limit. When one is reached the
  expert stops being offered and the assistant is told to finish alone rather than waiting for
  advice that is not coming; a new task resets it.

  **The budget is set from the chat header, beside the mode selector**, because choosing Junior
  mode and deciding what the expert may spend are the same thought. Raise the ceiling for a hard
  task without changing your default, or lower it for a cheap one — it takes effect on the very
  next consultation, with no need to start a new chat. Once a budget is spent the control reads
  "Raise budget" outright, since the moment you want more is the moment you have just been cut
  off. An override belongs to that conversation and is cleared when you start a new chat, so a
  raised ceiling cannot quietly outlive the task it was for.

  **The expert is told what is left, so it plans to fit.** Every consultation carries a one-line
  statement of the remaining budget. Without it the expert plans as though reviews were free and
  proposes eight checkpoints on a budget of three, and the assistant then loses it mid-plan —
  the worst moment for that to happen. It reports what remains rather than what has been used,
  because that is the number to plan against.

  The count limit is worth setting alongside a spend limit, because the CLI does not always
  report a price and an unpriced consultation still costs money. The cost meter in the chat now
  shows a small bar against the nearer limit, amber before the wall rather than only at it.

## 0.23.0

### Minor Changes

- PDFs can be read, and a PDF that cannot be read honestly says so.

  `read_document` now handles `.pdf` alongside Word, Excel and HTML — with no new dependency, so
  the download is unchanged. A real PDF library is several megabytes that every user pays for
  whether or not they ever open one.

  **It follows the fonts.** Every modern producer embeds subset fonts whose character codes mean
  nothing outside that one file, so the text is decoded through each font's own character map.
  Without that step a page printed from a browser comes back as complete nonsense.

  **And when it cannot decode a file, it refuses instead of guessing.** A PDF with no usable
  character map, a scan with no text layer, and an encrypted file are each reported by name with
  what to do about it. Garbled text would otherwise be summarised as though it were correct,
  which is a worse outcome than being told to export the file to Word or text first.

  Layout is approximate — a PDF stores positioned glyphs rather than paragraphs — but headings,
  paragraphs and list items come through as separate lines.

## 0.22.1

### Patch Changes

- Network shares are actually readable, and MCP tools appear in the schedule picker.

  **A folder that is itself a root matched nothing.** `path.resolve` leaves a trailing separator
  on a UNC share root and on a drive root, so the containment check appended a second one and no
  file was ever judged to be inside. Adding `\\server\share` under "Folders it may read" was
  therefore silently useless — the exact case the setting exists for — and the assistant, told the
  path lay outside the workspace, kept suggesting the file be copied in. Ordinary folders were
  unaffected, which is why it took a real share to notice. The comparison is now one exported
  function with tests against share and drive roots.

  **An unreachable share no longer throws a raw error.** Windows reports `UNKNOWN` rather than a
  missing-file code for a UNC host it cannot reach, which escaped as an unhandled failure from
  inside the tool. A mistyped server name now gets the ordinary sentence about the path.

  **MCP and Python tools appear in the schedule tool picker.** The picker is built from the live
  registry, but MCP servers connect a few seconds after the panel opens and the list was fetched
  once, on mount — so it captured an empty set and never heard again. It now refreshes whenever
  the tool catalogue changes.

## 0.22.0

### Minor Changes

- Schedules now actually fire, and folders can be approved from the chat.

  **The scheduler no longer dies with the panel.** Everything Light Code runs lived inside the
  chat view, so closing it — or simply never opening it after starting VS Code — took the
  schedule timer with it. That is why a schedule could sit there looking armed while nothing
  ran, yet Run Now worked: Run Now is only reachable from the panel that was keeping the timer
  alive. Light Code now loads with the window and keeps one scheduler for its lifetime; the
  chat view attaches to it and asks for the transcript back. Nothing is started until it is
  needed — the poller reads config and only builds the rest when a schedule is genuinely due.

  **The Schedules tab shows the scheduler's own state**, including when it last checked, with a
  Restart button. A schedule that quietly never fires used to look exactly like one that was not
  due yet.

  **Scheduled runs no longer touch your chat.** A run used to reset the one shared conversation,
  so a job firing while you were mid-conversation wiped your transcript. Your conversation is now
  set aside for the duration and handed back, the run sends nothing to the chat window, a
  schedule waits rather than interrupting a turn you are in the middle of, and a message you send
  during a run is held for the few seconds it takes rather than interleaved.

  **Run logs can be cleared** — one run at a time, a whole schedule's, or all of them.

  **Clear index** sits beside Index documentation in Settings → Search, emptying the tool and
  skill documentation index. `search_docs` falls back to matching names and descriptions until
  you index again.

  **The red "Not loaded" lists in the Python and Skills tabs can be dismissed.** A dismissal is
  remembered against the problems themselves, so a new failure — or the same one recurring after
  a fix — is always shown again.

  **The scheduler is watched, and revived if it stops.** It ticks every 15 seconds now rather
  than every minute — at a one-minute poll a one-minute schedule spends most of its life
  visibly overdue — and the extension checks in on it twice a minute, restarting it if it has
  gone quiet. A single run that wedges can no longer block every later one forever.

  **Notifications can carry a report.** A VS Code notification is one line of plain text — it
  cannot render a table or a colour, whoever sends it. So `notify` now takes an optional
  Markdown `details`, and the notification offers to open it as a document: tables, headings and
  code all render there. A warning-level notification also stays on screen until dismissed,
  where an info one fades.

  **Reading a file outside the workspace can be approved in the chat.** Rather than registering
  every share in Settings first, the assistant asks when it needs one, showing the resolved path.
  Allow it once, or allow the whole folder — which adds it to Settings → Approvals, where it can
  be removed. Certificates and keys on the deny list are never offered, writes are never offered,
  and a scheduled run is refused outright: nobody is there to answer, so an unattended run cannot
  widen its own access.

## 0.21.0

### Minor Changes

- Read files outside the workspace, and attach any kind of file.

  **Folders it may read.** Settings → Approvals now takes a list of folders outside the workspace
  that the assistant may read — a log directory, or a network share such as `\server\logs`. Logs
  on a share were simply unreachable before: everything was confined to the workspace, and on
  Windows a UNC path is not somewhere a workspace-relative path can ever go.

  Reading only. Edits stay confined to the workspace whatever is listed, because a checkpoint
  snapshots the workspace and an edit elsewhere could not be undone.

  **Attachments accept any file.** Attaching a certificate or a log used to be refused as "images
  only" — an artefact of attachments having been built for vision. An image is still sent to the
  model as an image; anything else is read as text and included in the message, named and fenced
  so it is clear where the file ends and your question begins. Attached files are listed above
  the composer and can be removed before sending.

## 0.20.1

### Patch Changes

- Schedules now actually fire, and each keeps a run log.

  **Scheduled prompts never ran on their own.** The check asking whether one was due compared the
  clock against "when does this next run?", and that question always answers with a moment in the
  future — so the answer was always "not yet", for every schedule, forever. Run Now worked because
  it skips the check entirely. A schedule now records when it is next due and the timer compares
  against that.

  Each schedule keeps its **last twenty runs** — when it ran, how long it took, whether it
  succeeded, and what it said. Click **Log** on any of them to open that run's full transcript,
  including its thinking and every tool call, **in an ordinary editor tab** rather than the
  sidebar. A transcript is a document, and an editor reads, scrolls and searches one far better
  than a panel a third the width.

## 0.20.0

### Minor Changes

- Replies are rendered as markdown.

  Code blocks, inline code, headings, lists, tables, quotes, links, bold and italic now display
  properly instead of arriving as raw asterisks and backticks. **Code blocks get a copy button**,
  which is the thing most often wanted out of a reply and the most awkward to select by hand in a
  narrow panel.

  Rendered without a markdown library, and without turning anything into HTML. The parser
  produces elements directly, so a reply containing markup shows those characters rather than
  being interpreted — a stronger guarantee than sanitising afterwards, and it adds nothing to the
  download.

  Your own messages are left exactly as typed. You can see what you wrote, and having your
  asterisks silently vanish would be surprising.

## 0.19.1

### Patch Changes

- `@` file mentions in a schedule's prompt, and the always-available tools are visible.

  Typing `@` in a schedule prompt now offers the same file picker the chat composer has. The
  mentions always _worked_ — a scheduled prompt goes through the same path a typed one does, and
  the file contents are attached when the schedule runs — but you had to know and type the path
  exactly, and a typo silently became ordinary prose.

  The tool list also now shows what every schedule can do regardless of what you tick: `notify`
  and finishing. They were left out because ticking them changes nothing, which was true and
  left no way to tell whether a schedule could notify you at all.

## 0.19.0

### Minor Changes

- Scheduled prompts, and notifications.

  A new **Schedules** tab runs a prompt on its own — every hour, daily at a time, or on chosen
  weekdays — and leaves a normal task you can read afterwards.

  **You choose exactly which tools each schedule may use.** Every tool is listed, including the
  ones from MCP servers and your Python tools, with a search box for when that list gets long.
  Nothing is ticked to begin with. A tool you do not tick is not offered to the run at all, so
  installing a server later never quietly widens a schedule that already exists — and a schedule
  allowed to post to one place cannot also delete from another.

  That matters because nobody is present to approve anything while it runs. If a selection
  includes something that edits files, runs commands or reaches an MCP server, the editor says so
  plainly: anything the run reads could contain instructions, and it would follow them unwatched.

  Runs never overlap, a run missed while VS Code was closed happens once shortly after you open
  it rather than repeatedly catching up, and pausing a schedule keeps its history. Schedules only
  fire while VS Code is running — there is no background service, and the tab says so.

  **A `notify` tool** raises a notification you see even with the panel closed, with a button that
  opens the run that sent it. Ask for one directly — "send me a test notification" — and it will.

  Also: the settings tabs are now icons with the current one named, so they no longer overflow
  into a scrollbar, and your last message stays pinned at the top once it scrolls out of view.

## 0.18.0

### Minor Changes

- Read large logs a part at a time.

  `read_file` gains **tail**, which is how you actually open a log — the end, where the recent
  events are. It reads only the bytes it needs, so the last two hundred lines of a multi-gigabyte
  file arrive as quickly as from a small one.

  This also fixes a real limit rather than merely a slow path. `read_file` previously loaded the
  whole file before applying offset and limit, so on a very large log it did not just use a lot
  of memory: it exceeded the maximum string length and failed outright, and offset could not help
  because the whole read happened first. Windows are now read directly.

  A file too large to sensibly read at once is **refused with its size, its line count, and three
  concrete ways in** — tail, a window from the start, and a window near the end. Quietly
  returning the first few hundred lines would look exactly like the whole file and be reasoned
  about as if it were.

## 0.17.0

### Minor Changes

- Read Word documents, spreadsheets and HTML pages.

  The assistant can now open `.docx`, `.xlsx` and `.html` files with a new `read_document` tool.
  Previously `read_file` decoded them as UTF-8 and returned pages of unreadable binary, because
  Office files are ZIP archives rather than text.

  Long documents page through with offset and limit, exactly like `read_file`, and a workbook
  returns one sheet at a time with the other sheet names listed so the assistant can ask for the
  one it needs. Twenty sheets in a single reply would fill the context window on its own.

  No new dependencies, and the download is the same size as before: `.docx` and `.xlsx` are both
  ZIP archives of XML, so one small reader covers both using what Node already provides.

  **PDF is not supported yet** and says so plainly rather than returning something garbled. It is
  the one format that genuinely needs a parser rather than a reader, and that is a decision about
  download size rather than a small amount of code.

## 0.16.1

### Patch Changes

- Two fixes from real use.

  **Setting a tool to Always or Never no longer kills the MCP server.** The permission is stored
  as `disabledTools` on the server's entry, and the check deciding whether a config change
  warranted reconnecting compared the _whole_ entry — so a policy change looked like a
  connection change and the running process was torn down. It stayed down until the next
  message, which made changing a permission look like it crashed the server. Only the fields
  that decide how we connect are compared now.

  A server whose command or URL genuinely did change is also reconnected straight away instead
  of sitting idle until the next message, so editing one no longer appears to stop it.

  **Long dropdowns no longer close when you scroll them.** The popup closes on scroll so it
  cannot drift away from its button when the page moves underneath — but it is itself scrollable
  once the list is long, and its own scrolling was closing it. Which is exactly when a dropdown
  most needs to stay open.

## 0.16.0

### Minor Changes

- See what the assistant is searching for, and try a query yourself.

  Settings → **Search** now shows every search run this session — the query, how many hits, how
  long it took, and which index — plus a box to run one by hand.

  Retrieval is the one part of the product that fails quietly. A tool that errors says so in the
  transcript; a vector search that returns confident-looking neighbours for a query it did not
  understand looks exactly like one that worked. The only way to judge it is to see the queries
  and what came back.

  Each entry says whether it was matched **semantically** or **lexically**, which is the one
  thing the assistant itself cannot tell you. `search_docs` falls back to matching names and
  descriptions whenever the index is unreachable or was never built, and in the conversation
  that reads identically to a real semantic match — so an index that is configured but silently
  never consulted has been invisible until now.

  The query box runs the same code path the assistant uses, so what you see is exactly what it
  would have been given. Nothing is sent to the model.

## 0.15.0

### Minor Changes

- Skills can live in several folders, and the documentation index maintains itself.

  **Skills — one writable folder, any number of read-only ones.** Settings → Skills now lets you
  choose where new skills are saved and add further folders to read from: a shared team
  collection, a personal set, another checkout. Creating and editing always go to the one place,
  so a folder shared with colleagues can be listed by all of them without anyone's assistant
  being able to modify it. Earlier folders win a name clash, like `PATH`, so a personal skill
  overrides a shared one — and a shadowed skill is reported rather than silently ignored.

  **The tools folder is editable at last.** `python.toolsDir` has been configurable since it
  shipped, but the tab only displayed it, so moving it meant hand-editing config. It stays a
  single folder: a Python tool is code, and keeping it in the repository is what gets changes
  reviewed.

  **The documentation index rebuilds itself** when the catalogue changes — an MCP server
  connecting or announcing new tools, a Python tool created or deleted, a skill written, a folder
  reconfigured. It fingerprints the corpus first, so the usual case costs nothing, and it waits a
  few seconds for the dust to settle rather than reindexing once per server at startup. Deleting
  a tool or skill now removes its index entry automatically.

  **Index names take a prefix.** Settings → Search → **Index name prefix** replaces `light-code`
  at the front of both the codebase and documentation collections, so a shared cluster shows
  whose is whose. Changing it points at new, empty collections; the old ones keep their data
  until you remove them.

## 0.14.0

### Minor Changes

- Keep tool schemas out of the prompt, and let the model drop what it has finished with.

  A few MCP servers can contribute forty tools each, and every one of their schemas sits at the
  front of every request. Settings → **Search** now has a switch that stops listing them: the
  model finds a tool with `search_docs` and runs it through `call_tool` instead. You still
  approve everything exactly as before — the approval prompt names the real tool, never the
  dispatcher.

  **It is off by default, and the setting tells you whether it is worth turning on.** The switch
  shows how many tools it would actually hide, because that number is the decision. `call_tool`
  carries a description of its own, so below roughly a dozen tools it costs more prompt than it
  saves — and models call a listed tool more reliably than one named through a dispatcher. At
  forty tools it halves the prompt; at three it makes it bigger. Both directions are covered by
  tests.

  **`forget_docs` releases documentation once it has been used.** A schema is the most verbose
  thing in a conversation and the shortest-lived: after the call is made, it is dead weight that
  every later request pays for. The model can now drop everything it looked up, and search again
  if it needs something back. Anything retrieved _after_ the release is kept, so this can never
  delete a schema that is about to be used.

  Searching works with or without a vector store. With one, matching is by meaning — press
  **Index documentation** to build it. Without one, `search_docs` matches names and descriptions
  from the live tool list, so hiding a tool never makes it unreachable.

## 0.13.0

### Minor Changes

- Junior mode: a cheap model does the work, Claude does the thinking.

  Pick **Junior** in the mode selector and your ordinary model becomes the hands — reading,
  editing, running commands — while the Claude CLI expert supplies the plan. It is meant for the
  case where the everyday model is free or nearly free and Claude is the scarce resource.

  **Consultations in a task now continue one conversation.** This is the change that makes the
  mode worth having. Measured against CLI 2.1.227: a cold consultation pays 18,643 tokens of
  cache creation just to establish Claude Code's own prompt — $0.187 to reply "OK" — while
  resuming that session reads the same cache for $0.0099. Nineteen times cheaper, and the expert
  still remembers the code and the plan, so a follow-up is "step 3 failed with this error"
  instead of the whole story again.

  **The expert is told what you have, by name.** It runs in its own process with only Read, Grep
  and Glob: it cannot call an MCP tool, a Python tool, or search the documentation index, and
  without being told it would plan as though the junior were a bare shell. It now receives an
  inventory of every tool and skill — names and one-line summaries, never JSON schemas, and only
  once per session. When it needs exact arguments it asks the junior to look them up.

  **What the expert costs is now visible while you spend it**, above the token bar: the total and
  consultation count for the current task, resetting when you start a new one. Failed
  consultations are counted too, since one that errored partway can still have cost money.

  Junior mode is disabled in the picker unless the Claude CLI is configured — without an expert
  it would be an ordinary Code session whose instructions refer to something that is not there.

## 0.12.0

### Minor Changes

- Expert answers are marked in their own colour.

  When the Claude CLI expert answers, that block now carries a coral-orange of its own rather than
  the product's accent — a tinted surface, its own border, and the result relabelled "Claude's
  answer". The colour is configurable in Settings → **Appearance**, beside the accent, with a live
  preview so the pair is judged together.

  The distinction is by authorship, deliberately. An `ask_expert` result is literally Claude's
  words, so it is coloured as such. A reply merely _informed_ by a consultation is your own
  model's text, written after taking advice — it gets a small "informed by expert" mark and keeps
  its own bubble, because colouring it would claim Claude wrote it.

  The colour is kept separate from the accent because one colour cannot mean both "this is Light
  Code" and "these words came from somewhere else". If you set both to the same value the
  Appearance tab says so, but does not stop you — the expert mark still tells them apart, which is
  why colour is never the only signal.

  While a consultation is in flight the indicator says "Consulting the expert" and takes the
  expert's colour. It is the slowest thing the agent does and the only one that spends money at a
  second provider.

- d90f15a: See and manage skills in Settings → Skills.

  Skills shipped with no way to view them: the only way to know what the assistant had been told
  to remember was to browse `.lightcode/skills/` yourself. The tab now lists each one with its
  description and file, and lets you delete any of them.

  It also surfaces skills that were **not** loaded — a file missing a `description` is skipped,
  because without one the model has nothing to decide on, and previously that was a log line
  nobody saw.

- A theme of its own: green accent, messenger-style chat, and motion throughout.

  The chat is now sided like a messaging app — the assistant on the left, you on the right, with
  bubbles that arrive from the side they belong to, so the direction of a conversation is legible
  before you have read a word. Buttons press softly, panels and tabs transition rather than blink,
  and the typing indicator is a typing indicator.

  **The accent is yours to choose.** Settings → **Appearance** offers eight presets and a hex
  field, applied live as you type. It defaults to green and is saved per user, so it follows you
  between repositories. Text on the accent is computed rather than assumed — white on amber is
  unreadable, and a colour picker invites exactly that.

  Every dropdown was rebuilt. A native `<select>` popup paints its selected row with the system
  highlight, which no amount of CSS reaches — blue, in a themed UI, and worse on macOS where the
  list ignores CSS entirely. Dropdowns now render their own list, which also means they get proper
  keyboard behaviour and open upward when there is no room below.

  Accessibility notes: `prefers-reduced-motion` is honoured — every animation here is decoration,
  and vestibular disorders make sliding bubbles genuinely unpleasant. Focus rings appear for
  keyboard navigation and not after mouse clicks.

  None of this loosened the webview's `default-src 'none'` content-security policy. It has no
  `style-src` entry and still does not need one.

## 0.11.0

### Minor Changes

- da05798: The 25-step limit is now adjustable, and says what to do when it trips.

  Settings → Approvals → **Maximum steps per message** (1–500, default 25). The limit exists so
  a model looping on a failing edit stops costing money, not to cut short real work — so a long
  refactor is a good reason to raise it.

  Hitting it never loses anything, and the message now says so: the transcript is intact and
  another message ("continue") carries on from where it stopped. Previously it read
  "Stopped after reaching the maximum of 25 steps", which sounds like a crash.

  CLAUDE.md has described this as configurable since the first phase. It was not; the loop
  accepted the option and nothing ever passed it.

## 0.10.1

### Patch Changes

- fad091b: Fix indexing rejecting documents, and let you name the index.

  **"failed to parse field [vector] of type [knn_vector] … preview of field's value: null"** —
  the vector check confirmed the response was an array of the right length but never that its
  elements were numbers. `JSON.stringify([1, NaN, 3])` is `[1,null,3]`, so a single bad float
  arrived as a null and the whole document was rejected, with an error pointing at the mapping
  when the mapping was fine. Every element is now checked, and the failure names the model, the
  position, and where to look.

  **A width mismatch is now caught up front.** A vector field's dimension is fixed when the
  index is created, so pointing a differently-sized embedding model at an existing index used
  to fail on every single write with a mapping error that never said why. It now refuses
  immediately and tells you to change the width back or use a different index name.

  **The index name is yours to choose** (Settings → Search). Leave it blank and one is derived
  from the workspace path — collision-free, but nobody looking at a shared cluster can tell
  whose `light-code-a3f2…` it is. It is also how you move to a new index after changing
  embedding model, since the old one's width cannot be altered.

## 0.10.0

### Minor Changes

- b97db9c: Python tools now use your project's virtualenv and can install dependencies.

  **It finds the venv you already have.** If the workspace contains `.venv`, `venv`, `.env` or
  `env` with a working interpreter, that is what tools run in — and the tab says so, including
  whether uv created it. That matters because your project's environment is where your internal
  libraries are already installed; a private one would be empty, and a tool importing a company
  package would fail in a way that looks like a bug rather than a missing install. A private
  venv is still created if the project has none, and `python.venvPath` overrides both.

  The tradeoff is stated in the tab rather than hidden: reusing the project venv means a tool's
  dependencies are installed _into your project's environment_.

  **PEP 723 dependencies actually install now.** Previously the model was told to declare them
  and nothing ever installed them, so a tool needing a library failed on an `ImportError` that
  pointed nowhere useful. Dependencies are installed before validation, so a failure names the
  package and the index it was looked for on, and the model is told not to retry unchanged.

  **Package index is configurable** — point it at your internal mirror to make company packages
  installable and avoid reaching public PyPI at all. There is also an offline switch that
  refuses the network entirely.

  The path to `uv` now has a Browse button.

- 5b8cdec: Teach it once and it keeps the note: skills.

  Explain an internal library, a house convention, or a gotcha specific to your codebase, and
  the model now offers to record it as a **skill** — a markdown file in
  `.lightcode/skills/`. Next conversation it already knows, and when it later learns something
  that contradicts a skill it offers to update that one rather than writing a near-duplicate.

  **Only the one-line description enters the prompt.** Bodies are read on demand with the
  ordinary `read_file`, so a skill costs a handful of tokens whether it is three lines or three
  hundred — write as much detail as the subject deserves: package names, import paths,
  signatures, a worked example.

  It asks before writing, and the approval shows the exact markdown, because a skill is prose
  the model injects into its own future context. They live in your workspace as plain files, so
  they land in git and get reviewed like anything else.

  Particularly useful with Python tools: describe your internal SDKs once, and tools it writes
  afterwards use them properly instead of reaching for whatever it knows from training.

## 0.9.0

### Minor Changes

- The model can write its own Python tools (Settings → Python, off by default).

  Ask it to write a tool and it produces a Python file with a `run` function; the parameter
  schema and description are derived from the type hints and docstring, so there is no
  metadata to keep in sync. Once approved it becomes `py__your_tool`, callable from your next
  message onward.

  **You approve the source, not just the call.** Every create and update shows the full diff of
  the actual file first — and the approval is pinned to a hash of exactly those bytes, so a
  file changed afterwards, by anything, is refused and reported rather than loaded. A `.py`
  appearing in the tools directory that was never approved does not load either, which matters
  because that directory is inside your workspace and a cloned repo could contain one.

  Tools live in `.lightcode/tools/` so they land in git and get reviewed like any other code.
  The shared virtualenv is created by `uv`, outside the workspace. Provider API keys are never
  passed into the Python environment — a test plants five key-shaped variables and asserts none
  survive. A tool that hangs is stopped at its timeout and its whole process tree killed.

  There is no sandbox: a tool runs with your privileges, exactly as a shell command does.

## 0.8.1

### Patch Changes

- ed22037: Fix "Save embedder" appearing to do nothing, and list the provider's models.

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

## 0.8.0

### Minor Changes

- 399aa57: Search your codebase by meaning, not just by exact text.

  Settings → Search gains **Codebase indexing**: pick a provider profile to embed with, name
  an embedding model and its vector width, and press **Index workspace**. The model then gets
  a `search_codebase` tool that answers questions like "where do we decide to retry" when the
  code actually says `shouldAttemptAgain` — the query ripgrep cannot serve.

  It supplements `search_files`, it does not replace it. A vector search misses _silently_,
  returning plausible neighbours rather than nothing, so both the tool description and every
  result say the hits are approximate and must be read before being relied on.

  **Indexing is the largest egress in the product, and the UI says so before you press the
  button** — naming the embedding endpoint your code will be sent to and the index it lands
  in. It only ever runs from that button; the model cannot start it.

  What is never sent: anything gitignored, anything on the tool deny list, `.env`, lockfiles,
  binaries, files over 1MB, and anything outside the indexable file types. The rule is that
  anything `read_file` may not read must never be embedded, or indexing becomes a second route
  around the deny list — with the payload going to a third party rather than staying local.

  Reruns are incremental via a content-hash manifest, so only changed files are re-embedded.
  Changing the model, its width or the chunk shape reindexes everything, because vectors from
  two different models cannot be compared and mixing them silently produces confident nonsense.

## 0.7.1

### Patch Changes

- 3803c18: Internal: the chat bridge moved from the extension into core, behind a `HostServices` seam,
  so the new Node server (`npx light-code`) runs the same code. No behaviour change to the
  extension — `apps/vscode` is now ~400 lines of activation, webview plumbing and three VS
  Code-specific platform implementations.

## 0.7.0

### Minor Changes

- 8e37077: Add MCP servers from a form instead of hand-writing JSON.

  Settings → MCP now has **Add server**, with fields per server type rather than a raw
  `mcpServers` blob:

  - **Python (venv)** — point at your FastMCP script and press **Detect**. Light Code looks on
    disk for the interpreter, checking both `Scripts\python.exe` and `bin/python` regardless of
    platform, and searching `.venv`, `venv`, `env` and `.env` beside the script and one level
    up. What it finds lands in an ordinary editable **Python interpreter** field, so overriding
    it for a conda environment or a system Python is just typing over it. That field is what
    actually runs, so an unusual layout is never rewritten behind your back.
  - **npm package** — the package name. `-y` is always passed, because without it `npx` waits
    on a confirmation prompt that nothing inside an extension host can answer, and the server
    appears to hang rather than to ask.
  - **Command** and **HTTP** for anything else.

  The transport is not something you pick — it follows the type, and the server list and form
  both label it. A command is stdio; a URL is Streamable HTTP.

  Every path field has a **Browse** button opening a native picker, here and in Settings →
  Network: the script, the virtualenv folder, the interpreter, the working directory, and the
  CA, certificate, key and PFX. Each stays typeable, since a UNC share or a path already on
  the clipboard is not something a picker handles well.

  Environment variables and headers get key/value rows, with the `${secret:NAME}` reference
  form spelled out inline. Arguments are one per line, so a path containing a space needs no
  quoting. The exact command line that will be spawned is shown as you type — the same
  ground-truth principle as the approval prompt.

  The JSON editor is still there, now behind **Edit as JSON**, and the stored format is
  unchanged: a config pasted from another MCP client still works, and yours still pastes out.
  Servers can also be renamed and deleted from the list.

### Patch Changes

- a232250: Fix OpenSearch settings appearing not to save, and explain truncated log results.

  **A failed save looked exactly like a successful one.** The connection form closed the
  instant Save was pressed, before the host had written anything, and any error was routed to
  a banner that only the chat view rendered — so a rejected save closed the form, discarded
  what you typed, and said nothing. Three fixes: errors now render in every view, the form
  stays open until the host confirms the write reached disk, and the numeric limits show their
  allowed range and flag an out-of-range value in place. The most likely trigger was raising
  "Maximum results" past its ceiling of 100, which failed validation invisibly.

  **Truncated log messages are now explained and adjustable.** Long field values were cut at
  500 characters with a bare `…`, which reads as "the message ends here" — so the model
  reported the logs as truncated without being able to say why or do anything about it. The
  cut is now labelled with the full length, the result names which fields were affected and
  what to do, and **Longest field value** in Settings → Search makes the limit configurable
  (50–20,000). Worth raising for a log index whose messages carry stack traces: unlike the
  overall result cap, this cut cannot be recovered with `read_tool_result`.

  Every query limit also has a tooltip explaining what it protects against and what raising or
  lowering it costs.

## 0.6.0

### Minor Changes

- Configure your CA and client certificate once, in Settings → Network.

  Until now a corporate root had to be entered separately for each provider profile, each
  search cluster, and again inside the Apigee block — three chances to miss one and get an
  opaque "could not be verified" from whichever you forgot. There is now one **Network** tab
  holding the CA, the client certificate and key (or a PFX bundle) and its passphrase, plus
  the certificate directory that relative filenames resolve against — which was previously
  only reachable by hand-editing the config file.

  Everything outbound uses it: the gateway, the Apigee token endpoint, OpenSearch, and the
  embedder.

  Individual connections can still override, and the rules are deliberate:

  - **An extra CA on a profile is added to the global one**, never a replacement — so
    configuring one unusual gateway cannot cost you the root that makes everything else work.
  - **A connection supplying its own client certificate supplies the key with it.** The two
    are taken as a pair, so you can never end up presenting one certificate with another's
    key.
  - **A connection can re-enable certificate verification you switched off globally**, not
    only disable it.

  The global client certificate is presented to every connection that does not supply its
  own. That is a genuine choice rather than a convenience — a certificate identifies you to
  whatever you connect to — and it is the default because a corporate machine typically has
  one certificate for all internal services. Set `useGlobalClientCertificate: false` on a
  connection to withhold it from that endpoint.

  Existing configs keep working unchanged; per-connection CA settings are read exactly as
  before.

- 60a53cc: Search OpenSearch indexes your organisation already runs.

  Settings → Search takes multiple named connections, since different environments run
  different clusters. Each has its own credentials, an optional default index, and its own
  CA file or skip-verify setting for a cluster behind an intercepting proxy. Test Connection
  reports the cluster name and version, and the index dropdown lists what is actually there —
  with free-text entry always available, because `_cat/indices` is often denied to an account
  that can still search perfectly well.

  **Read-only, structurally.** The client the model uses exposes no write method at all, and
  its one request helper refuses anything but `GET` and `POST` to `_search`. Nothing the model
  does can create, change or delete anything in a cluster.

  Search tools are offered only while a connection is active, so the tool set stays stable
  within a session and search is off unless you turn it on.

  Embedding-based codebase search is not in this release; this is the half that needs no
  embedder and sends no source code anywhere.

- 817cd17: Queue messages mid-turn, and a working indicator.

  - **Type while it works.** Sending during a turn queues the message instead of being
    refused. The queue is visible above the input and each entry can be removed before it is
    used. The model picks them up at the next step boundary, so it sees them while still
    working rather than after it has finished.
  - **A working indicator.** Animated, with elapsed seconds once a reply takes more than a
    few, and it names what is happening — "Thinking" versus "Running search_files". It gets
    out of the way as soon as text starts streaming, since the words are their own evidence
    of progress.

  Also fixes two latent provider bugs the queue exposed: a user message following a tool
  result, or two user messages in a row, produced consecutive user turns that Anthropic and
  Gemini both reject. Both adapters now merge them.

### Patch Changes

- aa0f834: Guard rails so the model cannot run an expensive query against a production cluster.

  It already could not change anything — the client has no write path — but a _read_ can
  still hurt. Every query now carries a per-shard timeout, an early-termination cap, and a
  bounded hit count instead of an exact total that forces a full traversal. An unbounded
  query against an index with a date field is limited to the last 24 hours, and the tool
  result says so, so a document outside that window reads as a bounded search rather than
  missing data.

  A wildcard matching more than five indexes is refused with the count, and `*` or `_all` is
  refused outright. The model's requested result count is a ceiling request, not a grant: the
  connection's cap wins.

  All five limits are editable per connection in Settings → Search, since only you know what
  your cluster can take.

## 0.4.0

### Minor Changes

- 1223986: Profile selector in the composer, a Claude CLI expert, and the assistant knows which model it is.

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

- c580c0c: First release.

  A minimal agentic coding assistant: sidebar chat, nine built-in tools, and an autonomous
  multi-step loop with approval between steps.

  - **Providers:** OpenAI-compatible, Anthropic Messages, and Google Gemini, as named
    profiles you can switch between. Presets prefill a base URL; every field stays editable,
    and nothing is contacted until you save one.
  - **Corporate gateways:** mutual TLS with client certificates, OAuth client-credentials
    token exchange, custom CA bundles, and a Test Connection button that reports which of
    load-certs / get-token / list-models failed.
  - **Approval shows ground truth** — the literal command, the real computed diff. "Always
    allow" is exact-match, byte for byte.
  - **Checkpoints:** a shadow-git snapshot before the first edit, so a task can be undone in
    one click without touching your own repository.
  - **MCP** over stdio and Streamable HTTP, with per-server and per-tool controls.
  - **Task history** that survives closing the panel, reloading the window, and restarting.
  - **`@` mentions** for files and folders, image attachments for vision-capable models, and
    a visible context budget with cache hit rate.

  No telemetry, no update checks, no default endpoints.

- b8a2633: See what the model is thinking, and tell expert-influenced work apart.

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

### Patch Changes

- 662a361: Fixes from the first real corporate deployment.

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

- 061cd63: Asking the model to consult Claude now actually consults Claude.

  With the expert enabled, "can you say hello to Claude?" got "I don't have a way to
  communicate with other AI assistants" — the tool was available and offered, but the
  guidance to spend sparingly had talked the model out of a direct instruction, and it
  reported that choice as an inability.

  An explicit request now overrides the frugality rules: it is your money and your decision.
  If the model does decide against consulting on its own initiative, it has to say it chose
  not to and why, rather than claiming it cannot.

  The `expert` badge in the composer also no longer hides itself when no provider profile has
  loaded, so whether the expert is live is visible without opening Settings.

- a1b2083: Support VS Code 1.84 and later, down from 1.102.

  The floor was a policy choice — "roughly a year old" at the time it was set — not an API
  requirement, and it was quietly excluding people who had not updated recently. The newest
  API the extension touches is `SecretStorage` (1.53), so lowering it costs nothing. 1.84 is
  the same floor Roo Code's final release used.

  `@types/vscode` is pinned to match, which is what makes using a too-new API a compile error
  rather than a runtime failure on someone else's machine.
