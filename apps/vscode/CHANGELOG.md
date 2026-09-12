# light-code-vscode

## 0.77.0

### Minor Changes

- Roles can be edited and removed, from the panel and from the chat

  `update_role_prompt` becomes `update_role`, and it changes more than a prompt: a custom role's
  name, its summary, and whether it may read the workspace. Only what you pass is changed. The
  summary matters most of the three — it is the line every other specialist sees and the one the
  expert allocates from, so a role whose summary is wrong gets used for the wrong work, and a diff
  of the prompt alone would have shown nothing for that edit. The approval now shows the whole role.

  A built-in role still only accepts a prompt change, and says so rather than failing quietly.
  Renaming the reviewer would leave a role whose name says one thing and whose prompt says another.

  **`delete_role` is new, and it is a reversal.** It was withheld on the grounds that there is no
  case where the assistant needs to remove a role badly enough to risk getting it wrong — which was
  taste, not a safety argument. The act is gated exactly like creating one, the approval shows the
  whole role including the prompt that would be lost, and refusing it only meant the user went and
  did the same thing by hand. Built-in roles are refused explicitly, because "delete the reviewer"
  is a reasonable thing to try and being told why beats the call doing nothing.

  **Custom roles get colours like any other**, in Settings → Appearance. That needed no wiring — the
  list is built from the roles that exist — but it did need a fix: the swatch fell back to the
  expert's coral for a role with no built-in default while the palette painted a hue derived from the
  id, so the setting you were looking at and the colour you were seeing were different colours.
  `defaultAgentColor` is now the single answer to "what colour is this role before anybody picks
  one", and both read it.

## 0.76.0

### Minor Changes

- Invent your own roles

  The five built-in specialists cover most of a development cycle, and the ones people want next are
  almost always the same shape — a reviewer with a different brief. A security reviewer, a
  performance reviewer, one that knows a particular corner of a codebase. A role _is_ its prompt, so
  the whole feature is a name, what it is for, and what it is told.

  **Settings → Agents** has an Add role form: name, id, one-line summary, prompt, and whether it may
  read the workspace. The id is suggested from the name, because it has rules the name does not — it
  reaches a CSS variable, a config key and the argument a model types, where a space would be
  mangled with no error. Deleting takes two clicks: it takes a prompt somebody wrote and tuned with
  it. Capped at five, and the form says so before a save can fail on it, because the expert
  allocates from that list and its judgement is what a longer one costs.

  Each role also gets a **Can read and search the workspace** switch, so the per-role tool access
  added alongside this is reachable rather than hand-edit only.

  **The expert finds out automatically.** A custom role that has a model assigned appears on the
  roster every specialist is given, with its summary and whether it can look things up — so the
  expert allocates it in plans with no further wiring. It is told to treat the summary as the
  authority on a role it does not recognise.

  **And the assistant can create and maintain them.** `create_role` invents one, `read_role_prompt`
  reads what a role is running on, and `update_role_prompt` changes it — each of the writing ones
  always-ask, never available to a scheduled run, and previewing the whole role or a diff of the
  prompt. Deleting is deliberately not offered to the model.

  Two fixes found while building it. A custom role with no explicit colour now gets one derived from
  its id, quantised to twelve evenly spaced hues — hashing the ids people actually pick put four of
  five within 43° of each other, which on screen is four shades of the same green, and without any
  colour at all they would every one have rendered as the expert. And an assignment naming no
  profile no longer counts as an assignment: setting a preference on a role before staffing it made
  it read as "unassigned" and unavailable, which looks like something broken rather than something
  not yet done.

## 0.75.0

### Minor Changes

- Change what a specialist is, from the chat

  Requested directly: "make the reviewer stricter about error handling" should be something you say
  rather than something you go and edit. Two tools, and the pair is deliberate.

  `read_role_prompt` returns the prompt a role is running on and says whether it is the user's or
  the built-in default; with no role it lists them all. Without it the assistant would rewrite
  blind — asked to make the reviewer stricter it would produce a whole new prompt from its own idea
  of what a reviewer is, discarding whatever had been written. Reading first makes the change an
  edit rather than a replacement.

  `update_role_prompt` changes one, and **always asks**. A role prompt is prose injected into a model
  that is then asked to advise on this repository's own code — the reason `agents` is user-scope only
  in the first place — so it gets `write_skill`'s treatment: never auto-approved by a category
  toggle, never available to a scheduled run, and an approval showing a diff of the prompt that
  stands against the one proposed. The failure it guards against is quiet rather than loud: a
  reviewer whose prompt has been softened does not error, it approves things, in the same tone as
  before. An empty prompt resets the role, and the diff shows the default as the outcome so the
  approval does not read as deletion.

  Both are `dispatchOnly`, so neither costs anything at the front of the prompt in the conversations
  that never need them, and both write through `saveAgents` — the same path the Agents tab uses, so a
  prompt changed from the chat and one changed in Settings cannot behave differently.

## 0.74.0

### Minor Changes

- The librarian records skills itself, and the approval gate reaches consultations

  Asked for directly. The objection was never that the librarian should not write down what it
  knows — it is the role that can see the gap — but that a consultation **asks nobody**, so a skill
  written there would be prose injected into every later prompt that no human had read. §13 calls a
  skill a persistent prompt-injection vector, which is exactly why `write_skill` is always-ask.

  That was answered by making the path ask rather than by letting the write through unseen.
  `runConsultation` now takes an approver and routes anything in `ALWAYS_ASK_TOOLS` through the same
  gate the agent loop uses — same prompt, same ground truth, same rule. The librarian calls
  `write_skill`, the user sees the skill text, and nothing is recorded until they approve. With no
  approver present the call is refused rather than quietly allowed, the direction `requestPathAccess`
  already fails in.

  Everything else stays strictly read-only. The exception is to the _group_ filter and never to the
  approval rule: `consultBoundary.test.ts` pins that any name allowed past the filter must be one the
  gate will stop on, and that an `edit` tool written next year is excluded by default because the
  filter is by group rather than by name.

## 0.73.1

### Patch Changes

- Claude is metered whichever role it answers as, and the librarian drafts skills

  **A real hole in the spend meter.** `recordConsultation` was wired only into `ask_expert`, the tool
  that predates roles. Once Claude could be assigned to _any_ role, a reviewer or a librarian backed
  by the CLI spent real money that the meter never saw and that the per-task budget never checked —
  and nothing looked wrong, because an under-reported number still gets believed and a limit that
  quietly does not apply looks exactly like one that was never reached. Every CLI consultation is now
  checked before the call and recorded after it, including a failed one, which can still have been
  charged. Only where consultations are actually metered: a gateway bills somewhere this product
  cannot see.

  **The librarian drafts skills; it still cannot write them.** It is the role that can see a gap in
  what is written down, so a plan step like "record how this is set up" is a sensible thing for the
  expert to allocate to it — and the roster now says so, including that the step should be worded as
  drafting rather than filing.

  What it must never have is `write_skill` itself. A skill is prose injected into every later prompt,
  which is why that tool is always-ask and a human sees the source; consultation tool calls
  deliberately ask nobody. A librarian able to call it could write a permanent instruction no one
  ever read, through the one path with no gate. So it returns the text as advice, the assistant
  proposes it, and the approval shows exactly what would be recorded. `consultBoundary.test.ts` pins
  the rule generally: nothing a specialist is offered may be a tool that would otherwise demand
  approval, and the filter is by group so an edit tool written next year is excluded by default.

