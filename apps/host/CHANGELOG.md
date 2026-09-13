# @chosengeneration/light-code

## 0.59.3

### Patch Changes

- Ask the user for documentation instead of guessing at an unfamiliar API

  Requested from real use with a model whose training predates the libraries in front of it. The
  failure this addresses is not the assistant refusing to answer — it is answering anyway, from a
  remembered version of an API, which produces code that looks correct and fails against the version
  actually installed. The user very often has the page open.

  It is phrased as a thing to do rather than a permission: a model that is unsure is already
  reluctant to interrupt, and "you may ask" reads as "prefer not to". It is also told to check the
  workspace first — the imports and existing calls here are evidence about the installed version, and
  a skill may already describe it.

## 0.59.2

### Patch Changes

- The plan tools are advertised, not hidden behind the dispatcher

  Reported from real use: in agent team mode the assistant tried to set the plan, could not, and
  wrote it into a file instead — which looks like progress and is not. Nothing reads that file, the
  progress panel stays empty, and the user approved nothing. They had to stop it and explain.

  The cause was ours. Agent team mode opens by telling the model to propose the expert's plan with
  `update_plan`. Both plan tools followed the dispatcher, which is on by default, so that tool was
  **not in the list the model could see** — instructed to call something invisible, with
  `write_to_file` plainly available. The registration comment even carried the assumption that broke:
  that hiding them cost nothing because the guidance names them.

  Naming a tool in guidance and hiding it from the tool block are not compatible, and "still
  reachable through `search_docs`" is not the same as reachable — it asks the model to notice an
  absence, infer indirection, and spend a step on it, which a model under instruction to get on with
  the plan will not do.

  §12 permits this outright: what it forbids is the advertised set _varying_, and always-present is
  strictly more stable than conditioning on a config key. The price is two tool definitions per
  session, against a plan silently written to a file.

  The guidance also now says never to write the plan to a file, and to report the failure rather than
  route around it — an instruction that only forbids leaves a model with nowhere to go, which is how
  it invented the file.

## 0.59.1

### Patch Changes

- The thinking setting is reachable from the panel, including which parameter carries it

  `providers/thinking.ts` shipped complete and correct, and its own doc comment said _"the profile
  says which — and the UI explains the choice rather than hiding it behind a heuristic"_. No such
  control existed. Both the level and the parameter style were config-file-only, which from the
  outside is the same as not having them — the identical gap as the `always: true` skill flag and
  the per-project override, each of which shipped a release ahead of any way to reach it.

  **The style is the half that made it urgent.** "OpenAI-compatible" is not one thing: OpenAI itself
  takes `reasoning_effort`, while vLLM and SGLang serving Qwen3 take
  `chat_template_kwargs.enable_thinking`, and neither accepts the other. The per-seat thinking
  override in the Agents tab could therefore ask a Qwen3 seat to think, and the only spelling
  available was the one that model rejects — a 400 on _every_ request, not a hint quietly ignored on
  the hard ones.

  The provider form now carries both, and the style is offered only for the OpenAI wire format,
  where the parameter is genuinely ambiguous. Sending nothing stays the default, because it is the
  only setting that cannot break a gateway nobody has tested against.

  `providers/thinkingReachable.test.ts` reads the form and the bridge, since the defect is a missing
  connection and no test of the module that works can see it.

## 0.59.0

### Minor Changes

