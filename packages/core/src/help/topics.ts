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
**Some tools ask every time and offer no "Always allow"** — whatever the auto-approve switches say:
writing Python tools and skills, installing Python packages, writing to Jira, Confluence and
Bitbucket, starting, stopping or replaying Jenkins builds, and sending AutoSys events or applying
JIL. They change something shared or run code, so each one is read before it happens. Reading tools
can always be allowed.

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
bucket folder marked "Publish new … here". Settings -> Python has the same for tools, where a copied
tool arrives **unapproved** because approvals are recorded per folder.

**A bucket folder marked "Publish new … here" is where new skills are saved** — not the project's
\`.lightcode/skills\` with a copy uploaded. The file lands in the bucket's local mirror and goes up
straight away. An explicitly set config:skills (dir) still wins. Skills already in the project folder
keep loading until you upload them.

**Every skill says who wrote it and where it belongs**: \`author\`, \`project\`, \`version\` and
\`updated\` in its frontmatter, written automatically on each save — author and project once, the
version up by one each time. The Skills tab shows them. Settings -> Project -> "Label existing skills
and tools" adds version and time to older files, and author and project only where you tick them.

**Sharing.** Skills can be published to a team collection and found with \`search_team_skills\`,
or mirrored from an S3 bucket. Everyone publishes to their own collection and an alias spans them,
so one person re-indexing never disturbs anybody else. The team skills aliases, sending, and the
team search test are in **Settings -> Project -> Team skills**. Searches return this project's
skills by default; say "all projects", another project's name, or a person to widen or change that.

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
    keywords: [
      'python', 'tool', 'uv', 'venv', 'dependencies', 'pip', 'dynamic', 'registry', 'missing package',
      'install package', 'module not found', 'library', 'approve tool',
    ],
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

**Missing packages are spotted before they fail.** Tools arriving from a bucket often need packages
this machine's environment lacks. Light Code checks every tool's declared dependencies and imports
against the environment; a tool that needs something missing says so in its description, the
Python tab lists it, and a failed call naming the missing module says what to do. The assistant can
install them with \`install_python_packages\` — it asks first and shows the exact \`uv pip install\`
command, using config:python (indexUrl). A tool waiting for approval that cannot load until a package
exists shows an **Install** button beside it. Nothing is installed into an interpreter Light Code did
not create.

**The Python tab shows your saved settings when it opens** — it used to say Python tools were off,
with nothing listed, until a message had been sent. Tools kept in a bucket appear once its folder
has synced.

**Reviewing a tool** shows its source syntax-highlighted. Approving loads each tool to make sure it
runs, a few seconds apiece, so the panel shows a spinner on the one being checked, "Checking 2 of 5"
and a progress bar.

**Labels.** Each saved tool carries \`__author__\`, \`__project__\`, \`__version__\` and \`__updated__\`
lines, part of the source you approve. A bucket folder marked "Publish new tools here" is where new
tools are saved, not \`.lightcode/tools\`.

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
    keywords: [
      'mcp', 'server', 'stdio', 'http', 'tools', 'npx', 'timeout', 'disable', 'clone', 'copy server', 'duplicate',
      '401', 'unauthorized', 'unauthorised', 'mcp header', 'bearer', 'transport', 'sse', 'streamable http', 'env:',
    ],
    body: `