## 0.73.0

### Minor Changes

- A review goes back to the programmer, and the programmer can argue with it

  Requested for Agent team mode, where the point is clean code coming out the other end: when the
  reviewer finds something in code the programmer wrote, the fix belongs to the programmer. It is
  the role hired for writing. Fixing it silently wastes the specialist the user configured, and
  hides the exchange from them.

  **The programmer may push back, and that is the half that makes it worth doing.** A finding can be
  about a path that cannot happen, a convention this codebase deliberately does not follow, or a
  misreading of a fragment. A programmer that rewrites working code to satisfy a mistaken objection
  has made the change worse while looking like it agreed. So it is told to say when a review is
  wrong, the reviewer is told its findings will be contested and must be concrete enough to settle,
  and the assistant — the only one of the three holding the actual file — decides and says which way
  it went.

  Bounded at one lap. Re-review only when the fix was substantial enough that the first review no
  longer describes the code; if they still disagree, put it to the expert or decide it. Two models
  that cannot see the file trading a disagreement is a turn spent deciding nothing.

  **The routing lives in the tool result, not only in the mode instruction.** A standing instruction
  is read at the top of every turn and applies to one moment in a few of them; this codebase has now
  watched four behaviours fail because an instruction did not happen to mention them. The result
  arrives at the moment the decision is made, costs nothing at the prompt prefix, and names the
  programmer only when one is actually assigned.

  **Reporting progress no longer spends the step budget.** `plan_progress` is called twice per
  checkpoint, so a six-step plan was spending twelve of twenty-five steps saying what it was about
  to do — the plan feature taxing the work it exists to organise, and landing as "stopped after 25
  steps" in the middle of something healthy. Those calls are refunded, with the refunds themselves
  bounded so the cap can still be reached: a cap that cannot be hit is not a cap.

## 0.72.0

### Minor Changes

- 0ddc0c0: Specialists are told the truth about what they can do, and tool access is per role

  A correction first. Every specialist's preamble opened with "You cannot see the workspace and
  cannot read files, run commands or search". That was true when a consultation was a single
  request, and false from the moment `agents/consult.ts` gave provider-backed specialists the read
  tool group and the CLI expert its own Read/Grep/Glob. The sentence stayed.

  So the **librarian** — whose entire job is what has been written down in this workspace — was
  being told it could not go and read any of it, and answered from whatever happened to be pasted
  into the question. It is the weakest of the five roles for exactly that reason, and the reason was
  a stale sentence. Worse, the fix written earlier for a misallocated librarian step asserted the
  same falsehood to the expert, telling it not to allocate the librarian the one kind of work it is
  equipped for.

  Tool access is now a per-role flag. On for the **expert** (planning spans files nobody can paste),
  the **reviewer** (most of what a review turns on is around the diff) and the **librarian**
  (definitionally). Off for the **programmer**, handed a spec and asked to write, and the **tester**,
  reasoning about the change in front of it — for those a lookup budget buys a slower answer that is
  no better. An assignment can override the role's default, because it depends on who is answering.

  Read-only remains absolute: no specialist can edit or run anything, which is §12b's line and the
  whole security story in `consult.ts`.

  The preamble is also appended when a consultation is assembled rather than stored inside each
  prompt, so editing a role — or writing one from scratch — can no longer delete the sentences that
  say what it may and may not do.

## 0.71.6

### Patch Changes

- Stop the expert allocating steps a specialist could never carry out

  Reported from a real plan: the librarian was given "confirm the exact import paths for MATCH/ALL
  and ctx.triggered_id in the installed version" — a job that requires opening the installed
  package, which no specialist can do.

  Every specialist's own prompt opens by saying it cannot see the workspace or read files. But that
  sits in _its_ prompt, and the roster the expert reads describes _other_ people — so the expert
  knew it was blind itself and had no reason to think anybody else was. The roster now says it
  outright, and says what follows from it: a step that is really "go and look something up" —
  checking an installed version, confirming an API against the real package, reading what a file
  currently says — belongs to the assistant, which can simply do it. Specialists judge, design and
  review once the facts have been fetched.

  The planned-role chip also loses its trailing question mark. `reviewer?` was meant as "intended,
  not confirmed" and read as uncertainty about the name. The chips now sit behind a small `plan:`
  label, which says what they mean rather than asking anyone to decode punctuation.

## 0.71.5

### Patch Changes

- Drop the "Next: step N" line from the progress panel

  It was redundant and slightly misleading. The checkpoint list beside it already shows which step
  is open, and shows it more precisely — a filled ring for in progress, a dashed one for not
  started. Worse, it sat directly above the plan text, so it read as a description of that box
  rather than of the work.

  The box is labelled "The plan", which is what it holds.

## 0.71.4

### Patch Changes

- The programmer gets allocated too

  Reported from a real plan: the reviewer and the tester were named across four steps and the
  programmer nowhere, on a machine where all of them were assigned.

  The fault was in two instructions, both mine, and both the same shape. The expert was asked to
  allocate specialists "where another reader would genuinely change the outcome" — review framing
  throughout, down to "another pair of eyes", with a reviewer and a tester as its only examples. The
  programmer does not read, it produces, so a plan written to that instruction correctly never
  mentions it. And the assistant's own consult-without-being-asked list named the expert, reviewer,
  tester and librarian, with no bullet for the programmer at all — which is most of why the role
  never came up in the first place.

  Both now describe the two kinds of specialist separately: the readers, worth a step where another
  pair of eyes changes what happens, and the programmer, worth a step that is a self-contained piece
  of code with a spec clear enough to hand over. Bounded in both places — not for a two-line change,
  not where the spec is still moving, and what comes back is checked against the real file before it
  is applied.

## 0.71.3

### Patch Changes