- Decide which model takes which seat from what the models did, not from their names

  The Agents tab gains a **Which model suits which seat** panel: put any profile through the five
  probes, have whoever is in the expert seat grade the answers, and keep every model assessed side
  by side. Each seat says which probes speak to it and what to look for in the answers.

  Three things were in the way, all of them structural:

  - **The assessment was graded by the Claude command line and nothing else**, so the whole feature
    was unreachable for anybody whose expert is a model on their gateway — which is the deployment
    this product is for. It now goes through whoever holds the expert seat, profile or CLI.
  - **It was nested inside the budget panel**, which is hidden whenever no seat is held by Claude.
    Somebody with several models and no Claude at all could not open the one screen that would tell
    them which model to put where. Fitness and cost are different questions; only one is about
    Claude.
  - **Only one assessment was kept**, so assessing the second model destroyed the evidence about the
    first — and comparing is the entire question. They are kept as a list now, and the verdict fed
    back to the expert is the one matching the model actually in the seat, chosen rather than
    assumed.

  **Budget controls are absent, not zeroed, when Claude holds no seat.** Nothing here can see what a
  gateway bills, so every control in that section would be a cap over a number that stays at zero —
  which is worse than no cap, because it is believed.

## 0.58.0

### Minor Changes

- Choose how hard a model thinks, per profile and per seat

  Every vendor spells this differently and none accepts another's spelling: OpenAI takes
  `reasoning_effort`, Anthropic a `thinking` block with a token budget, Gemini a `thinkingConfig`,
  and vLLM or SGLang serving Qwen3 take `chat_template_kwargs.enable_thinking`. §11 calls schema
  translation a silent-failure source; this is the same hazard with a louder failure, because an
  unrecognised top-level field is a 400 on _every_ request rather than a hint quietly ignored on the
  hard ones.

  So `thinking.level` is set once and translated per wire format, and **nothing is sent unless it is
  set** — that is what every request did before, and the only setting that cannot break a gateway
  nobody has tested against. The OpenAI wire format also takes a `style`, because "OpenAI-compatible"
  covers OpenAI itself, vLLM, SGLang and a dozen corporate gateways, and guessing between
  `reasoning_effort` and `chat_template_kwargs` would break every request against half of them.
  Anthropic's budget is clamped under `max_tokens`, which it requires and which is edited elsewhere.

  **A seat can override its profile**, from Settings → Agents. The same model is worth thinking hard
  as the expert, planning a change across files, and worth answering quickly as the librarian,
  reading back what is written down — one profile, two seats, two settings. The override is applied
  to a copy, so the Agents tab cannot change how the assistant itself thinks.

  **Sampling is settable too** — `temperature` and `topP`, sent only when set. A server default is
  frequently 1.0, and on a mid-size model that is felt most sharply where it is least wanted: a model
  that has to emit exactly `{"path":"src/a.ts"}` while sampling freely produces a plausible argument
  that is subtly wrong, and it surfaces as a tool error pointing nowhere near sampling. Large models
  absorb this; smaller ones do not. Left unset by default, because a default would change how
  somebody's working model behaves without their asking.

### Patch Changes

- 9000c30: Qwen3's thinking no longer fills the context window

  DeepSeek puts a reasoning trace in `reasoning_content` and several gateways use `reasoning`; both
  were already routed to the reasoning channel. **Qwen3 does neither** unless whoever runs the server
  switched a reasoning parser on — vLLM and SGLang need `--reasoning-parser` explicitly. Without it
  the thinking arrives in `content`, wrapped in `<think>` tags, with no field to tell it from the
  answer.

  Untouched that costs three things, and the third is the expensive one: it is shown as the reply, it
  is stored as assistant text, and it is therefore **re-sent on every later request for the rest of
  the task**. A model with 32k of context spends a growing share of it re-reading its own discarded
  reasoning — and the models that emit these tags are precisely the ones with the least room to
  spare.

  Tags are now split out of the content stream and sent to the reasoning channel, so they render as
  a trace and never enter the conversation. A state machine rather than a regex, because a tag split
  across two stream chunks — `<thi` then `nk>` — is ordinary, and a regex applied per chunk sees
  neither half. Content that merely starts like a tag is passed straight through, and a stream cut
  off mid-thought gives back what it was holding rather than dropping it.

## 0.57.0

### Minor Changes

