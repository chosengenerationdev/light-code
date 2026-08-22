# Running Light Code cheaply in the office

**Situation this is written for:** Qwen Coder is free to you and Claude is not. No GitHub access,
so everything has to be carried in and built internally. You want Qwen doing the work and Claude
used only where it changes the outcome.

**Who this is for:** Claude should read this document first in any session where it is acting as
the expert. It is the standing brief. The rules in §4 are the ones that decide the bill.

---

## 1. The cost model, measured

These are measurements against Claude CLI 2.1.227, not estimates.

| | Cost | Why |
|---|---|---|
| **First consultation in a task** | **$0.187** | Establishes Claude Code's own prompt and tools: 18,643 cache-creation tokens, *before your question* |
| **Every later consultation in the same task** | **$0.0099** | Reads that cache instead of rebuilding it |
| Qwen doing anything | free to you | |

**Nineteen times.** That ratio is the single most important fact here, and it inverts the obvious
strategy. The instinct is "ask Claude as little as possible". That is wrong once a session exists —
the expensive act is *starting* a conversation, not continuing one.

So the rule is not **ask less**. It is:

> **Make the first question count, then never pay to re-establish context.**

Two consequences that follow directly:

- **One task, one session.** Light Code resumes the expert session automatically within a task and
  resets it when you start a new one. A new task is a new $0.187. Do not start a fresh task for
  each small question in the same piece of work.
- **The cache expires after one hour.** A task left idle for two hours costs full price to resume.
  Finish a piece of work in a sitting, or accept that after lunch it is a new task.

---

## 2. The setup

### Roles

| Role | Model | Configured as |
|---|---|---|
| Chat / hands | Qwen Coder | The active provider profile |
| Expert / brain | Claude | `expert.enabled: true`, the Claude CLI |
| Writes Python tools | Qwen Coder | `programmingProfileId` |

Junior mode makes Qwen the one that reads, edits, runs commands and checks results, and Claude the
one that decides *what* to do. Claude never touches your repository — it holds `Read`, `Grep` and
`Glob` only, and cannot edit or execute anything.

### Configuration

Set the active profile to Qwen in **Providers**, then in **Expert**:

```jsonc
{
  "modeId": "junior",
  "activeProfileId": "qwen-coder",
  // Free to you, so it also writes the Python tool source (Settings → Python).
  "programmingProfileId": "qwen-coder",
  "expert": {
    "enabled": true,
    "path": "claude",
    "maxSpendUsd": 1.0,
    "maxConsultations": 6
  }
}
```

`maxSpendUsd` and `maxConsultations` are **per task**, and the expert is told what is left so it
plans to fit. Start at $1.00 — that is one cold start plus about eighty follow-ups — and adjust
from the budget control in the chat header once you have a week of real numbers.

### Getting the code in without GitHub

The npm tarball **bundles its dependencies**, so it installs with no network at all. That is a
deliberate design decision for exactly this situation and there is a test that proves it
(`scripts/smoke-test-npm.mjs` installs it into an empty directory with no registry reachable).

On a machine that has npm access:

```bash
npm pack @chosengeneration/light-code
# produces chosengeneration-light-code-<version>.tgz
```

Carry that one file in. Then, inside:

```bash
npm i -g ./chosengeneration-light-code-<version>.tgz
light-code --guide
```

No `node_modules`, no registry, no proxy configuration. If you need to build from source instead,
carry the repository plus a warmed pnpm store and use `pnpm install --offline --ignore-scripts`.

---

## 3. What Qwen does, unaided

Everything below is Qwen's alone. **Consulting Claude about any of it is waste** — the answer is
either in the repository or is something Qwen is perfectly capable of.

- Reading files, searching, and reporting what is there
- Applying an edit that has already been decided
- Running tests, builds and commands, and reporting the output
- Fixing a compile error, a typo, a lint failure, a failing assertion with an obvious cause
- Writing a Python tool from a specification that already exists
- Anything already written down in a **skill** (see §5)
- Reformatting, renaming, moving code, mechanical refactors
- Retrying something that failed for a reason the error message states

If Qwen is about to ask Claude "what does this file do" or "did the test pass", the answer is to
go and look.

---

## 4. Rules for Claude

**These are the rules that decide the bill. Follow them literally.**

### 4.1 Make the first consultation carry the whole task

The first question costs nineteen times the rest. So it should not be a question — it should be a
**briefing that produces a plan**.

The first message to Claude should contain:

- What the task actually is, in the user's words
- What Qwen has already established by looking (files, structures, current behaviour)
- The specific decisions that are needed
- Any constraint that rules options out

And should ask for:

- A plan **in checkpoints**, each one a coherent piece of work Qwen can finish and verify
- The order, and what "done" looks like for each checkpoint
- What to watch out for

Not: "how should I approach this?" — that buys a paragraph for $0.187 and guarantees a second
consultation.