- A plan's steps are its steps, not every bullet in the document

  Reported from a real plan: six numbered steps, one of them carrying five indented sub-points
  describing an architecture, followed by "Definition of done" and "Notes" sections that were also
  bullet lists. Every one of those lines was being read as a step, so a six-step plan became
  **seventeen checkpoints**.

  The visible half was a progress panel nobody could use. The serious half was quieter: the
  numbering is a contract — `plan_progress` takes a step number and the assistant is given those
  numbers in its prompt — and it had come apart. The assistant was being told step 5 was "ONE
  callback writes the store" while the plan the user approved said step 5 was "Review", so marking
  progress moved a row nobody meant.

  Two rules now decide what counts. Numbered items win outright, because somebody who numbered
  their steps has already said which things are steps and every bullet is then a sub-point or a
  trailing section. Failing that, only the shallowest indentation level counts, which keeps a
  bullet-written plan working while dropping its detail lines.

  **The panel also shows who the plan says should be involved.** A step naming a specialist —
  "Owner: reviewer", "ask the tester what would break this" — gets a faint dashed chip in that
  role's colour, read from the step and everything under it. It is drawn deliberately unlike the
  solid chip that records a consultation which actually happened: one is an intention a model
  wrote, the other is ground truth the host observed, and the second is only worth anything while
  it cannot be confused with the first.

## 0.71.2

### Patch Changes

- The expert allocates the specialists instead of only knowing about them

  Reported with a plan that was good and assigned nobody, on a machine where all four other roles
  were assigned. The expert had been told who was available and told not to name anyone who was
  not — so it named nobody at all and wrote a plan for the assistant working alone, down to "I'll
  show you the code before moving on" with a reviewer sitting right there.

  An instruction that only says what _not_ to do is satisfied by doing nothing. Asked for a plan,
  the expert is now asked to say which specialist belongs in which step, and to name the role in the
  step itself so the assistant knows when to consult and the user can see who is doing what.

  Bounded on purpose: only where another reader genuinely changes the outcome. A plan routing every
  step through the whole team is ceremony and stops being read, which is the opposite failure and
  just as easy to cause.

  The assistant is also told to consult a named specialist **while that step is the active one** —
  advice arriving after the work is a review nobody can act on without redoing it, and the progress
  panel attributes a consultation to whichever step was open when it happened, so a step worked in
  silence shows as nobody having helped with it.

## 0.71.1

### Patch Changes

- Agent team stops surveying the workspace before it consults the expert

  Reported with a screenshot: asked to build a small app, the assistant opened with "I'll start by
  understanding the workspace before proposing anything" and spent seven tool calls listing,
  reading and searching before any consultation happened.

  The instruction was live and the build was correct. The fault was its first step, which said to
  read "only what you need in order to ask a good question" — an open licence that the reported
  opening line is very nearly a quotation of. It is now a bound: one look at the workspace root and
  any file the user actually named, with surveying the codebase, searching the documentation index
  and hunting for skills all ruled out until the plan exists. The specialist cannot see any of that
  anyway, and it will say what it needs.

  It also names the failure in the model's own words, so a plan that sounds this reasonable is
  recognisable as the thing being ruled out.

## 0.71.0

### Minor Changes

- Specialists know who else is on the team, and who is not

  Reported from real use: a plan came back naming specialists that were never set up. The expert is
  the role most often asked for a plan and it had no idea who the team was, so it wrote the team it
  would have liked — "have the tester write cases, then the reviewer checks it" — and the assistant
  either spent a round trip being refused or quietly skipped that step. Either way the user approved
  a plan containing work that was never going to happen.

  Every consultation now carries the roster: who is available, and — the part that does the work —
  which roles are not, each with its reason, and a plain instruction not to give them work or write
  them into a plan. Listing only who is available reads as a suggestion; naming who is missing makes
  it an instruction.

  The assistant's own roster says the same thing, from the same `resolveTeam` result, so the two
  cannot disagree about who exists. A role that is assigned but whose profile has since gone is
  reported as unavailable _with that reason_, rather than as "not set up" — the user did set it up,
  and saying otherwise sends them to fix the wrong thing.

  **This holds whichever model is the expert.** The briefing is assembled above the branch that
  chooses between the Claude CLI and a provider profile, so both are handed identical text, and
  there is now a test reading the source to keep it that way — switching expert and quietly getting
  worse plans is the kind of regression nobody could point at.

## 0.70.0

### Minor Changes

- Plans have checkpoints, and Agent team starts by making one

  The plan a chat is given is now read as a numbered list of steps, and there is a **Progress**
  button beside **Set a plan** showing which are done, which is being worked, and which are still to
  come — with a chip for each specialist consulted along the way, in that role's colour.

  **The assistant can propose a plan, and the user approves it.** `update_plan` shows an ordinary
  approval prompt containing a diff of the plan you have against the one being proposed, so a plan
  drafted by the expert becomes yours by you agreeing to it. It can never be auto-approved: a plan
  exists to hold the assistant to work that was agreed, and an agent that could widen its own
  instructions and then point at them as authority is the one failure this feature must not have. It
  is withheld from scheduled runs entirely, for the same reason `schedule_prompt` is.

  **Agent team mode now plans before it does anything else.** With no plan set it asks the expert for
  one, proposes it, and waits — which is what an expert is worth asking before the work rather than
  after it. A question you can simply answer is still just answered.

  Two details worth knowing. Steps are identified by their wording rather than their position, so
  inserting a step above a finished one does not move "done" onto work nobody did — and rewording a
  step clears just that step. And a role chip records a consultation that actually happened while
  that step was active; the assistant says which step it is on, but it does not get to say who
  helped with it.

## 0.69.0

### Minor Changes

- 6c972b3: The agent team, on both

  The Node host gets the same Agents tab, the same five roles and the same Agent
  team mode as the extension, rather than the cut-down expert it briefly had of its
  own. Claude is offered wherever it is actually installed — which the host used to
  rule out, true of a server and wrong of a laptop.

  Specialists can now look things up for themselves: each gets a short read-only
  loop, so the reviewer can open the file you changed and the librarian can search
  the skills, instead of knowing only what was pasted into the question.

  And advice about spending is given only where something is counting. Telling a
  model to ration consultations against a gateway nobody is metering made it ask
  fewer questions for no benefit at all.

## 0.68.0

### Minor Changes

- ad926f2: Set a plan for a conversation

  A button under the input field takes a plan for the chat you are in — what this
  conversation is for. It sits in the assistant's prompt for the whole task, so it
  is exactly as present at step twenty as at step one, where a first message has
  long since been buried under tool results.

  It does more than state the goal. The assistant is told to check each step against
  the plan before taking it, to report an unrelated improvement rather than make it,
  to say so rather than quietly substitute a better plan of its own, and to account
  for the plan when it reports completion — what is done, what is not, and anything
  it did that the plan did not ask for.

  The plan belongs to the conversation: it is saved with it, comes back when you
  reopen it from history, and a new chat starts without one.

## 0.67.5

### Patch Changes