- Address a specialist with `#`, and keep the original prompt safe

  **`#reviewer have a look at this`** consults that specialist, whatever the mode. The composer
  offers a picker on `#`, listing only specialists that can actually answer, and it is resolved
  host-side like an `@` mention and for the same reason (§18): you named the specialist, so there is
  nothing for the model to decide. Left to guidance it would be a suggestion weighed against the
  model's own judgement about whether a consultation earns its round trip — and typing the name _is_
  that judgement, already made.

  `#` rather than `@`, which is taken by file mentions and would make `@r` ambiguous at the moment
  the picker has to decide what to show; and rather than `/`, which people expect to be a command
  rather than a recipient.

  Only a name that is a role **here** counts. The first version matched anything shaped like a role
  id, which made `#include` in a pasted C file an unknown specialist, and `#define`, and `#main` — a
  feature that accuses you of mis-addressing somebody every time you paste code is unusable in the
  conversations this product exists for. Addressing a role that exists but cannot answer is still
  reported, because otherwise the message does nothing unusual and reads as broken.

  **Restoring a role's original prompt now survives a rename.** Resetting to default already worked,
  and still does. But when the assistant changed a custom role's _name_, it wrote the prompt then in
  force back into the role's definition — so an earlier edit became the new "default", and the text
  the role was created with was gone for good, with nothing reporting a loss. An edit and the
  original live in separate stores precisely so one can be undone; the identity path no longer
  collapses them.

## 0.56.1

### Patch Changes

- The assistant knows it can change a role's prompt

  Reported with a screenshot: asked to make a role a security specialist, the assistant replied that
  it could not — _"that's Settings → Agents, done by hand in the UI"_ — and offered to draft text to
  paste in. The tools were registered and working the whole time.

  They are `dispatchOnly`, so nothing advertised them, and the model had no reason to suspect there
  was anything to search for: reconfiguring its own team is not a capability an assistant assumes it
  has. A hidden tool is reachable only by a model that thinks to look, and for this one nobody
  thinks to look.

  **This is the second time in the same file.** `create_python_tool` was hidden the same way, and the
  comment recording that fix describes the identical wrong answer, confidently given — guidance
  written for the _absent_ case, with the present case assumed to need none. The system prompt now
  names `read_role_prompt`, `update_role`, `create_role` and `delete_role`, and says outright that
  "make the reviewer stricter" is something to do rather than something to explain how to do by hand.
  `roleToolsAnnounced.test.ts` fails if any of them stops being mentioned.

  Also: a switched-off role says **off** in words. It was reported as a missing switch while on
  screen — an unlabelled checkbox beside the name, with two labelled ones under it. The dimmed row
  said something was different; nothing said what.

## 0.56.0

### Minor Changes

- An on/off switch per role, and the dropdown opens where you clicked

  **Each role can be switched off** without being taken apart. Unassigning it was the only way
  before, and that forgets _who_ answered — somebody standing a specialist down for one job does not
  want to lose the model, the prompt and the flags they set up. The switch keeps all of it; the row
  stays in the list, dimmed, because a role you switched off is one you will switch back on and a
  list that dropped it would leave you hunting.

  A switched-off role leaves the team _entirely_ rather than showing as unavailable. Unavailable
  means "this was meant to work and does not" — it is reported as a fault, in the roster and in red
  in the tab. A choice is not a fault.

  **The provider dropdown opened a thousand pixels from the button** that opened it, near the top of
  the panel. `position: fixed` is resolved against the viewport only while no ancestor establishes a
  containing block, and a transform does — `.lc-panel` carries `animation: lc-fade-up 180ms both`,
  whose keyframes animate `transform`, and `both` keeps it filling after it ends. The measurement was
  right the whole time; it was being measured against the wrong origin. The popup is rendered into
  `document.body` now, so there is no ancestor left to capture it — which is also why this is the
  third fix to this component's positioning and the first that does not depend on what its parents
  happen to be doing.

  Also: a malformed `saveProfile` no longer fails with `Cannot read properties of undefined (reading
'trim')`. Refresh Models and Test Connection validate the form the same way saving already did —
  one owner for "is this a usable profile" — and an unrecognised auth type no longer falls into the
  API-key branch and dereferences a key nobody sent.