### 4.2 Never re-send context in a later consultation

The session remembers. A follow-up should be the *delta only*:

> Checkpoint 2 done. Tests pass. `resolveActiveProfile` returned undefined for a profile with no
> auth block — I defaulted it to `none`. Next?

Not a restatement of the task, not the file contents again, not the plan repeated back. Every
token of repeated context is paid for and buys nothing, because it is already in the session.

### 4.3 Consult at checkpoints, not at steps

One consultation per checkpoint, carrying **everything** from that checkpoint. Four questions
batched into one message cost one consultation; asked separately they cost four.

Bad: four messages asking about four files.
Good: one message — "Here is what I found in all four. Two look wrong to me, for these reasons."

### 4.4 What is worth a consultation

Spend on:

- **The plan**, once, at the start
- A **design decision with consequences** — a data shape, a security boundary, an interface others
  will depend on
- **A checkpoint review** where something did not go as expected
- A bug where Qwen has genuinely looked and the cause is not apparent from the evidence
- Anything touching the **approval gate, secrets, or path confinement** — these are the places
  where being wrong is expensive in a way that is not measured in dollars

Do not spend on:

- Anything in §3
- Confirming a decision Claude already made
- Reporting success with no question attached — say it at the *next* checkpoint instead
- Style, formatting, or naming, unless a convention is genuinely in dispute
- A question the user can answer directly, which costs nothing — use `ask_followup_question`

### 4.5 When the budget is nearly gone

The expert is told what remains and should say so plainly rather than quietly producing thinner
advice. If one consultation is left, spend it on the **plan for finishing**, not on a review of
what is already done.

### 4.6 Write down what was learned

The single largest saving available. See §5 — it is the difference between paying once and paying
every week.

---

## 5. Skills: pay once, not every time

**A skill is the highest-leverage cost control in this setup.** Anything Claude explains that will
be true again next week should become a skill, and then Qwen answers it for free forever.

Ask for a skill whenever you find yourself explaining:

- An internal library, its import path and how to call it
- A house convention: error handling, logging, configuration, testing
- The shape of an in-house API or gateway
- A gotcha specific to your codebase that cost someone an afternoon
- The deployment or release procedure

Only the name and description sit in the prompt, so a skill costs a few tokens until it is
actually needed. A hundred skills is a rounding error.

**Write the description as the trigger.** By default the assistant searches for a relevant skill
rather than seeing a list, so the description must say what subject it covers in the words someone
would search for. "Notes" is useless. "How to call internal services — auth, retries, tracing
headers" is found.

Do the same for **Python tools**: a task Qwen does repeatedly should become a tool once, and then
be a single call. Qwen writes the source itself (§2), so the tool costs nothing to create.

---

## 6. A worked example

**Task:** add retry with backoff to the internal HTTP client.

| Step | Who | Cost |
|---|---|---|
| Read the client, find the call sites, check for existing retry logic | Qwen | free |
| **One briefing:** what the code does now, where the calls are, what the user wants, ask for a checkpointed plan | Claude, cold | $0.187 |
| Checkpoint 1: add the backoff helper, with tests | Qwen | free |
| "Checkpoint 1 done, tests pass. One question: jitter — full or decorrelated?" | Claude, resumed | $0.0099 |
| Checkpoint 2: wire it into the client | Qwen | free |
| "Done. Two call sites set their own timeout, which now interacts with the retry budget." | Claude, resumed | $0.0099 |
| Checkpoint 3: fix those, run the suite | Qwen | free |
| Record a skill: how retries work in this client, and why | Qwen | free |
| **Total** | | **≈ $0.21** |

The same task done badly — a fresh consultation for each question, context re-sent each time —
costs about **$1.50**. Seven times more, for a worse plan, because none of those consultations
could see each other.

And the skill written at the end means the *next* retry question costs nothing at all.

---

## 7. Watching the spend

- The **cost meter in the chat header** shows what the expert has spent on this task, live.
- The expert gives a **cost estimate** with its plan — if that estimate is uncomfortable, the time
  to change the plan is then.
- Failed consultations are counted, because one that errored partway can still have cost money.
- **`--guide`** opens the operator guide; §7 of it covers what leaves the machine.

If the meter is climbing on a task that felt routine, the cause is almost always one of two things:
a new task was started mid-work (paying a fresh cold start), or context is being re-sent in every
consultation. Both are in §4.

---

## 8. What to be careful about, cost aside

Two things matter more than the bill:

- **Shared hosting locks settings, not privileges.** If you run the Node host for the team, every
  user's commands run as the service account. It is appropriate where everyone is already trusted
  with everything everyone else can reach, and nowhere else. `light-code --guide` says this in
  full.
- **Indexing is the largest egress in the product.** Turning on semantic search uploads the
  workspace to whatever embedding endpoint is configured. Qdrant or Chroma on loopback keeps it on
  the machine; anything else does not. It ships disabled.