- 8de0018: Keep the specialist's colour when the consultation finishes, and tell it what exists

  The consultation block wore the specialist's colour while it ran and reverted to
  the expert's the moment it finished: the call and its result were built in two
  places, and the second forgot the role. One builder now makes both.

  Specialists are also told what this workspace has — the tools the assistant can
  call and the skills written for it, by name. A specialist has no tools and cannot
  discover any, so without that it advises as though the assistant were a bare
  shell: proposing by hand what a configured tool already does, or inventing a
  procedure an existing skill documents.

## 0.67.4

### Patch Changes

- 04e296f: Name the specialist that actually answered

  Every reply said "informed by expert" whoever had been consulted, and kept the
  expert's colour. The chat rebuilds each message as it arrives, and four of those
  rebuilds copied the "was informed" flag without the role beside it — so the name
  never reached the screen.

  A reply whose role cannot be determined now says "a specialist" rather than naming
  the expert. Calling it the expert is what made a missing field look like an
  answer, which is why it went unnoticed.

## 0.67.3

### Patch Changes

- c185e04: Carry the specialist's colour into the chat

  The reply written after a consultation is marked "informed by reviewer" in the
  reviewer's colour, rather than "informed by expert" in the expert's whoever
  answered. And while a consultation is running, the indicator says which specialist
  is being consulted, in that specialist's colour — it previously said "Running
  ask_agent" for every role except the expert.

## 0.67.2

### Patch Changes

- 91210bd: Colour a consultation by the specialist who answered it

  An `ask_agent` result was not recognised as a consultation at all, so it rendered
  in no colour — only the older `ask_expert` was. Now the block takes the colour of
  whichever role answered: the reviewer's answer is the reviewer's colour, the
  tester's is the tester's.

  A call whose role cannot be read is attributed to nobody rather than to the
  expert. The colour exists to say who spoke, and saying Claude answered when
  something else did is worse than saying nothing.

  The Appearance tab also showed two Expert colour pickers, backed by two different
  settings. The one that has always owned it stays, and the roles listed beside it
  are the others.

## 0.67.1

### Patch Changes

- 463d508: Fix an Agents tab that showed nothing

  The tab rendered its empty starting state and nothing ever replaced it: no roles
  to assign, providers reported as not configured when they were, and Claude
  reported as absent on machines where it is installed. Three symptoms, one cause —
  nothing ever asked the host for the tab's state.

  Claude is also detected for the tab now whether or not the old expert feature was
  ever switched on. Detection used to run only when that flag was set, which was
  right while the expert was the whole feature and wrong once Agents offered Claude
  as one choice among several.

  Adding or removing a provider refreshes the pickers, and detection pushes its
  answer when it finishes rather than only when asked — the panel asks on mount,
  which is before any probe has replied.

## 0.67.0

### Minor Changes

- b972a15: Settings → Agents: a team, not one expert

  The Expert tab is now Agents. Five roles — expert, programmer, reviewer, tester
  and librarian — each answered by a model you assign. Claude is still detected and
  is still the default expert where it exists, but it is a default now: any role can
  go to any provider you have configured, the expert included.

  Every role has a system prompt you can read and edit, because a role is mostly its
  prompt — the difference between a useful reviewer and a flattering one is a few
  sentences about what to look for. An edited prompt is stored only when it differs
  from the default, so improvements to the defaults still reach you.

  A checkbox says whether what consultations cost is worth managing. With it off
  there is no budget shown at all, because only a Claude consultation reports a
  price and a cap over an unmetered gateway would look like protection without being
  any.

  Junior mode is now Agent team. The assistant consults specialists on its own
  without being asked, and the judgement it uses about when that is worth it is
  editable in the same tab — the list of who exists is added automatically, so
  editing the advice never leaves it naming somebody who is no longer assigned.

  Each role gets a colour in Appearance, for the reason the expert had one: a review
  and a test plan arriving in the same colour are two voices presented as one.

## 0.65.0

### Minor Changes

- Give every Python tool the same environment variables

  A tool that reaches an internal system has to be told where it is and who is asking,
  and until now the only place to put that was the tool's own source — which lands in
  the workspace, gets committed, and has to be changed in every tool at once.

  Settings → Python now has an Environment variables list. Whatever is declared there is
  applied to every Python tool, every time one runs. A value can be marked secret, in
  which case it is kept in secret storage and never written to the config file.

  Saving restarts the worker, so a change applies to the next call rather than the next
  window. A variable marked secret with nothing stored behind it is named in the tab,
  instead of surfacing later as a credential error inside somebody's tool.

## 0.64.0

### Minor Changes

- `create_collector_tool` and `check_collector`, because a collector was being written as an
  ordinary Python tool and only failing at sync time.

  The model had the contract in its prompt and still reached for `create_python_tool`, which is the
  same failure this project already fixed one level up — a capability that has to be inferred is one
  that sometimes is not. So the contract gets a tool whose name is the job, and that tool **runs
  what it wrote** before saving it: the wrong shape is refused at creation, with the real error, not
  discovered by an unattended sync days later and attributed to the dataset.

  `check_collector` does the same for a tool that already exists — it runs it, says what came back
  in the terms the contract is written in, and shows the shape it should have returned. It changes
  nothing; fixing is an ordinary `update_python_tool` edit.

  Clear on a dataset was also disabled whenever no records had been collected — which is exactly
  when a failing sync leaves you wanting it. Clicking it did nothing and said nothing.

## 0.63.1

### Patch Changes

- A configured virtualenv was erased whenever Python settings were saved.

  The Python tab collected `venvPath` and the panel never put it in the message — so the field had
  never worked — and the host wrote the whole `python` block from what arrived, which erased
  whatever was in config. Saving anything at all from that tab lost the setting. Both halves are
  fixed: every field is sent, empty included, and the host merges rather than replaces. A field the
  form does not send is kept; a field it sends empty is removed. `interpreterPath` is now editable
  there too.

  Collectors are also more robust. The contract only reached the model once a dataset existed —
  backwards, since you need it to write the _first_ one — and it now arrives whenever tools can be
  written, with a worked example. The parser accepts every shape with one sensible reading (a list
  under any obvious noun, a lone dict, JSON returned as a string, `key` for `id`, a timestamp in
  seconds) and refuses the rest by name, quoting the keys the offending item actually had.

## 0.63.0

### Minor Changes

- A Python tool can call other Python tools and MCP tools.

  `import light_code` then `light_code.call_tool("py__other", x=1)`, or an MCP tool by its namespaced
  name. The reachable set is exactly that — deliberately. A tool body is model-authored, which §13
  calls the sharpest surface in the project, so approving one tool must not silently grant command
  execution, file editing, or the ability to author the next tool. Everything dangerous is excluded
  by construction rather than by a list somebody must remember to extend, and each nested call still
  goes through the ordinary approval gate, naming the tool that is asking.

  Absent in an unattended scheduled run, where nobody is there to approve one, and capped at four
  levels so a tool calling itself fails with a sentence rather than consuming the worker.

## 0.62.2