## 0.55.2

### Patch Changes

- A custom role can actually be configured

  Reported with a screenshot: a role created in the Agents tab, showing its checkboxes and its
  colour, refused a provider with _There is no "test-role" role._

  Three handlers — assigning somebody to a role, editing its prompt, setting its colour — still
  called `isAgentRole(role)` with one argument, which means "the built-in five and nothing else".
  The role existed everywhere except the places that let you configure it, which is a role you can
  create and cannot use.

  `roleValidation.test.ts` reads `bridge.ts` and fails on any bare `isAgentRole(role)`, because the
  defect lives in the _absence_ of an argument: the function was correct throughout, and no test of
  it could ever have caught this. The same reason `config/retrieval.test.ts` reads the bridge for a
  directly-read config key. Verified non-vacuously by putting one call site back and watching two
  assertions fail.

## 0.55.1

### Patch Changes

- A failed tool no longer breaks a conversation permanently

  Reported with a screenshot: a chat answering every message with an HTTP 400 from the provider —
  _"An assistant message with 'tool_calls' must be followed by tool messages responding to each
  'tool_call_id'."_ Not intermittent. **Permanent.** Starting a new chat was the only way out, and
  nothing said so.

  The assistant message is added to the conversation _before_ the tool runs, which it has to be, or
  the record would lose what was attempted whenever something went wrong afterwards. The result is
  added after. Anything escaping between the two — a tool throwing rather than returning an error
  result, a failure inside the truncation store — left a call with nothing answering it. The turn
  ended with a visible error, the task was saved in its `finally`, and the broken pair was then on
  disk, going out with every request from then on.

  Two fixes, because one is not enough. The loop now turns a throw into an error result, so the
  window is closed rather than narrowed — the same shape a denial already had. And history is
  repaired on the way to the provider, so a conversation broken before this existed heals when it is
  reopened instead of staying unusable for ever; that matters because the broken ones are exactly
  the chats people are in the middle of.

  The repair answers the call rather than deleting it. Removing the assistant message would lose the
  record of what was attempted and leave the model looking at a turn where it had asked for nothing.
  The synthetic result says what actually happened — the tool never reported back, nothing can be
  assumed about whether it ran — and is inserted immediately after its own call, because several
  providers require the ordering and not merely the count.

## 0.55.0

### Minor Changes

- A role can be allowed to change things, with every change approved

  Each role in Settings → Agents gains a second checkbox: **Can edit files and record skills — you
  approve each change.** Off for every built-in role, off for a new custom one unless the box is
  ticked, and present on custom roles exactly as on the built-in five.

  §12b's rule was that a consultant is read-only, because a second agent mutating the repository
  would sit outside the approval gate everything else passes through. That objection is answerable
  now rather than structural: `runConsultation` routes every non-read call through the same gate the
  agent loop uses, so a specialist's edit is approved exactly as the assistant's would be, showing
  the same computed diff.

  **The gate rule had to change to make that true, and it was nearly wrong.** It asked only about
  `ALWAYS_ASK_TOOLS`, which is right for `write_skill` and silently wrong for `write_to_file` — an
  ordinary edit is not on that list, so it would have run with nobody asked, in the one code path
  that asks nobody by default. The test is the tool's _group_ now: the filter admits `read` and
  nothing else, so anything else present arrived through the per-role extras and is privileged by
  definition. A read tool added next year stays free; anything else is gated with no list to keep in
  step.

  What a writing role gets is deliberately short — edit a file, record a skill — and not the whole
  edit group. Creating a Python tool or installing a macro authorises a capability rather than making
  a change, and §13 wants a human reading that source somewhere less hurried than the middle of a
  consultation.

## 0.54.0

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

## 0.53.0

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

## 0.52.0

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

## 0.51.0

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

## 0.50.1

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

## 0.50.0

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

## 0.49.0

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

