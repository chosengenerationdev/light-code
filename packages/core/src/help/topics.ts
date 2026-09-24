/**
 * What Light Code knows about itself.
 *
 * ## Why this exists
 *
 * Asked for directly: *"possible to provide built knowledge about light code to light code
 * itself, so that it can answer me on how to use certain features or how to make certain config
 * changes?"* The assistant can read the workspace it is opened in, and it has no idea what the
 * product it is running inside can do — so "how do I switch Excel on?" was a question only the
 * documentation could answer, and only if you knew which documentation.
 *
 * ## Why a bundled corpus rather than retrieval
 *
 * `search_docs` would be the obvious home, and it is the wrong one: it needs an embedder and a
 * vector store, both opt-in and both off by default (§12). A help system that only works once
 * you have configured a search backend is a help system that is absent exactly when somebody is
 * stuck on configuring things. This is plain text in the bundle, matched lexically, and it works
 * on a fresh install with nothing set up.
 *
 * ## Why it is a tool rather than prompt text
 *
 * The whole handbook is far too large for the system prompt, and §12's rule about the cached
 * prefix means it could not be swapped in per turn even if it were affordable. As a tool it
 * arrives as a tool *result*, mid-conversation, where it costs nothing at the prefix — precisely
 * the carve-out §12 already makes for retrieval.
 *
 * ## The thing that keeps it honest
 *
 * **A document that describes a product it has drifted from is worse than no document**, because
 * somebody reads it and stops looking — §14 records that happening to `docs/hosting.md`. So
 * `topics.test.ts` reads every `config:` key named below and fails if the schema does not have
 * it, and checks every mode id against `BUILTIN_MODES` and every settings tab against the panel.
 * A renamed key breaks the build rather than misleading somebody a year later.
 *
 * That check only covers what is checkable. Prose can still go stale, so **keep entries short and
 * about mechanisms rather than about screens**: a sentence describing where a button sits is the
 * first thing to become false.
 */

export interface HelpTopic {
  /** Stable id, used as the `topic` argument. */
  id: string
  title: string
  /**
   * Extra words somebody might search for that do not appear in the title.
   *
   * The words people actually type are rarely the words a feature is called — "permission",
   * "keeps asking", "stop asking" all mean the approval gate, and none of them is its name.
   */
  keywords: string[]
  body: string
}

/*
 * Config keys are written as `config:some.key`, and that marker is what the test greps for.
 *
 * A bare backtick would mean picking keys out of prose with a regex and guessing which code spans
 * were meant to be keys — so the marker is explicit, and anything not marked is not claimed to be
 * one. It is stripped before the text reaches the model.
 */