### Patch Changes

- The collector picker did not see a tool that had just been added.

  `postTools` was pushed on every way the catalogue can change — a Python tool created, an MCP server
  connecting, `tools/list_changed` — and `postDatasetStatus` was not, so a collector written for a
  dataset was missing from the list that exists to choose it. It follows the same triggers now, and
  both the Tools tab and the collector picker have an explicit Refresh for what a push cannot cover:
  a tool file edited outside the editor, and the ordinary need to confirm rather than assume.

## 0.62.1

### Patch Changes

- A dataset can be pointed at a vector store, the way indexed mail can.

  `storeId` was in the schema and honoured by the sync from the start, but there was no way to set
  it — so every dataset went to the default with no way to say otherwise. Each one now has its own
  picker, per dataset rather than one setting for all of them: unlike mail there can be several at
  once with different answers, and a corpus you collected yourself is often the one you least want
  on a cluster your team shares.

## 0.62.0

### Minor Changes

- The launch link's ten seconds is configurable, and a lapsed one no longer costs a restart.

  `--handoff-seconds <n>` raises the window (default 10, max 600). Ten suits a browser that opens
  itself and is far too short when the URL has to be carried by hand. And if it does lapse, a fresh
  link is printed to the terminal rather than leaving the only way back as stopping the server and
  losing whatever was running — it goes to the terminal the first one was printed to, so it reaches
  nobody it had not already reached. A token that does not _match_ still gets nothing.

  Adds a `header` auth type, for a gateway that authenticates on a header it expects rather than on
  an API key. Several headers, each with an optional prefix. Values are references, never literals:
  typed in, they go to secure storage and the profile keeps a pointer, because a profile lives in
  the config file and a credential must not; written as `env:API_TOKEN`, the credential stays
  wherever the launching process put it.

## 0.61.1

### Patch Changes

- The collector picker listed only built-in tools, and it now searches.

  It filtered on the tool's permission group, and a Python tool is registered as `command` because
  it runs code — so `read` held nothing but the built-in readers. Selected by what a tool _is_ now:
  the `py__` prefix, or the MCP group. The picker has a search box and groups Python tools above
  MCP ones, since forty tools from a server would otherwise bury your own collector.

  The schedule is a number and a unit rather than five fixed choices, so "every 90 minutes" and
  "every 3 days" are both sayable, with "only when I ask" as a separate checkbox. And a failed sync
  is now shown as a failure — coloured, dated, and saying the records are no longer being kept
  current — rather than as another line of grey text beside an unchanged record count.

## 0.61.0

### Minor Changes

- Custom data: corpora you collect yourself, in a tab of their own.

  The data most worth the assistant knowing is rarely on disk — it is in a ticketing system, a wiki,
  a database, an internal API, reachable only through something that knows how your organisation
  authenticates. So point at a tool that returns records and Light Code does the rest: embedding
  them, keeping them current, and searching them with `search_data`.

  The collector is an ordinary Python tool **or an MCP tool you already have** — one function
  signature rather than a connector per system. You do not have to write it: the assistant has the
  contract in its prompt and will offer one for you to approve.

  Each dataset has its own schedule, including "only when I ask" — which is the default for a new
  one and the right answer for a source that is expensive or only changes when somebody does
  something. Clear, rebuild, a retention window, a progress bar with Stop, and a trial search are
  all there. A collector that returns everything each run does not duplicate the corpus and does not
  re-embed what has not changed, which is what makes the simple collector the right one to write.

## 0.60.0

### Minor Changes

- A token-fetching script is configured in the Providers tab, not by hand-editing a config file.

  "Token from a script" in the authentication picker: point at a `.py` file, optionally name the
  interpreter and any arguments, and Test Connection runs it and reports what came back. Advanced
  fields cover JSON output, expiry and headers.

  The form is a shape over the same `tokenCommand` it always wrote — the mode is derived from the
  stored argv rather than remembered separately, so a hand-written `python -c "..."` opens as raw
  argv and saves back unchanged rather than being rewritten into something the friendly form can
  represent. On a shared server a personal profile cannot configure one: it would run as the
  account the server runs as.

## 0.59.2

### Patch Changes

- Picks up the shared core changes made for the Node host: an API key may be written as
  `env:API_TOKEN` and read from the process environment, and Python works against a bare interpreter
  when uv is absent. Neither is Node-specific in the code, so the extension gets both rather than
  letting the two bundles drift.

## 0.59.1

### Patch Changes

- A chart drawn during a conversation showed as nothing.

  The transcript derived charts from the stored messages, and the live turn posted an ordinary tool
  call — so `show_chart` rendered as a collapsed "show_chart ran" block while the turn was running,
  and only became a picture after a reload. Both halves were individually correct, which is the
  shape that keeps costing this project: one fact decided in two places. `chartFromToolCall` is now
  the single owner, and a test reads the bridge to make sure the live path keeps asking it.

## 0.59.0

### Minor Changes

- Charts in the conversation, and exact counts to draw them from.

  `show_chart` draws bar, stacked bar, grouped bar, line, multi-line and pie — hand-written SVG, no
  library, since the webview bundles every byte it serves. A series that does not line up with its
  categories is refused rather than padded: a chart drawn from misaligned data looks correct and is
  not, and nobody checks a chart against its figures. Every point can carry `detail` — the subjects
  counted, the rows measured — so a bar reading 14 can answer "which fourteen?", and every chart
  offers the numbers it was drawn from.

  `mail_stats` counts indexed mail into buckets — per folder, day, hour, sender or status, with an
  optional second dimension for a stacked bar — and can read a labelled number out of alerts and
  track it, or its day-on-day movement, over time. It returns the shape `show_chart` wants, detail
  included. A Python tool returning the same shape charts the same way.

## 0.58.0

### Minor Changes

- Mail searches can be narrowed step by step, and each tab's trial search shows only its own result.

  `search_mail` takes `within` — the ids from an earlier search — plus `subject`, `sender`,
  `contains`, `exclude`, `before` and `after`. Narrowing by re-running a broader search is not the
  same operation: semantic ranking reorders the population, so the "narrowed" answer can contain
  things the first pass never showed. `within` fixes the population, so a refinement is a genuine
  subset and can be repeated until the list is right; `idsOnly` keeps each step cheap. A date that
  cannot be parsed is refused rather than silently ignored.

  The trial search result was one piece of state rendered by three panels, so a mail search appeared
  under Skills and Tools as well. Each result now carries its target, and there is a Clear button.

## 0.57.1

### Patch Changes

- Folders whose name contains a forward slash were never indexed.

  An Outlook folder may be called `Prod/Test`. The path splitter treated both separators as
  separators, so that single folder became two path segments, resolved to nothing, and the harvest
  skipped it in silence — whole subtrees missing with nothing anywhere saying so. Backslash is now
  tried first, which cannot misread a name; the forgiving reading is kept as a fallback for a path
  typed by hand. Folders that cannot be opened are named in the status line instead of being
  swallowed.