## 0.48.6

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

## 0.48.5

### Patch Changes

- Drop the "Next: step N" line from the progress panel

  It was redundant and slightly misleading. The checkpoint list beside it already shows which step
  is open, and shows it more precisely — a filled ring for in progress, a dashed one for not
  started. Worse, it sat directly above the plan text, so it read as a description of that box
  rather than of the work.

  The box is labelled "The plan", which is what it holds.

## 0.48.4

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

## 0.48.3

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

## 0.48.2

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

## 0.48.1

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

## 0.48.0

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

## 0.47.0

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

## 0.46.0

### Minor Changes

- Hold outgoing messages until the event stream is open

  Reported from a remote server running the build that had already fixed this on the server side:
  no light/dark control, an empty Agents tab, and a model list that loaded for ever without ever
  failing.

  The server was right — it registers the session before writing the stream's headers, and answers
  `409 No event stream open` to a message that has no stream. The client was posting into the gap.
  `connect()` starts the stream without waiting for it, so it resolves, the UI mounts, and its five
  startup requests go out at once. Measured against the published build on loopback: the stream
  opened 51ms later and the first request still lost the race. The 409 retry covered that for about
  two seconds; over a proxy on a remote server the stream can take longer, and then the requests are
  gone for good — `settings` among them, which is the message carrying the theme capability.

  Messages posted while no stream is open are now held and released in order when one opens, so
  there is no window to lose them in. This covers a mid-session drop as well as startup: clicking
  Refresh Models while the stream was down had the same ending.

## 0.45.0

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

## 0.44.0

### Minor Changes

- 140f0ad: Take the current user and credentials from your own Python functions

  For an environment whose own libraries are the only thing that knows who is
  logged in and where the passwords are.

      light-code --identity-tool whoami.py --credential-tool creds.py

  `whoami.py` defines `run() -> str` and settings, secrets and history are filed
  under whatever it returns. `creds.py` defines `run(name)` returning a string or a
  dict; a secret stored as `tool:<name>` is fetched from it on use instead of being
  kept on disk, and `tool:<name>#field` picks one field of a pair.

  The credential function is a source of secrets, not a tool the assistant can
  call: everything that needs one — the gateway key, a search cluster's username
  and password, a certificate passphrase, an MCP server's environment — already
  resolves through the same interface, and a tool the model called would put the
  password in the transcript.

  Both refuse rather than guess. A function returning None does not become a user
  called None; a credential missing the field you asked for names the fields it did
  return instead of answering with an empty string, because an empty password comes
  back from a gateway as "your credentials are wrong" and sends you to check
  something that was never sent.

  The startup banner prints the resolved user and which file secrets come from.

- 5481edd: Go through the proxy the rest of the machine goes through

  On a server whose egress is proxied, every other process reached the LLM gateway
  and Light Code alone hung. The cause was not the network: undici, which the HTTP
  client uses because Node's built-in fetch cannot present a client certificate,
  does not read HTTP_PROXY or HTTPS_PROXY. curl, wget, pip and python-requests do.
  So we were the one program dialling direct into a firewall that drops rather than
  refuses, and a dropped connection waits for the kernel.

  The Node host now honours HTTPS_PROXY, HTTP_PROXY, ALL_PROXY and NO_PROXY, with
  proxy credentials sent as a header and never written to a log. Loopback is never
  proxied. The startup banner prints which proxy is in use, since that is the line
  that would have answered the question in one look.

  Connections also fall back from IPv6 to IPv4 now, which is the other way a
  corporate network turns a connection into a hang rather than an error.

  The VS Code extension is unchanged: it has worked for a long time on machines
  that may have these variables set for other tools, and routing a directly
  reachable gateway through a proxy that has never seen it would be a new failure.