**Settings → MCP.** The config shape is the standard \`mcpServers\` one, so a config copied from
another client can be pasted unchanged. Transport is inferred: \`command\` means stdio, \`url\`
means HTTP. For an HTTP server, **Transport** chooses the protocol: *Automatic* tries Streamable HTTP
and falls back to SSE; name one when you know it (another client's \`"type"\`), so only that one
is tried.

Servers connect **when the Light Code panel opens**, not at editor startup, and their health is
shown in the tab with a restart button. A mistyped command tells you so immediately rather than
the first time something happens to need it.

**Adding a server** starts from an empty form every time — a script browsed for, or an interpreter
detected, for the previous server is not carried over. **Clone** on a server opens the form filled
with that server's settings under a new name (\`name-copy\`); nothing is created until you save,
which is how to set up a second server that differs by an argument or a folder.

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
spawned. They are never written into the config file. \`${'$'}{env:NAME}\` reads an environment
variable, as Roo Code and Cline configs write it. Any other \`${'$'}{…}\` is refused rather than sent
literally. **A server defined in the project's \`.lightcode/config.json\` resolves neither** — it
connects when the panel opens, so a repository could otherwise send your tokens to a host of its
choosing. Define such a server in Settings → MCP instead.

**An HTTP server answering 401.** A header value is sent exactly as typed, so a token usually needs
its scheme: \`Authorization: Bearer <token>\`, not the bare token, and not "Bearer" twice. The
server's log in the MCP tab lists the header *names* sent and, after a 401, a checklist. If both
protocols failed under Automatic, the error shows both reasons — the first is usually the real one,
so set Transport to match. A server that signs in through a browser (OAuth) in another client needs
a token supplied as a header here; Light Code does not run that sign-in.

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

**Names live in Settings -> Project**: the index name prefix, an optional fixed index name, the
team codebase aliases (with "Attach alias to my existing index") and the team skills aliases. Once a
project name is set, derived index names start with it; "Move indexes to the project's names" copies
existing ones across without re-embedding. Settings -> Search keeps the store, the embedding model and
the Index button, and shows where the index is written.

**\`search_docs\` and \`search_team_skills\` stay in this project** by default — its skills and tools,
plus anything with no project label. They take \`project\` ("all", or another project's name) and
\`author\`, used when you ask to look wider, elsewhere, or at one person's work.

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
      'outlook busy', 'outlook is busy', 'outlook slow', 'old emails', 'old mail', 'archive',
      'search outlook', 'outlook not responding',
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

**When Outlook is busy or slow.** Outlook that is sending, receiving or syncing turns automation
away for a while; Light Code now waits that out inside each call (up to 30 seconds) instead of
failing at once. If a request still runs out of time, the helper that talks to Outlook is restarted
on the spot, so the requests after it do not fail too — that is what "Outlook might be busy" over
and over used to be. A request can also wait on a window in Outlook — its security prompt ("A
program is trying to access e-mail address information…") holds a request until somebody answers
it. If this machine is simply slow, raise the time in Settings → Tools.

**Finding old mail.** Give a **date range** — "between 1 and 31 March" — so Outlook filters it
itself; without one, a search starts from today and reads backwards. Say which folder: old mail is
often in an **Archive** folder or an **Online Archive** mailbox rather than the Inbox (ask it to
list the folders). Text to look for is filtered by Outlook too, and a search that looks at 2,000
messages without finding enough stops and says so rather than timing out. Mail older than what
Outlook keeps on this computer comes from the server, so it is slower; the indexed mail search
(below) is fastest for anything it has indexed.

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
    id: 'jira',
    title: 'Jira issues',
    keywords: [
      'jira', 'issue', 'ticket', 'bug', 'story', 'jql', 'backlog', 'transition', 'status',
      'log a bug', 'raise a ticket', 'move to done', 'comment on issue', 'component', 'attach to ticket',
      'assign ticket', 'custom field',
    ],
    body: `
**Settings → DevOps → Jira**: the site address, a personal access token, and optionally a default
project key, a CA file and the skip-verify escape hatch. Off until switched on; **user-scope only**
(config:jira). The token is kept in secure storage and never shown again. **Test connection** says who
the token belongs to.

Jira **Data Center / Server** only; Cloud is not supported.