## 0.57.0

### Minor Changes

- A search box on every index, a folder tree that starts collapsed, and folder paths that accept
  either separator.

  An index is invisible: "it found nothing", "nothing is indexed" and "the embedding model is
  wrong" all look identical from the chat. The hand-run search existed for the codebase and tool
  documentation but only in the Search tab; it is now on the Outlook, Skills and Tools tabs too,
  mail included, running the real tool so it shows exactly what the assistant would get. Mail hits
  carry their received time. Also: `Inbox/Alerts` used to match nothing at all, because Outlook
  stores backslashes and the filter compared literally.

## 0.56.0

### Minor Changes

- Mail search stops answering the wrong question quietly.

  A query with no embedding model configured was silently dropped, so "has this been mentioned
  before" returned the newest twenty messages in the index — a well-formed answer with nothing to
  do with what was asked. It now matches on words and says so, and a genuine absence is reported as
  one. Adds `mail_coverage`, so the assistant can tell which folders are indexed and how far back
  before concluding something is not in your mail, and `open_email` takes several ids at once.
  Every mail result now states what the index does not hold: colours, images, and anything past the
  opening of a long message. Settings section headings follow the accent colour.

## 0.55.0

### Minor Changes

- Every index can now be cleared and rebuilt, with a progress bar, and the newest mail actually
  gets indexed.

  The harvest sorted before restricting, and `Restrict` returns a new collection that does not
  carry the sort — so the batch limit cut an arbitrary order and the recent mail was what went
  missing. One folder could also consume the whole batch, starving every folder after it. Adds a
  "re-read the last N days" repair that replaces what is already held, clear and reindex for mail,
  clear for the codebase and documentation indexes, publish progress and an "unpublish" for team
  skills, a collapsible folder tree, and the tool-documentation index button back in the MCP tab.
  The assistant is now told to answer email questions from the index and to search live Outlook
  only when asked.

## 0.54.1

### Patch Changes

- Four fixes from real use.

  The team skills alias saved to disk and the panel never heard: the embedder message was unpacked
  field by field and dropped the two alias fields, so "Save this name" appeared to do nothing and
  "Send my skills to the team" stayed disabled. The tool documentation index was hidden whenever the
  dispatcher was off rather than disabled with a reason. "Reindex skills" sat below every skill and
  both folder editors, off the bottom of the panel. And the Outlook folder tree was missing its top
  level entirely, because the walk emitted a mailbox's children but never the mailbox.

## 0.54.0

### Minor Changes

- Settings reorganised. Outlook mail indexing has its own tab, with folders picked from a tree of
  your real mailbox instead of typed, an include-subfolders option, a progress bar and a Stop button.
  Tool documentation indexing moved from MCP to Tools, so each index has exactly one place. Team
  skills moved to the top of the Skills tab and its buttons are named for what they do.

  The assistant now checks this workspace's skills before it plans or answers, and only searches
  team skills when asked.

  Fixed: the team index alias could not be saved because the button was labelled "Save embedder" and
  sat several fields away. It has its own Save beside it now.

## 0.53.2

### Patch Changes

- Mail folders are added one at a time with an Add button that checks the folder exists in Outlook
  first, and lists what has been added below with a remove button on each. A mistyped folder is
  refused immediately, with near matches offered, rather than being accepted and quietly indexing
  nothing.

  Folder paths now accept either slash and do not need the mailbox name, so Inbox\Alerts works.
  Previously only the full store-rooted backslash form resolved, which meant the examples the
  product itself showed matched nothing.

  Fixed: the team index alias could only be attached after saving, but the Attach button appeared as
  soon as you typed one - clicking it said to set an alias you had just set. It is now disabled until
  saved, and says why.

## 0.53.1

### Patch Changes

- Excel: finds every running Excel, not just one. A workbook opened from mail, in Protected View, or
  in a second Excel window lives in a separate process and was previously invisible - asking about a
  spreadsheet on screen could be answered with "not open".

  Excel: survives being busy. While a cell is open for editing Excel refuses every automation call;
  that is now retried briefly, and if it persists the message says a cell is being edited and to
  press Escape, rather than showing a raw COM error.

  New: excel_diagnose reports why Excel tools are failing - how many instances are running, which
  can be reached, whether one is busy, and whether macros are accessible.

  The vector store for indexed mail can now be chosen in Settings instead of only in the config file.

## 0.53.0

### Minor Changes

- Mail indexing. Point it at Outlook folders and it keeps them indexed automatically, so you can
  ask "any alerts in the last six hours", "does this one happen every day around the same time" and
  "was a similar one sent last week on the same day". Times and subjects are kept exactly, so those
  answers are counted rather than estimated. Retention is in months and pruning is a button. The
  assistant can open a message in Outlook when you ask. Off by default, Windows only.

  Team skills. Publish your skills to a shared collection and search what colleagues have taught
  theirs. Writing a skill whose name a colleague already uses now tells you, and says who, without
  stopping you.

  Schedule a prompt from the chat: describe the job, tick which tools it may use from a filterable
  list, set the cadence in a form, then approve the whole thing before it is created.

  Forms gained a multi-select field with a search box, for picking from long lists.

- e5b2048: Team-wide codebase search. Set a team index alias in Settings -> Search and everyone on the team
  can search each other's indexed projects with search_codebase scope:"team", while still writing to
  their own index. Results from someone else are marked as not being in your workspace, checked
  against the disk rather than assumed, so the assistant does not try to open files that are not
  there. An existing index can be attached to the alias without re-indexing.

  Each kind of corpus can now go to a different vector store, so team code can live in a shared
  cluster while other indexes stay local.

  Fixed: opening an older conversation now scrolls to the newest message instead of the oldest, and
  the reply follows as it streams unless you have scrolled up.

  Fixed: create_python_tool was hidden behind the tool dispatcher, so asking for a tool sometimes
  produced a plain .py file in the workspace root instead. It is always offered now.

## 0.52.1

### Patch Changes

- Fixed "not permitted" when reading a file from a network share. Windows often refuses to _resolve_
  a path on a share even where reading it is allowed, and that refusal was escaping as a raw error
  instead of asking whether the folder could be read. You now get the usual prompt, and the folder
  can be allowed permanently under Settings -> Approvals -> Folders it may read.

## 0.52.0

### Minor Changes

- Excel: fixed "there is no open session" being reported while a workbook was open. Excel does not
  reliably register its Application object with Windows, so a running Excel is now found through the
  open workbook instead. A failed connection also says which cause is likely rather than always
  telling you to open Excel first.

  New: `excel_open_workbook` opens a workbook by full path, starting Excel if it is not running. It
  opens read-only and with macros disabled, so investigating a file changes nothing and runs nothing.