- Publish a search connection or MCP server to everyone

  An administrator can put an entry in the shared configuration and every user gets
  it, read-only, with its credentials resolved from the shared store rather than
  their own. The case this was built for is a search cluster's username and
  password: configured once, rather than by every person separately.

  The scope lives in the entry's key — `shared:team-search` is the administrator's,
  `team-search` is your own — so there is no separate list of what is shared to fall
  out of step, and a credential reference routes itself to the right file.

  A user's own configuration never gains a shared entry, so removing one centrally
  removes it everywhere rather than leaving a copy behind that nobody can edit.

  The control for choosing the scope is not in the interface yet; shared entries are
  written to the server's shared configuration file for now.

## 0.43.1

### Patch Changes

- Answer the first request a page makes

  The browser's event stream resolves as soon as its headers arrive, and the page
  sends its opening requests straight away — but the session behind the stream was
  built after those headers were written. The first message of every page load
  landed in that window and was answered "no event stream open".

  That is why the light/dark theme control had disappeared: the setting that says
  the browser picks its own theme rides on the settings reply, the request for it
  was refused, and nothing said so.

  The session is now ready before the stream is acknowledged, so there is no window
  to land in. A server that consults a provider profile as its expert also no longer
  probes for the Claude CLI on every panel open.

## 0.43.0

### Minor Changes

- afb9a1e: A smaller, steadier server

  The Node host now offers a deliberately smaller feature set than the extension.

  Excel, Outlook and the mail index are gone from it. Both attach over COM to an
  application running on somebody's desktop, which a service account has no route
  to, and a mailbox belongs to a person rather than to the account this process
  runs as. The Outlook tab is no longer listed rather than being present and
  explaining itself.

  The expert is now any provider profile you have already configured, chosen in
  Settings → Expert. There is no Claude CLI on a server, and the gateway answering
  the chat already has a stronger model behind it. Everything that existed to
  manage what the CLI charged — the per-task budget, the measured price, the
  savings panel, the keep-alive, the session resume — is not part of it. A spend
  cap over something nothing meters would look like protection without being any.

  None of this changes the VS Code extension, which keeps all of it.

## 0.42.0

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

## 0.41.0

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

## 0.40.1

### Patch Changes

- `--allow-host` and `--allow-origin` were accepted but missing from `--help`, and `--bind` did not
  mention that a wildcard bind answers to the machine's own names.

## 0.40.0

### Minor Changes

- `--bind 0.0.0.0` now actually works from another machine.

  The allowed-host list was derived from the bind address, and `0.0.0.0` is not a name anybody
  browses to — so a public bind answered only to `localhost`, refusing the machine's own hostname,
  its LAN address, and even `127.0.0.1` with a 421. Measured against the running server. It now
  derives from what the machine _is_: loopback, its hostname, and each external address. A foreign
  domain is still refused, which is the whole point of checking Host at all.

  `--allow-host` and `--allow-origin` (both repeatable) declare anything not derivable — a reverse
  proxy, a container alias, or the app embedding this in an iframe.

## 0.39.1

### Patch Changes

- `--no-token` told you to paste a link within ten seconds that had no token in it.

  The launch message was unconditional, so in no-token mode it printed a URL ending in a bare `#t=`
  and a deadline for a mechanism that was not running — the exact flaw this file already records for
  shared mode, arriving through a different door. It now prints the plain URL and says there is no
  time limit, and the browser is opened at that URL rather than one with a dangling fragment.

## 0.39.0

### Minor Changes

- `--no-token` serves without the launch-link exchange.

  Requested, for running locally without friction. It turns off the bearer token, which is what
  stops another _process_ on the machine from driving the agent — a gap Light Code already declines
  to guarantee against, so this narrows it rather than opening a new category. It does **not** turn
  off `Origin` and `Host` enforcement, which is what actually stops a page open in another tab from
  posting to 127.0.0.1, and stops DNS rebinding. Verified against a running server with a raw
  socket, because `fetch` rewrites the `Host` header and testing it that way measures nothing.

  A flag rather than a deletion, because the failure is silent and remote in time from the choice —
  so the banner says it on every start, not only when the flag is typed.

