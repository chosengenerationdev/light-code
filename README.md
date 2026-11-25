# Light Code

A minimal agentic coding assistant for VS Code. Chat, a small set of built-in tools,
configurable LLM providers, MCP integration — and deliberately nothing else.

**No telemetry, ever. No default endpoints.** A fresh install contacts nothing until you
configure a provider.

**Draw how your AI specialists work together, and Light Code holds them to it** — loop limits,
checked hand-overs, parallel steps and decision points, enforced by Light Code rather than left to
the model, visible while it runs and recorded by the Auditor. See [Strategies](#a-team-of-specialists).

---

## What it does

### The basics

- **Syntax-highlighted code** in every reply, in any language — including ones it has never
  heard of.
- **Chat in the sidebar**, with an autonomous multi-step agent loop — one tool call per
  step, your approval between steps, until the task is done.
- **Read, search, write, diff, run.** ripgrep-backed search, a strict `apply_diff` with no
  fuzzy matching, and shell commands in the integrated terminal.
- **Any provider you can reach.** OpenAI-compatible, Anthropic Messages, and Google Gemini,
  behind named profiles you can switch between. Presets prefill a base URL; every field
  stays editable.
- **Corporate gateways are a first-class case:** mutual TLS with client certificates,
  OAuth client-credentials token exchange, custom CA bundles configured once and applied
  everywhere, and a Test Connection button that tells you *which* step failed.
- **MCP servers** over stdio or Streamable HTTP, with per-server and per-tool controls.
- **Approval that shows ground truth** — the literal command, the computed diff — never the
  model's description of what it intends to do.
- **Modes.** **Auto** (the default) — shell-first working, where reading and searching and
  compiling run without stopping you, and anything that writes, deletes or executes still asks;
  **Ask** (read-only); and **Agent team**. What counts as read-only is a list you can see and add to.
- **Suggestions while typing**, opt-in (Settings → Project): Tab takes the next word, Ctrl+Space
  the whole line, from a small fast model you choose for it.
- **Memory.** Short corrections you give the agent are kept for the codebase and applied in every
  later chat; you can read, edit and remove each one.
- **Excel and Outlook on Windows**, opt-in and off by default. Attach to the workbook you
  already have open and trace a `#DIV/0!` back through its precedents across sheets; search
  your mail; compose a message with attachments and embedded images, which it **shows you
  rather than sends**.
- **Checkpoints.** A shadow-git snapshot before the first edit of a task, so you can undo
  everything in one click. Your own git repository is never touched.
- **Task history.** Conversations survive closing the panel, reloading the window, and
  restarting VS Code.
- **Several branches at once.** Open another branch of the same repository in its own folder and window
  (git worktrees) - run, debug and let the agent work on it while your codebase stays on its branch. A
  one-time setup command per branch, a separate port per branch, and a close that checks for uncommitted and
  unpushed work first and never deletes the branch.

### Reading what you actually work with

- **Word, Excel, HTML and PDF** as plain text, with no extra dependency. A PDF whose fonts
  carry no character map is *reported* rather than returned as garbled text — being told to
  convert the file beats a confident summary of nonsense.
- **Large log files, a page at a time** — read the tail, or a line window, without pulling a
  gigabyte into the context window.
- **Folders outside the workspace**, including Windows network shares. The assistant asks
  when it needs one and shows the resolved path; allow it once, or allow the folder. Reading
  only — edits stay confined to the workspace, because that is what checkpoints can undo.
- **Attach any file**, not only images. Text is included in the message; images go to
  vision-capable models.

### Extending it

- **Python tools the model writes.** Off by default. `uv`-managed, dependency blocks
  installed from your own index, and every tool pinned to a hash of the source you approved —
  a `.py` that changes on disk is refused, not quietly reloaded. A tool can declare
  `__always_ask__ = True` so it asks before every run, for everyone who has it, and a list of
  **banned calls** (`os.system`, `subprocess`, any `library.function`) refuses every tool that uses one.
  Approving a tool's code once covers the VS Code extension, the Node host and Fire Code on the same
  machine.
- **Skills**: markdown you or the assistant writes down about your codebase. Only the name
  and one-line description cost context; the body is read on demand. Several folders
  supported, including read-only shared ones.
- **A team repository for skills and tools.** With Bitbucket set up, point it at a repository (and a
  branch, if main is protected): your skills and tools are committed there as you write them, and
  your colleagues' are brought back every few minutes. Nothing is overwritten - a file changed on both
  sides is reported, under Settings → Usage → *Needs attention* with anything else that failed in the
  background.
- **Semantic search over your code and over the tool catalogue** — against a local **Qdrant**
  or **Chroma** container, or an **OpenSearch** cluster you already run. Opt-in and disabled by
  default, with a dispatcher that keeps tool schemas out of the prompt when you have more tools
  than context. The local backends mean your code is embedded and stored on your own machine.
  Moving between stores copies the vectors across rather than re-embedding everything.
- **Scheduled prompts** that run on their own, each with an explicit allowlist of the tools
  it may use — the default is none. Runs happen in the background without touching the
  conversation you are in, and leave a transcript you can open in an editor tab.
- **Notifications**, including a Markdown report the notification can open.

### Watching and steering the agent

- **The Auditor** records everything the agent does — every request, reasoning step, tool call,
  approval and result — to a journal on your machine (and, optionally, your own OpenSearch
  index), and alerts you to dangerous or refused actions. **Report on this chat** tells you which
  roles and models took part and, request by request, what happened behind the scenes: each
  decision model choice with its probability, each reranker run, the memory used, specialists
  consulted, retries — so you can check things went the way you wanted.
- **The Anti Hallucinator** is a second model reviewing each step as it happens. It tells the
  agent when it claims something the evidence does not support, drifts from your request, or
  loops — and holds it to the guidance in the codebase's memory.
- Both run as separate processes with their own context, and hand off to a fresh process before
  their context fills.

### A team of specialists

- **Agent team mode** consults specialist roles — planner, tester, reviewer, or roles you define —
  each in its own process and context, so the main chat stays lean.
- **Every seat takes a provider and then a model from it**: one provider profile serves every
  role, the decision model, the reranker and the reviewers, each on the model you pick.
- **Strategies**: draw how the specialists work together, in the Strategy window (any mode, once a
  specialist is assigned), and the flow is held to the drawing:
  - **The plan follows it.** The main agent proposes a plan that carries out every step, in order, and
    you approve it. Each step can carry its own instructions (with `@` files) for that specialist.
  - **Loops are enforced, not suggested.** A back-and-forth connector (tester ↔ programmer) runs until
    its condition is met or its round limit is reached; one round past the limit is refused before any
    model is asked. The judging role says MET or NOT MET - or the decision model decides, when one is
    set up. A new topic in the same chat starts the loops again.
  - **Boxes**: steps in a *parallel* box are consulted at once, each specialist in its own process;
    steps in a *together* box are all done before the flow moves on. A box can be connected like a step.
  - **Decision steps**: after a step, the decision model chooses which connector to follow next.
  - **Contracts**: a connector can say what must be handed over, item by item. Each hand-over is
    checked; a missing item is asked for again (twice at most), and the main agent is told what is
    still missing. The agent can propose contracts for connectors that have none - you approve them.
  - **Hand-overs go specialist to specialist**: each gets the previous step's full answer directly,
    while the main chat receives only a short summary, so its context stays lean.
  - **You can see where it is**: the window lights up the step working now, each loop's round and
    verdict, and every exchange - what was asked, answered, refused or asked again - which the agent
    can also read back with `strategy_history` to explain why it went back and forth.
  - Strategies are saved to a library and chosen per chat; a chat keeps its strategy through reloads,
    a handoff, and a new chat started from it.
- **A decision model** (such as D3 from vLLM Semantic Router) can route each message to the right
  specialist, judge loop conditions, choose a strategy's next step, and pick the skill and tool a
  request needs — with calibrated probabilities, never granting anything.
- **A reranker** (such as BGE) sharpens finding tools, skills, team skills and code — and, with a
  decision model, narrows the choice to the best ten before it decides.

### Your organisation's tools

- **Confluence, Jira, Bitbucket, Jenkins and AutoSys** — read and write with your own token; every
  change shown and approved first. AutoSys answers run times, ETAs, usual start times and every
  predecessor of a job.
- **Your organisation's own web chat** (such as an internal Gemini) as a consultant, through your
  own Chrome — only to the backend address you approved.
- **GitHub Copilot's models**, reused from VS Code, in Fire Code and the Node host too.
- **Reading a paused debug session**, any language: the call stack, variables, a DataFrame's
  columns — and, with your approval, an expression such as `df.head(50).to_string()`.
- **HTTP MCP servers behind your certificates**: the Windows certificate store, a CA file per
  server, or — knowingly — no verification.

### Spending less

- **A cheaper model with an expert.** A cheap model does the work and consults Claude — through
  your own Claude CLI — or any stronger model for the plan. Consultations continue a single
  conversation, which measured about nineteen times cheaper than starting cold each time.
- **A budget for that expert**, per chat: stop after so many dollars or so many
  consultations. Set it in the chat header, adjust it mid-conversation, and the expert is
  told what remains so it plans to fit. It also **estimates what the task will cost** when it
  gives you the plan, so you can set the budget before the work starts rather than after.
- **The expert can assess your cheaper model.** It puts five short probes to it, grades the
  actual answers, and tells you what to trust it with — then sizes its own plans accordingly.
  A judgement about the model in front of it, not a recollection about a model name.
- **A context budget you can see:** system prompt, tool definitions, conversation, and tool
  results, with cache hit rate.

## What it deliberately does not do

Minimalism is the point, not a stage it will grow out of:

- No browser automation. If you want it, configure a Chrome DevTools MCP server yourself.
- No OCR, and no attempt to guess at a PDF it cannot decode.
- No telemetry, no update checks, no remote assets, no analytics sent to anyone. The usage
  dashboard (Settings → Usage) collects only into a store your team already configured - an
  OpenSearch or other vector store, a team S3 bucket, or a shared folder you choose - and writes
  only there: names and times, never your arguments or files. It can be stopped per machine.
  To show people by name it reads the company directory (Windows' own sign-in, search only) on a
  domain-joined Windows machine.
- No cloud account, no sign-in, no hosted component.

---

## Getting started

1. Install the extension and click the Light Code icon in the Activity Bar.
2. Open Settings (the icon in the panel header) → **Providers** → **Add Provider**.
3. Pick a preset and paste an API key - the model list appears by itself - choose a model, and **Save**.
4. Start chatting.

Everything is configured through the panel. You never need to hand-edit a file, though you
can — the settings UI and the config file share one schema, so both fail the same way.

### Several codebases at once, on Windows

**Fire Code** puts every codebase you work on in one window, each with its own Light Code
agent working in parallel — background chats keep going while you look at another, and agents in
different codebases can ask each other for help. A Rust helper reads huge logs, CSV, Excel and
SQLite files and searches network shares in seconds; a monitoring dashboard runs checks you
describe in chat; JupyterHub folders open as codebases. It can use the
settings a codebase already has (the VS Code extension's, or IntelliJ/PyCharm's), installs with
`npm i -g @chosengeneration/fire-code` without compiling or downloading anything, and is
described in [apps/sun/README.md](apps/sun/README.md).

### Where things are stored

| What | Where |
|---|---|
| Config | The extension's global storage, or `.lightcode/config.json` for workspace scope |
| Secrets | VS Code `SecretStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux) |
| Conversations | Global storage, per workspace |
| Approved Python tool code | `%LOCALAPPDATA%light-codeapprovals` (Windows), shared by the extension, the Node host and Fire Code |

API keys, certificate passphrases, and OAuth secrets are stored as *references*. The config
file only ever holds a pointer, never a value — so exporting your config to share a working
gateway setup is safe by construction rather than by redaction.

---

## Security

Read this before using it anywhere sensitive.

### The boundary

> Light Code makes no network connection you have not configured. It ships with zero default
> endpoints, no telemetry, no update checks, and no remote assets. The only hosts it
> contacts are the model gateway, the MCP servers, and — if you enable indexing — the vector
> store and embedding endpoint named in your config. Each other integration you switch on (S3,
> Confluence, Jira, Bitbucket, Jenkins, AutoSys, the usage dashboard's shared store, a JupyterHub codebase in Fire Code,
> the decision model, the reranker, the Auditor's and Anti Hallucinator's models, your organisation's web chat) contacts
> only the address you gave it — the web chat only the backend address you approved. Through `http_request`, the agent
> can reach only hosts you name in the chat, and every request asks first.

**Indexing is the largest egress in the product.** Enabling it sends the contents of your
workspace to the embedding endpoint you configured. It is opt-in, ships disabled, and
confirms the destination the first time you use it.

**Enabling the expert spends money on your Claude account.** It is off by default, nothing
is spawned until you turn it on, and every consultation's cost appears in the chat.

### What is *outside* that boundary

**Light Code does not sandbox anything it runs on your instruction.** Shell commands, MCP
servers, Python tools, and the Claude CLI execute with your full user privileges, with
access to your files, your network, and your environment. This is the same trust model as
running the command yourself in a terminal.

**It does not protect you from another process running as the same user.** Anything that can
read your VS Code storage can read your config. Secrets go to the OS keychain, which raises
the bar, but a process running as you is not an attacker this can defend against.

We would rather say this plainly than imply protection that does not exist.

### What it does defend against

- **A hostile repository cannot repoint your credentials.** Provider profiles, the active
  profile, certificate directories, and approval settings are user-scope only, and are
  ignored if found in a workspace config file. Cloning a repo cannot make Light Code talk to
  someone else's gateway, nor pre-approve its own shell commands.
- **Approval shows ground truth.** The prompt renders the literal command and the real
  computed diff, so a model cannot describe one action and perform another.
- **"Always allow" is exact-match, byte for byte.** Allowing `npm test` allows exactly
  `npm test`. `npm test; rm -rf /` is a different string and still prompts. There is no
  pattern or prefix matching, deliberately — a parsing bug in one would auto-approve a
  chained destructive command.
- **The model must read a file before editing it**, which eliminates a class of hallucinated
  edits.
- **Certificate and key files must live outside the workspace**, and their paths are on a
  hard deny list for every file-reading tool.
- **Secrets are write-only across the UI boundary.** The interface can ask whether a secret
  is set; it can never read one back.

Reporting a vulnerability: see [SECURITY.md](SECURITY.md).

---

## Building from source

Requires Node 17+ and pnpm (Node 20+ to develop; the published package runs on 17).

```bash
pnpm install --ignore-scripts   # --ignore-scripts is deliberate; see CLAUDE.md invariant 4
pnpm build
pnpm test
pnpm package                    # produces a .vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host.

Fire Code (`apps/sun`) also needs Rust 1.86+ with the MSVC toolchain:
`node apps/sun/scripts/build.mjs` builds the host, the exe and the npm package, and
`node apps/sun/scripts/smoke.mjs` installs that package with plain npm and runs it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). [CLAUDE.md](CLAUDE.md) is the durable record of
design decisions and the reasons behind them — read it before proposing a change to
anything it covers.

## Credits

Built greenfield, using the archived [Roo Code](https://github.com/RooCodeInc/Roo-Code)
(Apache-2.0) as a frozen reference for proven formats and patterns — notably the
search/replace diff format that models are heavily trained on. Not a fork, and no code
copied without attribution.

## License

MIT.
