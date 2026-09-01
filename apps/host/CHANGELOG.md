# @chosengeneration/light-code

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