## 0.38.1

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

## 0.38.0

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

## 0.37.3

### Patch Changes

- The collector picker did not see a tool that had just been added.

  `postTools` was pushed on every way the catalogue can change — a Python tool created, an MCP server
  connecting, `tools/list_changed` — and `postDatasetStatus` was not, so a collector written for a
  dataset was missing from the list that exists to choose it. It follows the same triggers now, and
  both the Tools tab and the collector picker have an explicit Refresh for what a push cannot cover:
  a tool file edited outside the editor, and the ordinary need to confirm rather than assume.

## 0.37.2

### Patch Changes

- `light-code --version` works, and the banner names it.

  It was not a known flag — and because unknown flags are rejected rather than ignored, asking for
  the version _failed_. That is the wrong way round for the one question people ask when something
  else has already gone wrong, and this project has already been bitten by a stale `npx` cache
  serving a build that predated `--server`. `--version` and `-v` are answered before the
  unknown-flag check, so they work even on a copy too old to understand the rest of the command
  line, and the version now appears in the startup banner and in the unknown-flag error too — which
  is where a stale copy actually shows itself.

## 0.37.1

### Patch Changes

- A dataset can be pointed at a vector store, the way indexed mail can.

  `storeId` was in the schema and honoured by the sync from the start, but there was no way to set
  it — so every dataset went to the default with no way to say otherwise. Each one now has its own
  picker, per dataset rather than one setting for all of them: unlike mail there can be several at
  once with different answers, and a corpus you collected yourself is often the one you least want
  on a cluster your team shares.

## 0.37.0

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

## 0.36.1

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

## 0.36.0

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

## 0.35.0

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

## 0.34.0

### Minor Changes

- Three changes for a Node host launched by another application.

  Python works against a bare interpreter: with no uv and no virtualenv it uses an ambient Python as
  it is, which is the point when the environment that launched it already has the internal libraries
  the tools import. It installs and removes nothing there — that environment belongs to whatever
  started it — and says so rather than leaving it to be discovered by a failing import.

  An API key may be written as `env:API_TOKEN`, read from the process environment on every request
  and never stored. And because a parent cannot change a running child's environment, a profile can
  instead fetch its own token by running a command — whatever library already does the gateway's auth
  — refreshed before expiry, shared across concurrent requests, and checked before a stream opens.

## 0.33.0

### Minor Changes

- The Node host runs on Node 17 and newer, down from 20.

  Nothing Light Code writes needed a current runtime — the newest API anywhere in core is
  `structuredClone`, which arrived in Node 17.0 exactly. What did was the dependency floor: undici 8
  declares Node 22, env-paths 4 declares 20, and the MCP SDK declares 18. The first two are pinned
  to versions that support 17; the SDK's floor is about the web globals Node 18 promoted, so the CLI
  supplies those from Node's own modules and from undici before anything else loads, and says so in
  the banner when it has. On Node 18 and above it does nothing at all.

## 0.32.0

### Minor Changes

- Settings reorganised. Outlook mail indexing has its own tab, with folders picked from a tree of
  your real mailbox instead of typed, an include-subfolders option, a progress bar and a Stop button.
  Tool documentation indexing moved from MCP to Tools, so each index has exactly one place. Team
  skills moved to the top of the Skills tab and its buttons are named for what they do.

  The assistant now checks this workspace's skills before it plans or answers, and only searches
  team skills when asked.

  Fixed: the team index alias could not be saved because the button was labelled "Save embedder" and
  sat several fields away. It has its own Save beside it now.

## 0.31.2

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

## 0.31.1

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

## 0.31.0

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

## 0.30.1

### Patch Changes

- Fixed "not permitted" when reading a file from a network share. Windows often refuses to _resolve_
  a path on a share even where reading it is allowed, and that refusal was escaping as a raw error
  instead of asking whether the folder could be read. You now get the usual prompt, and the folder
  can be allowed permanently under Settings -> Approvals -> Folders it may read.

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