export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    id: 'overview',
    title: 'What Light Code is, and where its settings live',
    keywords: ['start', 'begin', 'setup', 'install', 'config file', 'settings', 'json'],
    body: `
Light Code is a minimal agentic coding assistant: a chat panel, a small set of tools, and an
approval gate in front of everything that acts. It ships with **no default endpoints** — a fresh
install contacts nothing until a provider is configured.

**Settings** is the gear icon in the chat header. It has these tabs: Providers, Approvals, MCP,
Search, Agents, Schedules, Python, Tools, Outlook, Custom data, Skills, Network, Review,
Variables, Appearance.

**Everything the panel writes goes into one JSON file**, and that file can be hand-edited — the UI
and the loader share one schema, so a bad hand-edit and a bad save fail identically.

- **User scope** (yours, all projects). In VS Code on Windows:
  \`%APPDATA%\\Code\\User\\globalStorage\\chosengeneration.light-code-vscode\\config.json\`.
  On the Node host it is under the data directory, per user.
- **Workspace scope**: \`.lightcode/config.json\` in the repository.

**Some keys are ignored if a repository sets them**, deliberately: credentials, the provider list,
Python, Office, mail, command rules and a few others. A repository you clone must not be able to
repoint your gateway, pre-approve its own shell commands, or choose which interpreter runs. The
Settings panel marks these, and a key found in workspace scope is reported as ignored rather than
silently dropped.

**Settings can still vary per project** even so — that is a different question from who may write
them. Search connections have a "Use in this project" button, and the Search tab lists what this
project has overridden.
`,
  },
  {
    id: 'modes',
    title: 'Modes: Code, Ask, Auto and Agent team',
    keywords: ['mode', 'switch', 'read only', 'shell first', 'auto mode', 'junior', 'team'],
    body: `
The mode picker sits **above the message box**, next to the profile picker. Mode is resolved once
per turn, so switching takes effect on your next message.

- **Code** — everything: read, edit, run commands, MCP tools.
- **Ask** — read-only. It can inspect and answer but cannot edit or run anything. This *is* the
  read-only mode; there is no separate switch.
- **Auto** — the same powers as Code, worked differently: it reads with \`cat\`, searches with
  \`grep\`, and makes mechanical changes in the shell, keeping \`apply_diff\` for edits worth
  reading as a diff. **It is the only mode where read-only commands run without asking.**
- **Agent team** — you lead and specialists are consulted. Needs at least one agent configured in
  the Agents tab, or it is an ordinary Code session being told to consult somebody who is not
  there.

The stored value is config:modeId. If it names a mode that no longer exists, it falls back to
Code. \`junior\` is an old name that now resolves to Agent team.

**What Auto mode trades:** \`apply_diff\` shows you what will change and you approve *that*;
\`sed -i 's/a/b/' file\` is ground truth about the command and says nothing about the file
afterwards. You are still shown exactly what will run — but reading a command is not as easy as
reading a change, which is why content edits stay on the diff tools.

**\`cat\` is not \`read_file\`.** A file must have been read with \`read_file\` in this session
before it can be edited, and reading it in the terminal does not count.

**Which shell commands run in.** On Windows it is **cmd.exe** by default, not PowerShell — so
cmdlets like \`Get-ChildItem\` fail with "is not recognized". Auto mode's instructions are built
from the shell that will actually run and from the tools really on PATH, so the assistant is told
the truth rather than a guess. **Settings -> Approvals -> "Shell commands run in"** changes it,
and states which shell is running right now and which tools are missing from this machine
(config:commands.shell). Set it to \`powershell.exe\` or
\`pwsh\` if you would rather. The default is left alone on purpose: in PowerShell, \`ls\`,
\`sort\`, \`diff\` and \`where\` are cmdlet aliases and fail on GNU arguments like \`ls -la\`.

**In Auto mode, do not chain commands to save approvals — it costs one.** Anything containing
\`&\`, \`|\`, \`;\`, a redirect or \`$\` can never be auto-approved, so three separate reads are
free where the same three joined together stop and ask.
`,
  },
  {
    id: 'approvals',
    title: 'Approvals: stopping it asking about everything',
    keywords: [
      'approve', 'permission', 'keeps asking', 'stop asking', 'auto approve', 'always allow',
      'prompt', 'confirm', 'allowlist', 'safe commands', 'risky',
    ],
    body: `
**Settings → Approvals.** Everything here ships off: nothing is auto-approved until you say so.

**Category toggles** — read / edit / command / MCP. Blunt instruments, and "commands" is the
broadest grant in the product.

**Always-allowed commands** are **exact matches, byte for byte**, added from the "Always allow"
button on a prompt. Allowing \`npm test\` does not allow \`npm test && something-else\` — that is
a different string. This is deliberate and will not become prefix matching: deciding whether a
pattern *covers* a command means parsing the shell, and a bug there silently approves a chained
destructive command.

**Command rules** (also Approvals) are global rather than per-project, and are the two lists that
make Auto mode usable:

- **Always ask about** (config:commands.risky) — matched anywhere in the command, case-insensitive,
  checked **before everything else**. A rule here beats an always-allowed command and every toggle.
  Tick "Never run" to refuse outright instead of asking. Built-ins cover recursive deletes, force
  pushes, dropping tables and piping a download into a shell; config:commands.builtinRisky turns
  them off.
- **Run without asking, in Auto mode** (config:commands.safe) — matched at the **start** of the
  command. config:commands.builtinSafe turns the built-in list off. Both lists are shown in full
  in the panel, so you can see whether something is already covered before adding it.

**Why a command you think is safe still asks**, in order of likelihood:

1. **You are not in Auto mode.** The safe list applies there and nowhere else. The panel says so.
2. **It could be more than one command.** Anything containing \`;\` \`&\` \`|\` \`>\` \`<\`
   backtick \`$\` or brackets never qualifies, whatever it starts with — so \`grep foo && rm -rf /\`
   always asks. There is no shell grammar to get wrong, only a character test.
3. **It is not on the list.** Add it, in the same panel.

**Some tools always ask, whatever is switched on**: creating or changing a Python tool, writing or
deleting a skill, writing or running a macro, changing the plan, and composing mail. These write
code that later runs, or prose later injected into context, so a human sees the source once.

**Reading outside the workspace** is asked for in the chat, showing the resolved path. Writing
stays inside the workspace whatever you allow, because checkpoints only snapshot the workspace.
Folders you always want readable go in config:filesystem.readRoots.
`,
  },
  {
    id: 'providers',
    title: 'Providers, models and corporate gateways',
    keywords: [
      'provider', 'api key', 'model', 'gateway', 'openai', 'anthropic', 'gemini', 'deepseek',
      'mtls', 'certificate', 'proxy', 'ca', 'token', '401', 'profile',
    ],
    body: `
**Settings → Providers.** Several named profiles, switchable from the composer. Three wire
formats: OpenAI-compatible, Anthropic Messages, and Gemini. Presets prefill a base URL and wire
format; every field stays editable and no endpoint is hardcoded.

The profile list is config:profiles and the active one config:activeProfileId. Both are user-scope
only — a repository must never be able to repoint where your prompts and your key go.

**The model dropdown is never a hard dependency.** It is filled from the provider's models
endpoint, which gateways frequently answer with their own catalogue or a 404, so free-text entry
is always available. Context window, vision and tool support come from a local table and can be
overridden per profile; an unknown id defaults conservatively.

**Auth is a separate axis from wire format**, so any strategy composes with any adapter:

- **API key** — the header name is derived from the wire format (\`x-api-key\`,
  \`x-goog-api-key\`, \`Authorization: Bearer\`). Getting that wrong is a 401 that reads like a
  bad key.
- **Apigee mTLS** — a client-credentials grant over mutual TLS, *replacing* the API key rather
  than supplementing it. Every gateway-specific field is configurable with a working default:
  token URL, grant type, scope, the JSON paths the token and its expiry are read from, the header
  name and prefix, and a fallback expiry for gateways that omit one.

**Connection trust and client identity are different things.** A client certificate is how the
gateway identifies you; a CA is how you decide the gateway is who it claims. **Settings → Network**
holds config:tls — CA, client certificate, key or PFX, and passphrase — configured **once,
globally**, and applied to every connection: the gateway, the token endpoint, search backends and
the embedder. A single connection can layer over it. Do not configure a CA in four places.

Certificates and keys must live **outside the workspace**, and their paths are on a deny list for
every file-reading tool.

**Test Connection**, in the advanced section, runs load-certs → get-token → list-models and tells
you **which step failed**. It is the fastest way to turn an opaque TLS or OAuth failure into a
diagnosis.

**Behind a proxy?** Settings → Network reports what the environment says. A corporate root CA that
your proxy presents goes in the same place; adding one does not cost you the public roots.
`,
  },
  {
    id: 'skills',
    title: 'Skills: teaching it things it cannot work out',
    keywords: ['skill', 'teach', 'instructions', 'standing', 'always', 'master skill', 'markdown'],
    body: `
A skill is markdown with frontmatter (\`name\`, \`description\`), kept in the workspace so it lands
in git and gets reviewed. **Settings → Skills.**

Only the name and description of each skill reach the system prompt — a few tokens each — and the
body is read on demand. That is what lets a skill be as long as it needs to be.

**Two file layouts are read**, so a folder of skills copied from elsewhere works unchanged:
\`skill-name.md\`, and \`skill-name/SKILL.md\`.

**\`always: true\`** in the frontmatter injects that skill **in full, in every session**. Use it for
standing instructions — house style, the name of the internal library, how your team writes
commits. It is paid for on every request, so keep it short. The Skills tab names the skill that
carries this flag, or offers to create one.

**Folders**: config:skills.dir is the one written to, and config:skills.paths are read-only extras
searched after it. Earlier folders win a name collision and a shadowed skill is reported rather
than dropped.

**Reference files.** A skill can carry a template — a spreadsheet, a document — in its own folder,
and the assistant copies it into the workspace with \`use_skill_file\` rather than reading the
bytes into the conversation. Describe each file in one line in the skill body; a file nobody
described is one the assistant will never know to reach for.

**Moving them.** Changed where skills live, or turned a bucket on after you already had some?
Settings -> Skills -> "Bring skills in from another folder" copies them in. Nothing is moved and
nothing is overwritten: the old folder is untouched and a name already present is skipped and
named back to you. The same section offers a one-off upload of everything you already have to a
bucket folder marked "Save new here" - the automatic publish only fires on a *write*, so it never
covered what was there before. Settings -> Python has the same for tools, where a copied tool
arrives **unapproved** because approvals are recorded per folder.

**Sharing.** Skills can be published to a team collection and found with \`search_team_skills\`,
or mirrored from an S3 bucket. Everyone publishes to their own collection and an alias spans them,
so one person re-indexing never disturbs anybody else.

A skill is **prose nobody code-reviews that steers every conversation that finds it**. That is why
writing one always asks for approval, whatever else is auto-approved, and why plain markdown in
git is the main defence.
`,
  },
  {
    id: 'python-tools',
    /*
     * "written", not "writes". The same trap as Checkpoints' old title: a generic verb in a
     * title scores as the subject, and "can it write an email for me" landed here rather than
     * on Office. The past participle carries the same meaning and does not collide with the
     * verb somebody types.
     */
    title: 'Python tools written by the assistant',
    keywords: ['python', 'tool', 'uv', 'venv', 'dependencies', 'pip', 'dynamic', 'registry'],
    body: `
**Settings → Python.** Off by default — set config:python.dynamicTools to \`on\`. This is the
sharpest surface in the product: it makes the *body* of a tool model-authored, not just the call.

One file per tool, a \`run\` function, dependencies in a PEP 723 block. The schema comes from the
type hints and the description from the docstring — nothing is hand-maintained, so nothing drifts.

**The registry is the security boundary, not the prompt.** Approval records a hash of the exact
source you were shown. A file whose hash no longer matches is refused and reported; a \`.py\` with
no registry entry never loads at all. So a tool that arrives from a bucket, or in a repository you
cloned, is inert until you have read it and said yes. Saying no is recoverable and deletes nothing.

**Which Python.** A virtualenv the project already has is preferred over creating one — that is
where your internal libraries live, and a private venv would be empty. config:python.venvPath
overrides it; config:python.interpreterPath points at an interpreter directly, for a conda
environment or a container image where installing uv makes no sense. In that mode nothing is
installed or removed: that environment belongs to whatever built it.

**Dependencies** install before validation, so a failure names the package rather than surfacing
as an ImportError from inside the worker. config:python.indexUrl points at an internal mirror and
config:python.offline refuses the network.

**Environment variables for tools** (config:python.env) are declared once and applied to every
Python child, so a host and a token do not have to be written into each tool's source — where they
would land in the workspace and get committed. A value can be marked secret, in which case it
lives in secret storage and never in the config file. The worker restarts when the declaration
changes.

**Provider API keys are never passed into the Python environment.** The environment is an
allow-list, not an inheritance.

A created tool becomes callable on your **next** message, not later in the same turn — tool
definitions have to stay stable for a whole turn or the prompt cache is thrown away.
`,
  },
  {
    id: 'mcp',
    title: 'MCP servers',
    keywords: ['mcp', 'server', 'stdio', 'http', 'tools', 'npx', 'timeout', 'disable'],
    body: `
**Settings → MCP.** The config shape is the standard \`mcpServers\` one, so a config copied from
another client can be pasted unchanged. Transport is inferred: \`command\` means stdio, \`url\`
means Streamable HTTP.

Servers connect **when the Light Code panel opens**, not at editor startup, and their health is
shown in the tab with a restart button. A mistyped command tells you so immediately rather than
the first time something happens to need it.

**Every tool is namespaced** (\`filesystem__read_file\`), because collisions between servers are
inevitable.

**Per-server and per-tool switches from the start**, because one server can expose forty tools and
they all land in the system prompt. Each tool is Always / Ask / Never. **Never beats Always**, so a
stale allow-entry can never resurrect a tool you have since hidden.

**Timeouts resolve most-specific-first**: the tool's own limit, then the server's, then the
default. Twenty quick lookups and one four-minute report on the same server is the normal case, and
raising the server's limit to suit the slow one would make a genuinely hung quick call hang for
four minutes too.

**Secrets** are written as \`${'$'}{secret:NAME}\` and resolved from secret storage when the server is
spawned. They are never written into the config file.

**A package-runner command** (\`npx -y ...\`) fetches from the internet when the panel opens. The
tab warns about it, because that is machinery Light Code chose rather than a host you configured.

An MCP tool goes through the same approval gate as everything else — that is why servers may be
configured per workspace when credentials may not.
`,
  },
  {
    id: 'search',
    title: 'Indexing and semantic search',
    keywords: [
      'search', 'index', 'embedding', 'vector', 'opensearch', 'qdrant', 'chroma', 'rag',
      'codebase', 'team', 'dispatcher',
    ],
    body: `
**Settings → Search.** Opt-in and **off by default**, and it is the largest egress in the product:
enabling it sends the contents of your workspace to the embedding endpoint you configure. It says
so, and confirms the destination the first time.

Three backends behind one interface: OpenSearch, Qdrant and Chroma. config:vectorStores holds the
connections, config:activeVectorStoreId the current one, config:embedder the embedding endpoint and
model, and config:retrieval the rest. All user-scope only — a repository able to set the embedder
URL would exfiltrate your source the moment you opened it.

**Retrieval is exposed as tools the model calls**, never as tool definitions that change per turn.
\`search_codebase\` and \`search_docs\` return results as tool *results*, mid-conversation, where
they cost nothing at the front of the prompt.

**Team search.** \`search_codebase\` takes a scope: \`mine\` or \`team\`. Everyone writes to their
own index and an alias spans them, so one person re-indexing never disturbs anyone else. **A hit
from somebody else's checkout is checked against your filesystem and marked
\`NOT IN THIS WORKSPACE\`** — attribution is a label and can be wrong, but whether a file exists
here is a fact, and it is settled rather than assumed. Team scope is OpenSearch only, and absent
elsewhere rather than emulated.

**The dispatcher** is on by default. Tools are registered but not advertised, and the model finds
them with \`search_docs\` — so the prompt does not grow with the size of your tool catalogue. It
is a prompt-size control and **not** a security control: a hidden tool is still callable. Use
modes and the approval gate to withhold a capability.

**If a switch here breaks nothing when it fails, that is deliberate.** With the backend down,
\`search_docs\` falls back to matching names, the search tools are simply not offered, and chat,
editing, commands and MCP never touch it.
`,
  },
  {
    id: 'office',
    title: 'Excel and Outlook on Windows',
    keywords: [
      'excel', 'outlook', 'spreadsheet', 'workbook', 'email', 'mail', 'macro', 'vba', 'com',
      'draft', 'attachment', 'compose',
      'write an email', 'send an email', 'write a mail', 'draft an email',
    ],
    body: `
**Settings → Tools** for the switches, **Settings → Outlook** for the mail index. Both off by
default, both **user-scope only** (config:office), and **Windows only** — they attach over COM to
an application on your desktop.

**They attach; they do not launch.** The question people have is about the workbook in front of
them, with unsaved edits, so answering it by starting a second invisible copy would be worse than
refusing. Two exceptions, both because there is nothing to guess at: opening a workbook by a path
you named, and creating a new one.

**Excel.** List open sessions, read ranges, and — the one that justifies the rest —
\`excel_trace_cell\`, which walks a formula back through its precedents, across sheets, to raw
input. That is the "why is this #DIV/0!" question, and Excel's own precedents only cover the
current sheet. Also: create, save and restructure workbooks, evaluate a formula without writing it
anywhere, and read, check and run VBA.

**Every Excel write leaves the workbook dirty on purpose.** Closing without saving is the undo, and
it is the only undo this product has over somebody else's spreadsheet. Saving is therefore its own
separately approved tool.

**VBA needs one Trust Center setting**: "Trust access to the VBA project object model". Without it
the project reads as empty rather than blocked, so the tools say which setting to turn on.

**A saved \`.msg\` file** is read with \`read_document\`, on any platform and with no Outlook
running - subject, from, to, cc, sent time and attachment names above the body. The attachments
themselves are not included; save one out of Outlook to read it.

**Outlook.** List folders, search, read a message, and open one on screen. Mail formatting is
preserved as annotations — in an alerting mailbox the red line often *is* the message, and the
plain-text rendering drops it.

**Composing mail.** \`outlook_create_draft\` fills in recipients, cc, bcc, subject, body,
attachments and images embedded in the body, and **shows it to you**. It cannot send: there is no
send call anywhere in it. You read it and press Send, or close it — closing is what offers to save,
so deciding against it leaves nothing behind.

**Indexed mail** (config:mail) keeps configured folders searchable and answers the questions
embeddings are bad at — "any alerts in the last six hours", "does this happen every day at the same
time". Received time, folder, sender and status tag are exact filters; meaning only ranks what the
filters already produced.
`,
  },
  {
    id: 'schedules',
    title: 'Scheduled prompts and unattended runs',
    keywords: [
      'schedule', 'cron', 'timer', 'unattended', 'background', 'notify', 'report',
      // The words people use for it. Nobody types "unattended"; they type "every morning".
      'every morning', 'every day', 'daily', 'nightly', 'weekly', 'recurring', 'automatically',
      'repeat', 'regularly',
    ],
    body: `
**Settings → Schedules**, or ask the assistant to set one up and approve the result.

A scheduled run has **nobody present to approve anything**, so it does not inherit your
auto-approve settings. Instead it gets an **allowlist**: you tick the tools it may use when you
write the schedule, and that ticking *is* the approval, made in advance for one named job. The
default is nothing.

**Some tools can never be granted to a schedule**, whatever you tick: creating or changing a Python
tool, writing or deleting a skill, running or installing a macro, rewriting the plan, and creating
another schedule. Authorising a *change* and authorising a *capability* are different acts, and the
second needs somebody to read the source.

A run may always **discover** — search documentation, look a tool up, re-read a truncated result —
because none of that reaches the workspace, the network or a process. A hit it may not call is
marked as such, so it reports what it needed instead of spending a step being refused.

**Schedules are bound to the project they were written in** and are claimed before they run, so two
windows open on the same project do not both fire it. A claim from a crashed window is taken over
after an hour, because a nightly job that stops for ever and silently is worse than an occasional
double run.

**A run's report is a file.** Put findings in \`notify\`'s details and keep the one-line message
saying what happened — that line is all that appears on screen, and the report is read in the
morning, by which time a toast is long gone. The run log keeps a Report button.
`,
  },
  {
    id: 'agents',
    title: 'The expert and the agent team',
    keywords: ['expert', 'agent', 'team', 'role', 'reviewer', 'consult', 'claude', 'cost', 'budget'],
    body: `
**Settings → Agents.** Off by default; nothing is spawned and nothing is spent until you enable it.

A cheaper model does the work and consults a stronger one on hard problems. The specialist can be
**the Claude command line** or **any provider profile you have configured** — on a server there is
no \`claude\` binary, and the gateway answering your chat usually has a stronger model behind it.

**The expert is read-only by construction.** It may read, grep and glob the workspace so it gathers
its own context; it cannot edit or run anything. A second agent mutating the repository would sit
entirely outside the approval gate, which is the thing the gate exists for. It is also much
cheaper.

**Roles** are prompts you can read and edit, and changing one always asks — softening a reviewer
does not error, it approves things, in the same tone as before.

**Agent team mode plans first.** With no plan it asks for one and proposes it for your approval;
with a plan it works it. Every consultation carries the roster, including the roles that are *not*
set up, so a plan cannot come back naming a specialist who does not exist.

**Cost, where it is metered.** Only the Claude command line reports a price, and it is **measured
on this machine** rather than assumed from published rates — a corporate plan can price a cold
start an order of magnitude away from the documented figure. A button in the tab measures it. What
the mode saves is reported as a **floor**, with the working on the page, and shows a dash when
nothing has been measured: zero would read as "this saved you nothing", which is a claim and the
wrong one.

Where nothing is metered, the budget controls are **absent** rather than shown at zero. A cap over
a number nothing measures looks like protection and is not.
`,
  },
  {
    id: 'jupyter',
    title: 'Driving it from a Jupyter notebook',
    keywords: ['jupyter', 'notebook', 'kernel', 'ipykernel', 'dataframe', 'session', 'connection'],
    body: `
Python tools can run **inside a live Jupyter kernel**, so they see the session's own state: the
dataframe already loaded, the model already fitted.

From the notebook:

\`\`\`python
import subprocess
from ipykernel import get_connection_file

subprocess.Popen(["light-code", "--jupyter-kernel", get_connection_file()])
\`\`\`

\`LIGHT_CODE_JUPYTER_CONNECTION_FILE\` does the same if you would rather set it when spawning, and
config:python.jupyterConnectionFile sets it in the config file. A session launched with the flag
wins over the config file, because a stored path goes stale the moment that kernel restarts —
Jupyter writes a new connection file each time.

**The notebook has to name its own kernel.** A kernel knows its connection file and nothing outside
it does. From another process the most you can do is list the runtime directory and guess, and with
two kernels running a guess is right most of the time and silently wrong the rest — which here
means running your tool inside somebody else's notebook.

Inside a tool the session is a plain dict:

\`\`\`python
def run(name: str) -> str:
    return f"{name}: {session[name].shape}"
\`\`\`

\`light_code.session\` is the same object for a tool that prefers the import.

Three things to know: \`jupyter_client\` must be importable from the worker's interpreter (it ships
with Jupyter); \`light_code.call_tool\` does not work in this mode and says so rather than hanging;
and a kernel runs one thing at a time, so a tool call waits behind whatever cell you just ran.

Approval is unchanged — a tool was still approved here, with its source shown, before it could be
called at all.
`,
  },
  {
    id: 'context',
    title: 'Context, token cost and long tasks',
    keywords: [
      'context', 'token', 'window', 'truncate', 'compact', 'cost', 'cache', 'steps', 'iterations',
      'limit', 'continue',
    ],
    body: `
The token bar under the composer shows where the window is going — system prompt, tool
definitions, history, results — plus the cache hit rate. The numbers are **estimates** and say so:
a real tokeniser would be a large download and would still be wrong for a gateway that rewrites
the prompt, and what matters is the proportion.

**Results dominate**, not the prompt. So an oversized tool result is capped, the full output is
written to disk, and a handle is returned that the model can re-read with an offset. Nothing is
lost; it is just not all in the window at once.

**Superseded reads are dropped** — if a file was read three times, only the latest matters. Repeated
*commands* are not dropped, because running the tests twice gives two real answers.

**Past a threshold the oldest turns are summarised**, keeping the last few verbatim, and never in
the middle of a tool call. The stored transcript keeps everything; only what is sent to the model
is compacted.

**The step cap** (config:maxIterations, default 25) counts tool calls since you last said
something. If it trips, nothing is lost: send another message and it carries on with the full
transcript. Typing **while a turn is running** grants a fresh 25 as well — the cap exists to stop a
model looping unattended, and somebody typing is evidence that this is not that.

**Prompt caching is why tool definitions do not change mid-session.** They sit at the front of the
prompt, so swapping them to "save context" would throw away the cached prefix *and all the history
after it* — costing more than sending everything. The dispatcher exists so the catalogue can grow
without the prompt growing with it.
`,
  },
  {
    id: 'checkpoints',
    /*
     * Not "undoing a change". A title word is weighted as though it were the subject, and
     * "change" is the commonest word in a help query - "how do I change the colour" landed here
     * rather than on Appearance. A generic verb in a title magnetises every question of that
     * shape, which in a help system is most of them.
     */
    title: 'Checkpoints: rolling back an edit',
    keywords: ['checkpoint', 'undo', 'rollback', 'revert', 'snapshot', 'git', 'mistake'],
    body: `
Before the first edit of a task, Light Code takes a **shadow-git snapshot** of the workspace, and
the Rollback button restores it.

**Your own git repository is never touched** — not the index, not your branches, not your stash,
not your history. It is a separate git directory with your workspace as its work tree.

Rollback also removes files created after the snapshot, because leaving them would produce a state
that never existed. It then tells the model the workspace was reverted and clears what it had
read, so it does not keep editing against content that is no longer there.

**In Auto mode the snapshot is taken before the first command**, not the first edit, because that
is where edits come from there. Without that the Rollback button would be present and cover
nothing, which is worse than not having one.

**If a snapshot cannot be taken, the edit does not happen.** Editing anyway would leave you
believing you can undo something you cannot. If \`git\` is missing entirely, checkpoints are
disabled with a warning rather than the session breaking.

Conversations survive closing the panel, reloading the window and restarting the editor. A resumed
task must **re-read a file before editing it**, deliberately: the file may have changed since the
transcript was written.
`,
  },
  {
    id: 'appearance',
    title: 'Appearance: theme, accent and the guide',
    keywords: [
      'colour', 'color', 'theme', 'dark', 'light', 'accent', 'font', 'look', 'ui', 'walkthrough',
      'guide', 'tour', 'help',
      // Phrases, which score above their words: "dark mode" would otherwise go to Modes, where
      // "mode" is a keyword and the subject is something else entirely.
      'dark mode', 'light mode', 'change the colour', 'change the color',
    ],
    body: `
**Settings → Appearance.**

**Accent colour** (config:ui.accentColor) and **expert colour** (config:ui.expertColor), both hex.
They are two colours rather than one because a single colour cannot mean both "this is Light Code"
and "this is *not* the model you are talking to". The expert colour marks text that came from a
consulted specialist rather than from the primary model; a reply that was merely *informed* by one
gets a small chip instead, because that text is the primary model's own words.

Text colour on either is computed rather than fixed, so a pale accent still reads.

**Light or dark** (config:ui.theme) is offered **only where the host has no theme of its own** —
in VS Code the editor's theme is the answer and a second control would fight it. In the browser it
is \`system\`, \`light\` or \`dark\`, because \`prefers-color-scheme\` follows the *browser's*
setting, and a corporate browser pinned to light shows a light panel on a dark desktop with no way
out.

Everything else follows the editor's theme through its own CSS variables, so Light Code tracks
whatever you have active rather than a fixed palette.

**The guide** is the button in the chat header, not buried in Settings — help you can only reach
after you have navigated is help for people who no longer need it. In VS Code it opens the
walkthrough, whose steps link straight into the tab each one is about. On the Node host,
\`light-code --guide\` serves the operator documentation as a page.
`,
  },
  {
    id: 'troubleshooting',
    title: 'When something is not working',
    keywords: [
      'broken', 'not working', 'error', 'fails', 'missing', 'gone', 'lost', 'why', 'help',
      'debug', 'slow', 'timeout',
      // The `@` picker lives here rather than in a topic of its own, so it needs the words
      // somebody would use for it - the symbol itself does not survive tokenising.
      'mention', 'mentions', 'picker', 'autocomplete', 'attach', 'finding', 'cannot find',
      'does not find', 'excluded', 'hidden',
      // "nothing happened" is how people report a turn that ended silently, and it matched no
      // topic at all - so the best score was body noise from somewhere unrelated.
      'nothing happens', 'nothing happened', 'no response', 'stuck', 'hangs', 'hung', 'frozen',
      'silent', 'crashed', 'stopped',
    ],
    body: `
**Several settings appear to have been forgotten at once** — suspect the config *file*, not the
features. One damaged file reads as the expert vanishing, approvals being asked again and skills
disappearing, all at the same time. Writes are atomic and serialised now, and a file that will not
parse is restored from the last good copy with the damaged one kept aside.

**It keeps asking permission for read-only commands** — check the mode picker first. The safe
command list applies in **Auto mode only**, and the Approvals panel says whether it is in force.
Then check that the command is on the list, which the panel shows in full.

**\`@\` does not find a file** — the picker searches the workspace only, and skips \`node_modules\`,
\`.venv\`, build output and similar. config:filesystem.excludeFromMentions changes that list. Typing
more of the name narrows it; matching is case-insensitive and matches letters in order, so
\`mrank\` finds \`mentionRanking.ts\`.

**A tool call times out** — config:tools.timeoutSeconds is the global limit, and a single tool or
MCP server can have its own; the Tools tab shows which number applies. If raising it changes
nothing, stop raising it: a timeout is the right instrument for something slow and the wrong one
for something that is not going to finish.

**A command fails with "is not recognized"** — you are in cmd.exe, and something emitted
PowerShell. Settings -> Approvals -> "Shell commands run in" says which shell is actually running
and switches it (config:commands.shell). The same
message for \`grep\` or \`sed\` means this machine has no Git-for-Windows tools on PATH; Auto mode
detects that and says so in its own instructions.

**An MCP server will not start** — the MCP tab keeps its stderr. A package-runner command needs the
network when the panel opens.

**A Python tool will not run** — it is probably unapproved. One that arrived from a bucket or a
repository has no registry entry on this machine and stays inert until you read its source and say
yes. The list of those sits above the message box.

**Excel says there is no open session** — if Excel really is running, a privilege mismatch is the
usual cause: an editor started as administrator cannot reach an Excel that was not, or the reverse.

**A skill was added by hand and does not appear** — folders are watched, so it should be immediate.
Check the frontmatter parses and that the file is \`name.md\` or \`name/SKILL.md\`.

**Nothing at all is happening** — the output channel named "Light Code" has the turn log.
`,
  },
]