## 0.51.0

### Minor Changes

- Excel: tracing a cell now follows blocks rather than individual cells, so investigating a formula
  over a large range finishes in about a second instead of timing out. A range feeding a formula is
  summarised — how many cells, how many numeric, and which cells are in error by address — which is
  usually the answer being looked for. Cross-sheet range references are followed too; previously only
  single-cell cross-sheet references were.

## 0.50.0

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

## 0.49.0

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

## 0.48.1

### Patch Changes

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

## 0.48.0

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

## 0.47.0

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

## 0.46.0

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

## 0.45.0

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

## 0.44.3

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

## 0.44.2

### Patch Changes

- The expert budget is in the header in every mode, not only Junior.

  `ask_expert` is in the read group, so Code mode can consult and can spend — but the ceiling
  appeared only in Junior mode, or elsewhere once money had already gone. That was the wrong way
  round: it was hidden precisely while it was still worth setting, and became visible only after
  the first consultation had run under whatever default happened to apply.

  It starts from the limit saved in the Expert tab, and changing it in the header saves it as the
  new default, so the two agree rather than drifting.

## 0.44.1

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

## 0.44.0

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

## 0.43.0

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

## 0.42.1

### Patch Changes

- Outlook: sub-folders are listable, and "the last two hours" is one argument.

  Folder listing stopped at the top level, so a message filed under `Inbox\Projects\Acme` was
  reachable by path but impossible to _discover_ — the tool could already walk a nested path,
  nothing would ever show you one existed. It now walks the tree, indented by depth, with the
  full path on every line, because a nested name on its own is not something you can pass back.

  `outlook_search` takes `withinMinutes`, which is how people actually ask: 50 for the last
  fifty minutes, 120 for two hours. It is computed against this machine's clock — the clock
  Outlook stamped the mail with — and wins over an absolute `since` when both are given.

## 0.42.0

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

## 0.41.0

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

## 0.40.0

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

## 0.39.0

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

## 0.38.0

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

## 0.37.0

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

## 0.36.2

### Patch Changes

- The cost measurement now checks that its second sample actually resumed.

  If the Claude CLI returns no session id, the resume is silently skipped and both samples are cold
  starts — reported as "cold" and "resumed" with a ratio read off them. That is worse than no
  measurement, because the conclusion drawn from it is that caching saves nothing here, which is
  exactly wrong.

  It records whether the resume happened and says so plainly when it did not, rather than presenting
  two cold starts as a comparison.

## 0.36.1

### Patch Changes

- The measured consultation price now actually appears in the Expert tab.

  The measurement was working — the log said so and the value was saved — but the panel showed
  nothing. The message reached the browser and was then unpacked field by field, by name, so every
  field added since that code was written was dropped on the last hop: the price, whether the plan
  reports a cost, the measuring step, the keep-alive setting.

  It assigns the message whole now, and a type-level test fails the next time the two diverge.

## 0.36.0

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

## 0.35.0

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

## 0.34.1

### Patch Changes

- The Expert tab says whether your plan's spending limit can actually apply.

  The cost shown per consultation is whatever the Claude CLI reports in `total_cost_usd`. Some plans
  report nothing there — and then the spending limit can never be reached, because the running total
  stays at zero. A cap that silently never fires is worse than no cap, because it is believed.

  This is now learned from real consultations rather than asked for: probing would mean making a
  call, and the first call in a session is the expensive one. After one consultation the panel either
  says nothing, or says plainly that the spend cap cannot bind and to use the consultation limit,
  which is checked first and works on any plan.

## 0.34.0

### Minor Changes

- Internal only. A model chosen for code can write Python tool source — but that is a **Node host**
  feature and is not offered here.

  The mechanism lives in core because building a provider means auth strategies, TLS material and
  the wire adapter, and duplicating that outside core to keep one feature host-only would be a far
  worse trade. Where it is _offered_ is a separate decision: a host declares it, and the extension
  does not. So there is no picker, the config key is inert, and `create_python_tool` behaves
  exactly as it always has.

  This entry originally described the feature as available here. It was, briefly, in an unreleased
  build — the picker was passed to the panel unconditionally rather than on the host's say-so.

  Nothing about approval changes. The prompt shows a real diff of the bytes that will be written —
  now with a line saying which profile produced them, because source a second model wrote is judged
  differently from source the assistant you are talking to wrote — and the approved text is what
  gets hashed into the registry.

  Absent, which is the default, the chat model writes the source exactly as it always has, down to
  the shape of the tool's parameters.

## 0.33.4

### Patch Changes

- The guide button in the chat header now knows whether the host has a guide.

  It was added unconditionally in 0.31.0 and posted `openWalkthrough` regardless. `HostUi.openWalkthrough`
  is optional, so in the browser host the message reached nothing and the button silently did
  nothing — the exact failure the interface's contract exists to prevent. The host now says whether
  it has native onboarding, and the UI either opens it or renders the tour itself.

  The tour's content moved to `packages/core/src/guide/steps.ts`, shared by both hosts. The VS Code
  manifest is generated from it exactly as before — verified byte-identical across the move.

## 0.33.3

### Patch Changes

- "Create a tool" no longer silently produces a script.

  With Python tools switched off — the default — the model has no `create_python_tool`, so asked
  for a tool it wrote an ordinary `.py` file with `write_to_file` and said it had created a tool.
  True in English, false in this product: the result is not registered, not hash-pinned, and not
  callable. Nothing anywhere explained the gap.

  The prompt now says the feature is off when it is, and the model offers the choice instead:
  enable it in Settings → Python, or have a plain script written deliberately.

## 0.33.2

### Patch Changes

- The schedule editor's skill picker is searchable.

  A filter over names and descriptions, matching the tool picker beside it — a list you have to
  scroll to read is not a picker. Descriptions are matched too, because you remember what a note
  was about rather than what it was called, which is the same thing the description does when the
  chat searches for one.

  With a filter active, **Tick the N shown** and **Untick the N shown** act on the visible set and
  say how many, so a bulk action can never reach a skill that is scrolled out of sight. A running
  count says how many of your skills the run is currently told about.

## 0.33.1

### Patch Changes

- Fixes the turn that ends after announcing work it never did.

  A reply with text and no tool call ended the turn — correct for an answer, wrong for
  "I'll create the skill. Let me make something realistic.", which is a preamble to a tool
  call the model then dropped. Nothing errored: the text was recorded, the turn completed,
  and you were left looking at a promise with no way to tell whether the work had failed or
  was never attempted. This is the silent ending that has been reported against several
  releases and never reproduced.

  The loop now recognises an announcement and asks the model once to go ahead. Ordinary
  answers are untouched and cost no extra request; a chatty model is nudged at most once per
  turn rather than argued with.

## 0.33.0

### Minor Changes