**Four tools.** \`jira_search\` (plain words, or JQL passed through as written), \`jira_read_issue\`
(every field with a value — custom fields included — the description, comments, attachments, links,
sub-tasks and the status moves available right now; it can also look at attached images),
\`jira_project\` (a project's issue types, components and versions, and every field a new issue of a
type takes, with custom field ids and allowed values), and \`jira_write_issue\`, which creates an
issue or updates one by key. In one call it can set summary, description, priority, labels,
assignee (\`me\`, a username, a name or an email), components, fix and affects versions, due date,
parent, and **any other field by id** through \`fields\`; attach workspace files and drawn diagrams,
shown inline in the description with \`!name.png!\`; link other issues; comment; and move the status.

**Every write asks first.** An update shows the description diffed against the issue as it is now,
every other field from what to what, each file with its size, each link, the literal comment, and
where the status would move. A component or version the project does not have, a person who cannot
be identified, or a move that does not exist is named as refused before you approve. If an upload,
comment or move fails after the fields were saved, the result says exactly which part did not happen.
`,
  },
  {
    id: 'jenkins',
    title: 'Jenkins builds, logs and Jenkinsfiles',
    keywords: [
      'jenkins', 'ci', 'build', 'pipeline', 'jenkinsfile', 'job', 'console log', 'build log',
      'why did the build fail', 'failed build', 'start a build', 'trigger', 'rerun', 'replay',
      'stop build', 'abort', 'queue', 'agent offline', 'api token', 'sso',
    ],
    body: `
**Settings → DevOps → Jenkins**: the site address, an **API token**, your **Jenkins user id**, and
optionally a default job (\`folder/name\`), a CA file and the skip-verify escape hatch. Off until
switched on; **user-scope only** (config:jenkins). The token is kept in secure storage. **Test
connection** says who the token belongs to.

**Getting a token, single sign-on included.** Sign in to Jenkins in the browser as usual, open
\`<your Jenkins>/me/security\` (or click your name → Security), API Token → **Add new Token**,
and copy it at once — Jenkins shows it only once. Your user id is the last part of your profile
address, \`/user/<id>\`. Token plus user id is sent as HTTP Basic, which works behind SAML or
OpenID Connect sign-on. If your administrators have turned API tokens off and your SSO plugin accepts
an access token as a Bearer token, leave the user id empty and paste that token instead.

**Reading** — never asks beyond the ordinary gate:
- \`jenkins_find_jobs\` — jobs by name, through folders, with their last status.
- \`jenkins_job\` — health, the last ten builds, the last good and failed build, and the parameters
  the job takes with defaults and choices.
- \`jenkins_build\` — one build: result, who or what started it, parameters, commits, pipeline
  stages and their status, failed tests with their errors, artifacts. Start here for "why did it fail".
- \`jenkins_build_log\` — the console log without loading all of it: the end, only lines matching a
  pattern (with context), or the failed steps of one pipeline stage.
- \`jenkins_queue\` — what is waiting and why, and which agents are offline.
- \`jenkins_check_jenkinsfile\` — validates a local declarative Jenkinsfile with your Jenkins's own
  linter. Changes nothing.

**Acting** — always shown to you first, never available to a schedule:
- \`jenkins_start_build\` — starts a build, with parameters; the preview lists every value, defaults
  included, and names any parameter the job does not have.
- \`jenkins_stop_build\` — aborts a running build.
- \`jenkins_try_jenkinsfile\` — **does my local Jenkinsfile run?** Replays a recent build of a pipeline
  job with the local file as its script — the job's real agents, credentials and parameters, nothing
  committed — and waits (10 minutes by default) for the answer: success, or the failing stage and the
  end of its log. Needs a pipeline job that has run at least once and the Replay permission. Run
  \`jenkins_check_jenkinsfile\` first; it is instant and catches syntax and unknown steps.

There is no tool that changes a job's configuration.
`,
  },
  {
    id: 'autosys',
    title: 'AutoSys jobs, status, logs and dependencies',
    keywords: [
      'autosys', 'workload automation', 'wcc', 'jil', 'sendevent', 'autorep', 'force start',
      'force_startjob', 'on hold', 'on ice', 'kill job', 'change status', 'job definition',
      'job dependencies', 'condition', 'box', 'why has my job not started', 'job failed', 'job log',
      'apigee', 'gateway', 'token url', 'client id', 'client secret', 'oauth',
    ],
    body: `
**Settings → DevOps → AutoSys**: the web services address (for example
\`https://autosys.example.com:9443\`), your **username** and **password**, and optionally a default
job pattern such as \`PAY_*\`, a CA file and the skip-verify escape hatch. Off until switched on;
**user-scope only** (config:autosys). The password is kept in secure storage. **Test connection**
signs in without listing any jobs.

**Behind an API gateway (Apigee)?** Fill in **API gateway (Apigee)** in the same panel — typing a
token URL ticks "Sign in through the gateway" — and press the panel's one **Save**, which stores the
site address and the gateway together. Test connection runs against what is saved and says on the
page what it is still waiting for; a refused save is explained there too. Enter the **token URL** (where the token is issued — usually a
different address from the AutoSys API), the **client id** and **client secret** (kept in secure
storage), and a scope if the gateway asks for one. A token is fetched with those, kept in memory
only, renewed before it expires, and sent with every call to the site address — the username and
password are then not used. The **client certificate** comes from Settings → Network unless you
name one under *Client certificate* (certificate and key, or a PFX, plus a passphrase); the same
certificate is presented to the token URL and to the API. If the token request is refused with 401
and the secret is right, switch *How the client id and secret are sent* between the request body
and a Basic header — gateways differ. **Gateway token and AutoSys username and password together:** tick *Also send the AutoSys
username and password (HTTP Basic)* — it sends the username and password entered above as Basic,
alongside the gateway's token. One header holds one value, so the two must go in different headers:
usually the token in a gateway header (Advanced → *Header the token is sent in*, such as
x-apigee-token) and the Basic sign-in in Authorization, or the other way round with *Header for the
username and password*. The panel warns before saving if both would land in the same one. *Advanced* covers the grant type, where the token and its
expiry sit in the response, the header and prefix it is sent with, extra headers (an API key, say)
and extra token parameters (config:autosys).

Without a gateway, it talks to AutoSys's REST web services (AEWS) with HTTP Basic. Paths follow the documented layout
(\`/AEWS/job\`, \`/AEWS/job-run-info\`, \`/AEWS/event\`, \`/AEWS/jil\`); a server that answers
elsewhere can be pointed at with config:autosys (paths) — one template each for jobs, job,
runInfo, jobRunInfo, boxMembers, event, jil and log.

**Reading** — ordinary read tools, which you may set to always allow:
- \`autosys_find_jobs\` — jobs matching a name pattern, with type, box and machine.
- \`autosys_job\` — job definitions in JIL terms with each job's status, and a box's members. One
  job, a list, or a **pattern** for every matching job; for many jobs ask for just the attributes
  you need ("the command and start times of every PAY_* job").
- \`autosys_status\` — like autorep: status, last start and end, exit code, run number. One job, a
  pattern, or **several at once** ("PAY_LOAD and every GL_* job"), with a count by status first and
  failures at the top; \`only\` narrows to FAILURE, or to several statuses at once.
- Ask it to **follow a job until it finishes**: it checks the status, waits, and checks again.
- \`autosys_job_log\` — a job's stderr or stdout, the end of it or matching lines. If the server
  offers no log endpoint, it says which file on which machine the job writes to instead.
- \`autosys_dependencies\` — **why has it not started?** Upstream: each job its condition names
  (success, failure, done, notrunning, terminated, exit code) with its status and whether the
  condition is met, following unmet ones further up, and the box it runs in. Downstream: the jobs
  whose conditions name it, and a box's members.

**Changing** — asked **every time**, and cannot be set to always allow; never available to a
schedule:
- \`autosys_send_event\` — force-start, start, kill, hold, ice, no-exec, change status or priority,
  comment. The prompt shows the equivalent \`sendevent\` and what the event will do.
- \`autosys_apply_jil\` — insert, update or delete job definitions. The prompt shows the whole JIL
  and says plainly when it deletes.

Whether any of it succeeds is still decided by your AutoSys permissions.
`,
  },
  {
    id: 'bitbucket',
    title: 'Bitbucket pull requests',
    keywords: [
      'bitbucket', 'pull request', 'pr', 'review', 'diff', 'branch', 'repository', 'repo',
      'open a pull request', 'comment on pr', 'file on branch', 'stash',
    ],
    body: `
**Settings → DevOps → Bitbucket**: the site address, a personal access token, and optionally a
default project key and repository slug, used when a request names no repository. Off until switched
on; **user-scope only** (config:bitbucket).

Bitbucket **Data Center / Server** only; Cloud is not supported.

**Four tools.** \`bitbucket_pull_requests\` lists them, \`bitbucket_read_pull_request\` reads one with
reviewers, every comment (with its file and line) and the diff, \`bitbucket_read_file\` reads a file
at any branch, tag or commit, and \`bitbucket_write_pull_request\` opens a pull request or comments on
one. Every write asks first, showing the literal text.

**It cannot approve, merge or decline — deliberately.** Those are a reviewer's decisions about
somebody's work, made under your name; commenting is what the assistant contributes to a review.
`,
  },
  {
    id: 'project',
    title: 'Project name, and labelling skills and tools',
    keywords: [
      'project name', 'project', 'author', 'owner', 'label', 'metadata', 'version', 'which team',
      'index prefix', 'rename index', 'who wrote this skill', 'belongs to',
    ],
    body: `
**Settings → Project**: the name of this project (config:project). Saved for this project only,
on this machine — a repository cannot set it. Blank means the folder name.

The same tab holds everything else about how this machine appears to the team: the **author**
(config:identity), the **index name prefix**, an optional fixed codebase index name, the **team
codebase aliases** (with "Attach alias to my existing index"), and **Team skills** — its aliases,
sending your skills, and testing what colleagues can see. Each box saves on its own. Team names
work on OpenSearch only.

**Export and import.** "Share settings with your team" has a *Project name and search scope*
section: exported from the project you have open, and imported into the project open on the other
machine — never as a default for every project. The author is never exported. The index prefix and
team aliases travel in the search section.

**Searches stay in this project** — or whatever **Search scope** is set to on the Project tab:
*This project*, *Only mine* (what you wrote, in any project) or *Everything*, saved per project in
config:project (searchScope). \`search_docs\` and \`search_team_skills\` return this project's
skills and tools, plus anything with no project label (built-in and MCP tools, older skills). Ask
the assistant to "look in all projects" and it passes \`project: "all"\`; name another project and it
searches that one; name a person and it limits to their work with \`author\`. The result says how
many matches were left out, so a narrow search never looks like an empty one.

**What it labels.** Every skill and Python tool Light Code saves carries its author, project,
version and the time of the save: \`author:\`, \`project:\`, \`version:\`, \`updated:\` in a skill's
frontmatter, and \`__author__\`, \`__project__\`, \`__version__\`, \`__updated__\` in a tool. Author and
project are filled in once and never replaced; the version goes up by one on each save. The author
is config:identity (owner), or the login name. The Skills and Python tabs show them.

**Existing files.** "Label existing skills and tools" lists every file here missing a label. It
**never guesses author or project** — files are mixed, colleagues' and other teams', and a wrong
label is worse than none. Version (1) and the time the file last changed are filled on their own;
author and project only on rows you tick, with the values you choose. Evidence is offered where it
exists — the git author who added the file, or the team skills index holding the same text — and
"Fill ticked rows" sets several at once. Files in the bucket folder are left alone unless ticked.
An unlabelled file still works and is still found by project searches. An approved tool stays
approved on this machine; other machines ask once for the labelled version.

Saving a skill or tool labels it only if it is **new**; saving an existing unlabelled file adds the
version and time and leaves author and project blank, since whoever edits it next is not evidence of
who wrote it.

**Index names.** Once a name is set, derived index names start with it (names typed into
config:embedder or config:retrieval are left alone). "Move indexes to the project's names" copies
existing indexes to the new names inside the cluster — nothing is embedded again — and labels each
document with the project. The old indexes are left in place to remove when convenient. Indexing
the codebase also copies the old index across by itself if it finds one.
`,
  },
  {
    id: 'confluence',
    title: 'Confluence pages',
    keywords: [
      'confluence', 'wiki', 'page', 'pat', 'personal access token', 'space', 'publish', 'document',
      'documentation page', 'diagram on a page', 'image on a page', 'replace image',
    ],
    body: `
**Settings → DevOps → Confluence**: the site address (including any path before \`/display\`), a
personal access token, and optionally a default space key and a CA file. Off until switched on;
**user-scope only** (config:confluence), so a repository can never repoint it. The token is kept in
secure storage, never in the settings file, and never shown again — the field says whether one is
stored. **Test connection** reports who the token belongs to, or which step failed.

Confluence **Data Center / Server** with a personal access token. Confluence Cloud (email and API
token) is not supported.

**Three tools.** \`confluence_search\` (words or CQL), \`confluence_read_page\` (body, attachments,
and with \`images\` the pictures on the page — shown to the model when it can see images, SVG
diagrams read as their source), and \`confluence_write_page\`, which creates a page or updates one
given its id, with attached files and drawn diagrams.

**Every write asks first.** An update shows a diff against the page as it is now; a new page shows
its whole body; every attachment is listed, and one that **replaces** an existing attachment of the
same name is marked so. Pages are published as you.

**Replacing an image**: write to the page with its id and attach a file — or a diagram — with exactly
the same name as the existing attachment. The page text can be left out; only the attachment
changes.

**Diagrams** are drawn with the same shapes \`show_diagram\` uses and attached as SVG. A page shows
one with an \`ac:image\` element naming the attachment.
`,
  },
  {
    id: 'team-onboarding',
    title: 'Setting a team up with Light Code',
    keywords: [
      'onboard', 'onboarding', 'team', 'colleague', 'new joiner', 'share settings', 'export',
      'import', 'config json', 'setup guide', 'rollout',
    ],
    body: `
**Export once, import on each machine.** Settings → Providers → Share settings with your team →
**Export** writes a JSON file of the sections you tick — providers, MCP servers, search, skills,
Python, buckets, Confluence and more. The assistant can write the same file with
\`light_code_export_config\` for a guide or a page.

**Never in the file**: any secret (API keys, passwords, tokens), approvals, other per-project settings,
and identity (the author). Index names that identify one person are stripped from the search section,
because everyone must publish to their own collection.

**Import only changes what you choose.** The file's sections are listed with checkboxes; only the
ticked ones are written, and every other setting is left exactly as it was. A ticked section
*replaces* yours — importing MCP servers swaps your server list for theirs rather than merging two
lists that cannot be matched up. The DevOps section covers Confluence, Jira, Bitbucket and Jenkins;
tokens are never in the file and a Jenkins user id is left out.

**Project name and search scope** are a section of their own. They are exported from the project you
have open, and an import applies them **to the project open on the importing machine** — never as a
default for every project. The index prefix and team aliases travel in the search section.

**Each colleague then:**
1. Settings → Providers → Share settings with your team → **Import**, choose the file, pick the
   sections, confirm.
2. Enter their own credentials — the import names each one: provider API keys, the search
   connection's username and password, S3 secret access keys, the Confluence personal access token.
3. Settings → Providers: **Test connection** on each profile.
4. Settings → Project → Team skills: the team skills name must be exactly the same everywhere
   (config:embedder). **Test team search** shows whose skills this machine can see.
5. Settings → Python: switch Python tools on if the team shares tools through a bucket; new ones
   arrive on their own and wait above the chat input for approval.

**Everything is per machine.** Nothing syncs between two installs by itself, including two virtual
desktops of the same person; importing the file is how a second machine is set up.
`,
  },
  {
    id: 'sun',
    title: 'Sun Code: several codebases in one Windows window',
    keywords: [
      'sun', 'sun code', 'sun light code', 'several codebases', 'multiple codebases', 'multiple projects',
      'many projects', 'one window', 'parallel', 'background agents', 'desktop app', 'windows app',
      'sidebar', 'sleep', 'idle', 'switch project', 'credentials', 'saved credential',
      'share keys', 'share api keys', 'pycharm', 'intellij keys', 'shared drive', 'network drive',
      'big log', 'large log', 'big csv', 'large csv', 'huge file', 'find files', 'duplicate files',
      'several chats', 'two chats', 'parallel chats', 'parallel agents', 'chat tabs', 'new chat tab',
      'two agents same codebase', 'same codebase at once', 'same codebase', 'second chat',
      'environment variable', 'environment variables', 'startup script', 'setenv', 'add to path',
      'path variable', 'report viewer', 'open report', 'html report', 'markdown report',
      'copy folder', 'move folder', 'move files', 'copy files', 'zip', 'unzip', 'archive', 'compress',
      'export credentials', 'sun code',
    ],
    body: `
**Sun Code** (called Sun Light Code until 0.5.0) is a Windows app holding every codebase you work on,
each with its own Light Code agent. Install with \`npm i -g @chosengeneration/sun-code\` and run
\`sun-code\`. Its data moves across from the old name by itself on first start. The
package is prebuilt with no install scripts or dependencies, so nothing compiles or downloads.

**Each codebase is its own process**, so agents work in parallel and keep going while you look at
another chat. A dot on each codebase in the sidebar shows working, waiting for your approval, or
finished; a Windows notification says so when that codebase is not on screen, and the \`notify\` tool
appears there too, including from scheduled runs.

**Adding a codebase**: + or Ctrl+N, then a folder (any folder; recent ones from VS Code, IntelliJ,
PyCharm and earlier Light Code chats are offered). Its settings come from one of: **Link** an existing
config.json in place (the VS Code extension's, or the Node host's that the JetBrains plugin uses), so
edits in either app reach both; **Copy** one; or **New**. The folder's own .lightcode/config.json
always applies. Right-click a codebase → Settings source… changes it later.

**Credentials** (the key button in Sun's sidebar): keys and passwords saved once, by name, encrypted for
your Windows account, and picked in any codebase's settings with "Use a saved credential" — changing one
updates everything that uses it. Values are never shown again. Bring keys in from VS Code with the command
"Light Code: Share API keys with Sun Code", from IntelliJ / PyCharm with the button on the
Credentials page, or from another computer with Export / Import (a passphrase-encrypted file).

**Several chats per codebase**: the tabs above the chat. + (or Ctrl+T, or right-click → New chat) opens
another chat on the same codebase — its own agent, working at the same time, with the same settings and
keys. Double-click a tab to rename it; × or Ctrl+W closes it (its history is kept). Two safeguards make
this safe: an edit is refused when the file changed since that chat read it (another chat, you, or any
program edited it) — the agent re-reads and edits what is there now; and **Rollback undoes only the files
that chat changed**, never another chat's work.

**Environment** (Sun's Settings → Environment): given to every agent in every codebase. A **startup
script** (.cmd, .bat or .ps1) runs when Sun starts, and the variables it sets and folders it adds to PATH
reach every session — agents wait for it; Run now re-runs it after an edit. **Folders put in front of
PATH** (%NAME% expands). **Variables**, each a value or a saved credential (use a credential for anything
secret). Commands the agents run see all of it; Python tools and MCP servers see PATH only, unless their
own settings name a variable. Changes apply to agents started afterwards — the page offers to restart the
running ones.

**Reports**: "Open report" on a notification opens it in Sun's own viewer — Markdown (tables, code,
lists) or HTML (shown with its styles, but no scripts and nothing loaded from the internet).
Right-click a codebase → Reports… lists every report its chats wrote. An agent can attach a report file
it wrote, .md or .html, with \`notify\`'s \`report\`.

**Copy, move and zip** (Rust, every core): \`transfer_files\` copies or moves files and whole folders
(a move on one drive is an instant rename), and \`archive_files\` creates, extracts or lists a .zip.
Both **always ask**, showing every source, destination, file count, size and anything replaced, and are
never available to a schedule. An archive whose entries would land outside the destination is refused.

**What changed, at a glance**: a codebase managed by git shows **+new ~modified −deleted** on its sidebar
row (only the non-zero ones; hover for the branch). Refreshed every 30 seconds, when you open it, and when
an agent finishes. It never takes git's lock, so it cannot get in the way of your own git commands.

**Exporting credentials**: tick the ones to export (nothing is ticked to begin with; filter by label).

**Keyboard**: Ctrl+K switch, Ctrl+1–9 jump, Ctrl+Tab next, Ctrl+T new chat, Ctrl+W close chat, Ctrl+B
hide the sidebar (a strip of status dots stays), Ctrl+, Sun's settings.

**Appearance**: Sun's Settings choose light, dark or system and an accent colour; every chat follows
the theme. A codebase may keep its own accent — pick one in its Appearance tab — and its sidebar
icon follows; "Use Sun Code's accent" goes back. Role colours stay each chat's own. None of this
is written to the config file.

**Memory**: idle codebases sleep after 30 minutes by default (Sun's Settings), freeing their agent,
MCP servers and Python worker. Never while working or waiting for you. **Schedules still run**: Sun
keeps their timetable itself and wakes a codebase a minute before a job is due — asleep or never
started this session — then lets it sleep again a couple of minutes after. A job missed while the PC
slept runs when Sun next sees it. Only a codebase's first chat runs its schedules, so a job runs once
however many chats are open.
Clicking wakes it with the chat intact. Right-click → Keep awake exempts one.

**Reach beyond the codebase** (Sun's Settings, on by default): agents read any drive or shared folder
(\\\\server\\share) without a folder prompt, and may write anywhere — but every write outside the codebase
asks, shows the diff, and says Rollback cannot undo it. Keys, passwords, browser logins, Light Code's
own vault and Windows/program folders stay off-limits whatever the setting.

**Parallel file tools** (Rust, every CPU core), for big jobs: \`find_files\` (find by name, type, size or
date across drives and shares; summarise a folder; find duplicate files), \`read_many_files\` (up to 50
at once), \`big_file\` (inspect, read any window, tail, or search a huge log with context) and
\`query_table\` (filter, group and total a CSV or Excel sheet of millions of rows, a page at a time).
All read-only. Ask in plain words — "summarise the errors in this 2 GB log", "total sales by region in
this spreadsheet".

**Not in Sun**: reading a VS Code debug session, and editor file pickers — paths are typed. Sun's
Settings → Export source code saves the whole repository as a zip that builds offline.
`,
  },
  {
    id: 'schedules',
    title: 'Scheduled prompts and unattended runs',
    keywords: [
      'schedule', 'cron', 'timer', 'unattended', 'background', 'notify', 'report',
      // The words people use for it. Nobody types "unattended"; they type "every morning".
      'every morning', 'every day', 'daily', 'nightly', 'weekly', 'recurring', 'automatically',
      'repeat', 'regularly', 'run now', 'play button', 'did not run', 'nothing happened',
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

**Run it now** with the play button on the schedule. If a reply is still in progress — easy to hit
right after asking the assistant to create the schedule — the run waits for it and says so, rather
than being skipped. You are told when it starts and when it finishes, with a link to open the run.
**A run that hits an error is recorded as failed** with the reason, and you are notified: errors are
kept off the chat while a run works in the background, but never out of its record.

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
    id: 'feedback',
    title: 'Replying to a message, and reactions',
    keywords: [
      'reply', 'reply to a message', 'quote', 'react', 'reaction', 'thumbs up', 'thumbs down',
      'feedback', 'focus', 'wrong direction', 'thought process', 'thinking', 'steer',
    ],
    body: `
Under each finished reply from the assistant: **↩ Reply**, **👍** (right direction, keep this),
**👎** (wrong, do not pursue this) and **🎯** (focus on this). The same controls appear under a
**Thought process** once you expand it.

**Point at one part.** Select a sentence inside the message first, then press Reply or a reaction:
only the selection is quoted. With nothing selected the whole message is quoted, cut to a sensible
length.

**Reply** puts a "Replying to…" line above the composer (× removes it). Your next message goes with
the quote above it, so the assistant answers about *that* part rather than guessing which.

**Reactions never start a turn by themselves.** They wait: with your next message, or — if the
assistant is working — at its next step, which is the earliest anything you add can reach it. A
line above the composer says how many are waiting. Pressing the same reaction again takes it back
while it is still waiting; once delivered it is part of the conversation and stays.

**What the assistant actually receives is words**, written into your message: a quoted block for a
reply, and a short list for reactions ("👎 Wrong, do not pursue this: '…' (from your thought
process)"). The saved conversation shows exactly that text, so reopening it later reads the same.

**Reacting to a thought process steers the next step; it does not change the thinking already
done.** Most models do not see their earlier reasoning on the next turn at all, so the quote is how
it learns which line of thought you meant. 👎 on an approach while it is still working is the most
useful use of it: the next step reads it before deciding what to do.
`,
  },
  {
    id: 'source-export',
    title: 'Taking the Light Code source with you',
    keywords: [
      'export source', 'source code', 'export the source', 'build it myself', 'no github',
      'offline development', 'zip of the project', 'work on light code', 'continue development',
    ],
    body: `
The **export button beside Help** in the chat header (an arrow out of a box) saves the complete
Light Code source as a zip — every app, CLAUDE.md, the build scripts and the lockfile — for working on
Light Code where GitHub cannot be reached. It is the source of exactly the version you are running,
packed when that version was built, so it needs no network to export.

Extract it **to a short path** (C:\\src\\light-code, not deep inside Downloads): Windows will not
start a program whose full path passes 260 characters, and the build tools sit deep in
node_modules. Then open the folder in VS Code and follow **START_HERE.md**: Node 18 or newer, pnpm,
\`pnpm install --ignore-scripts\` (from the npm registry or your organisation's mirror), then
\`pnpm build\`, \`pnpm test\`, \`pnpm package\`. Start Claude Code in the folder; CLAUDE.md is the
project's context and is read automatically.

The export has no git history — START_HERE.md shows the three commands to begin a repository — and
leaves out the demo animations. The Node host has its own \`--export-code\` for the Node half.
`,
  },
  {
    id: 'waiting',
    title: 'Waiting for something to finish',
    keywords: [
      'wait', 'waiting', 'wait for', 'until it finishes', 'keep checking', 'poll', 'check again',
      'monitor', 'watch the job', 'when it is done', 'sleep', 'wait until', 'until the job finishes',
      'job finishes', 'tell me when',
    ],
    body: `
The assistant has a **wait** tool. Ask it to follow something — "watch PAY_EOD until it finishes",
"tell me when the build is green", "check again in ten minutes" — and it checks with the ordinary
tool, waits, and checks again, saying each time what it is waiting for.

- **Each wait is up to 15 minutes**; for longer it checks and waits again.
- **It stops waiting the moment you type a message or react**, so it never holds up your reply.
- **Every check is an ordinary tool call**, shown and approved like any other. The wait itself does
  nothing and never asks. To let it check without asking each time, allow that read tool always
  (Settings → Approvals, or "Always allow" on the prompt).
- Each check and each wait counts toward the step limit (config:maxIterations); a very long watch
  may stop and ask you to continue — sending any message carries on.

A scheduled run can wait too, which is how a nightly job can watch something finish and report.
`,
  },
  {
    id: 'diagnostics',
    title: 'Language servers: compile and type errors after every edit',
    keywords: [
      'language server', 'language servers', 'lsp', 'diagnostics', 'type errors', 'compile errors',
      'compiler errors', 'pyright', 'pylsp', 'gopls', 'rust-analyzer', 'clangd', 'jdtls',
      'typescript-language-server', 'get_diagnostics', 'red squiggles', 'errors after edit',
    ],
    body: `
After every edit, the result tells the assistant the **errors and warnings its change produced**, and
\`get_diagnostics\` checks any file — without running a build. So a broken import or a type error is
fixed in the same turn rather than found later.

**In VS Code** this is VS Code's own language support: whatever language extensions you have installed
already answer, nothing extra runs. To add a language, install its VS Code extension.

**In the Node host, PyCharm / IntelliJ and Sun Code** Light Code starts language servers itself —
the ones already installed on the machine, found on PATH, started the first time a file in that
language is checked. Nothing is downloaded. Supported: Python (pyright, basedpyright, pylsp,
jedi-language-server), TypeScript / JavaScript (typescript-language-server), Java (jdtls), C# (csharp-ls,
OmniSharp), Go (gopls), Rust (rust-analyzer), C / C++ (clangd), Kotlin, PHP, Ruby, Swift, Dart, Scala,
Lua, Bash, PowerShell, YAML, JSON, HTML, CSS, Terraform, Elixir, Haskell, Zig and SQL.

**Settings → Tools → Language servers** lists each language with its state — running, available, not
installed (with what to install), off or failed (with why) — and lets you turn one off or name the
command to use (e.g. a server outside PATH). Unticking "Check edits with language servers" turns it off.
In the config file: \`lsp.enabled\` and \`lsp.servers\` (a language set to false is off; otherwise
\`{ "command": ..., "args": [...] }\`). User settings only — a repository cannot choose a program to run.

A server's first check takes a few seconds while it indexes; later ones are under a second. The
typescript-language-server needs a TypeScript 5 install (in the project or globally) — TypeScript 7
ships no tsserver, and the panel shows that as the failure.
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

**Where several chats share a codebase** (Sun Code's chat tabs, or a host started with
\`--shared-workspace\`), Rollback restores only the files that chat changed, so another chat's work is
kept; files outside the codebase are not covered either way.

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
      'silent', 'crashed', 'stopped', 'ripgrep', 'rg', 'lightcode folder',
      'eperm', 'ebusy', 'could not save', 'permission denied saving', 'operation not permitted',
      // Settings saved in one window and missing in another: a window runs the version it started with.
      'another window', 'other window', 'second window', 'not reflecting', 'not showing',
    ],
    body: `
**"EPERM" (or EBUSY) naming config.json when saving.** On Windows a file cannot be replaced while
another program has it open — another VS Code window loading the same settings, antivirus checking
the write that just happened, or OneDrive syncing the folder. Saves retry for a few seconds, which
covers nearly all of it; if one still fails the message says so, the previous settings are intact,
and saving again works. If it keeps happening, exclude the settings folder from the sync tool or
the antivirus scan.

**A setting saved in one VS Code window does not show in another** — every window of the same VS Code
shares one settings file and one token store, but a window keeps running the Light Code version it
started with until it is reloaded. After an update, run **Developer: Reload Window** in each open
window. A window on an older version does not know settings added since (Jenkins arrived in 0.122.0);
from 0.122.1 on, saving in an older window keeps them rather than erasing them, but a window older
than that can still drop them — re-enter them once every window is reloaded. A different VS Code
*profile*, or a remote (SSH, WSL, container) window, has settings of its own.

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

**The Python tab says Python tools are off, or lists none, although they are on** — fixed: the tab
now applies your saved settings when it opens. If it still says so, check config:python (dynamicTools)
is \`on\` and a folder is open; tools kept in a bucket are listed once the bucket folder has synced.

**A Python tool will not run** — it is probably unapproved. One that arrived from a bucket or a
repository has no registry entry on this machine and stays inert until you read its source and say
yes. The list of those sits above the message box. If it names packages it "needs", they are
missing from the tools' Python environment: press **Install**, or ask the assistant to install them.

**Approving tools seems to take a while** — each one is loaded to make sure it runs. The panel shows
which one is being checked and how many are left.

**File search or listing mentions ripgrep** — it no longer depends on it. Light Code tries its own
ripgrep, then the one VS Code ships, and if a managed machine blocks both it searches and lists files
itself, honouring \`.gitignore\`. The assistant should not need to run \`rg\` as a command.

**New skills or tools appear in \`.lightcode\` although a bucket is chosen** — only a bucket folder
marked "Publish new … here", enabled, on a connection that is not read-only, becomes the save folder,
and an explicitly set folder in config:skills or config:python wins over it.

**Skills from other projects show up, or yours do not** — searches are limited to the project named
in Settings -> Project, plus anything unlabelled. Ask for "all projects" to look wider. A skill
labelled with the folder name still counts as this project's.

**Excel says there is no open session** — if Excel really is running, a privilege mismatch is the
usual cause: an editor started as administrator cannot reach an Excel that was not, or the reverse.

**A skill was added by hand and does not appear** — folders are watched, so it should be immediate.
Check the frontmatter parses and that the file is \`name.md\` or \`name/SKILL.md\`.

**Nothing at all is happening** — the output channel named "Light Code" has the turn log.
`,
  },
]