- Looking things up is now the default, and skills work the same way as tools.

  MCP and Python tool schemas, and skill summaries, are kept out of the system prompt; the
  assistant finds them with `search_docs` and calls them through `call_tool`. Both halves are
  separate checkboxes in Settings → Search, and either can be switched off.

  Nothing is registered when there is nothing to hide. A workspace with no MCP servers, no Python
  tools and no skills gets no dispatcher tools at all, so the case where this cost more than it
  saved no longer exists.

  Skills keep a count and a standing instruction to search even when the list is gone. A tool is
  looked up because the task obviously calls for one; a skill's one-line description is the only
  thing that makes the model aware the subject was ever written about, so the trigger is replaced
  rather than dropped.

  Scheduled runs name their skills instead of searching, under **What it should know** in the
  schedule editor. A schedule's tools are an allowlist that may not include `search_docs`, and a
  run that comes up empty has nobody watching. Schedules that predate this include every skill,
  as they did before.

  Also fixes a latent bug: saving one `retrieval` setting replaced the whole block rather than
  merging into it, which discarded a hand-set `docsIndex`. Invisible with a single toggle;
  guaranteed to bite with two.

## 0.32.0

### Minor Changes

- The walkthrough is now an illustrated tour of the panel rather than a description of one.

  Fourteen steps: where everything is, the chat itself, one for each of the eleven settings tabs,
  and what leaves the machine. Each carries a diagram of that tab — the tab strip with one tab lit
  and its real fields in the order they appear — and a button that opens it, so a setting's location
  is something you are shown rather than told.

  The guide button moved out of Settings and into the main chat header, next to the gear. Help that
  is only reachable once you have navigated is help for people who no longer need it.

## 0.31.0

### Minor Changes

- A walkthrough for new users, and a Tools tab.

  **Get started with Light Code** appears on install: nine short steps covering providers and
  corporate gateways, how the agent loop and attachments work, what the approval prompt shows
  you, MCP servers, Python tools and skills, semantic search, the Claude expert and its budget,
  scheduled runs, and — plainly — what the product does not do.

  The first two steps complete from _state_ rather than from clicking them, so someone who
  already configured a provider is not told to do it again.

  **You can reopen it any time**: the help icon at the end of the settings tabs, or
  _Light Code: Open the walkthrough_ in the command palette. VS Code shows onboarding once and
  then effectively hides it, and nine features is a lot to have read on day one and remembered.

- A Tools tab: everything the assistant can call, in one place.

  Until now the only complete catalogue was inside the schedule editor's permission picker,
  which is a strange place to go to answer "what can it actually do" — and the built-in tools
  appeared nowhere else at all. Settings → **Tools** lists them grouped by where they came from,
  with a search that matches descriptions as well as names, because someone looking for a
  capability knows what they want done rather than what it is called.

  It is read-only on purpose. What a tool _is_ belongs to whatever created it — an MCP server's
  tools change when its config does, Python tools are files on disk, built-ins are the product —
  so editing here would mean a second place to change things that already have one.

  With the dispatcher on it marks which tools are kept out of the system prompt and says plainly
  that they are **still callable**, because a shorter prompt looking like a shorter tool list is
  exactly the misreading that feature invites.

## 0.30.1

### Patch Changes

- A schedule can be given editing permission, but never permission to install code.

  Granting a scheduled run the right to create or edit files already worked as intended: the
  tools you tick when you write the schedule _are_ the approval, made in advance, in the open,
  for one named job — and the default is still nothing at all.

  What was missing is the line on the other side of that. `create_python_tool`, `write_skill`
  and their siblings were offered in the same picker, and ticking one would have let an
  unattended run install model-authored code that later executes, with nobody seeing the source.
  Authorising a _change_ and authorising a _capability_ are different acts, and a checkbox
  ticked once cannot honestly mean "write and install any code you like, forever".

  Those tools are no longer offered to a schedule, are refused if one somehow reaches the gate,
  and are withheld from the registry so a run is never told they exist. The equivalent rule
  already covered interactive use; a scheduled run replaces the approval gate rather than
  wrapping it, so it never saw that rule.

## 0.30.0

### Minor Changes

- Copy an index between vector stores instead of re-embedding it.

  Switching backend used to mean indexing the whole repository again — minutes to hours, and
  real money wherever embedding is billed — to produce vectors that already existed. Settings →
  Search now offers **Copy an existing index here**, which streams this workspace's vectors out
  of another store and into the active one.

  **It refuses when the two were embedded differently.** A vector only means anything alongside
  vectors from the same model, at the same width, with the same chunking; mixing them produces
  confident, plausible, wrong neighbours with no error anywhere — the worst failure shape in the
  product. The check reads the source's own indexing record, so the refusal names which part
  disagrees and points at reindexing instead.

  The copy is streamed a page at a time rather than gathered in memory, which for a large index
  is hundreds of megabytes of float arrays. The bookkeeping is copied across on success, so the
  next incremental index diffs against the truth instead of starting over.

  Reading a whole collection back is deliberately on the write half of the vector-store
  interface, alongside the other bulk operations. The object handed to tools has no such method:
  a tool able to page through the index could exfiltrate the entire embedded codebase through
  the chat.

## 0.29.1

### Patch Changes

- A new file is shown as a file, and switching vector store no longer leaves search empty.

  **Creating a tool showed an all-green diff against nothing.** Technically accurate, and it
  reads as though something were being _changed_ when the honest description is "here is a file
  that does not exist yet" — with a marker column and a wash of colour that have nothing to
  contrast with. A new file is now shown as plain, syntax-highlighted source with line numbers.
  Editing still shows a diff, and deleting still shows a removal, because both of those are
  changes.

  **Switching vector store silently gave you an empty index.** The bookkeeping that records
  "everything up to here is already written" was keyed on the collection _name_, which is the
  same whichever backend is behind it. Moving from OpenSearch to Qdrant therefore left a
  manifest asserting the new, empty collection was already populated: the indexer skipped every
  unchanged file, the documentation reindex reported nothing to do, and search returned no
  results with no error anywhere.

  It is now keyed on the store as well, so switching backends starts from an honest blank slate
  — and switching back finds the earlier bookkeeping still valid, since the data in that cluster
  never went anywhere. Existing manifests are superseded, so the first index after upgrading is
  a full one.

## 0.29.0

### Minor Changes

- The Python tab now shows what is saved, and lets you choose the environment.

  **Settings looked as though they were not persisting.** They were — the tab simply never
  received them. It was sent the _resolved_ status (which interpreter won, which tools loaded)
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
  the resolved TLS material on _every_ request, not merely the first — a client that
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
  the assistant writes code that later _runs_, or prose that is later injected into its own
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

  Detection now bounds the _wait_ rather than trusting the process to die, and there is a budget
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

- 662a361: Fixes from the first real deployment.

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
