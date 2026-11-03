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

**Settings** is the gear icon in the chat header. It has these tabs: Providers, Project, Approvals,
MCP, Search, Agents, Schedules, Python, Tools, DevOps, Outlook, Custom data, Skills, Usage, Network and
Appearance - plus Review and Variables on a shared server (\`light-code --server\`) only.

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
    title: 'Modes: Auto, Ask and Agent team',
    keywords: ['mode', 'switch', 'read only', 'shell first', 'auto mode', 'junior', 'team', 'code mode'],
    body: `
The mode picker sits **above the message box**, next to the profile picker. Mode is resolved once
per turn, so switching takes effect on your next message.

- **Ask** — read-only. It can inspect and answer but cannot edit or run anything. This *is* the
  read-only mode; there is no separate switch.
- **Auto** — the default: everything (read, edit, run commands, MCP tools), and it reads with \`cat\`, searches with
  \`grep\`, and makes mechanical changes in the shell, keeping \`apply_diff\` for edits worth
  reading as a diff. **It is the only mode where read-only commands run without asking.**
- **Agent team** — you lead and specialists are consulted. Needs at least one agent configured in
  the Agents tab. The **Strategy** button beside the mode picker draws how they are used: roles as
  steps, connectors between them, a back-and-forth that repeats until a condition holds or a maximum
  number of rounds, and a step marked read-only that cannot change anything. Strategies are saved and
  reusable; each chat uses one or none. With one in use the agent first proposes a plan that follows it,
  and Light Code counts each back-and-forth's rounds and stops one at its maximum.

**Each specialist works in its own process with its own context**, in any mode (the Rust helper's
\`fire-fs agent\`, for a role on an OpenAI, Anthropic or Gemini profile): it remembers earlier questions in
the chat, and near its context limit it writes its own key points and starts a fresh session with them. The
main agent sees only its answers. Its tool calls run through your approvals, labelled with who is asking. A
role on the Claude CLI keeps the CLI's own session; without the helper, each question is answered on its own.

**Code mode was removed**; Auto has the same tools. A saved \`code\` opens as Auto.

The stored value is config:modeId. If it names a mode that no longer exists, it falls back to
Auto. \`junior\` is an old name that now resolves to Agent team, and \`code\` to Auto.

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
formats: OpenAI-compatible, Anthropic Messages, and Gemini - plus **GitHub Copilot from VS Code**
(see the GitHub Copilot topic). Presets prefill a base URL and wire
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
    id: 'github-copilot',
    title: 'GitHub Copilot as the model',
    keywords: [
      'copilot', 'github copilot', 'github', 'use copilot', 'copilot model', 'reuse copilot', 'vs code models',
      'language model api', 'copilot in fire code', 'copilot subscription', 'premium requests',
    ],
    body: `
If GitHub Copilot is signed in to in VS Code, Light Code can use it as its model. **Settings → Providers
→ Add → Preset: GitHub Copilot (from VS Code)**, then pick a model from the list - the models your
Copilot plan offers (GPT, Claude, Gemini and others, as your organisation's Copilot policy allows).
There is no key, URL or certificate to enter.

**How it works:** through VS Code's own Language Model API. VS Code makes every request with Copilot's
sign-in; Light Code never sees a GitHub token. The **first request asks in VS Code** whether Light Code
may use Copilot - choose Allow. If it was refused, "Manage Language Model Access" in VS Code's Accounts
menu changes it. Requests count against your Copilot plan (including premium requests), and Copilot's
own limits apply: each model's input limit is read from VS Code, and context is compacted to it.

**In Fire Code, the Light Code host and the JetBrains plugin** (on the same machine): the same preset,
but those apps are not VS Code, so their requests are relayed through a **VS Code window that is open
with the Light Code extension** (0.161.0 or later). Close every VS Code window and Copilot profiles there
say so. The relay is a local pipe that only your Windows account can use: each window writes a random
token into your own profile folder, and every request must carry it. Not on a shared server
(\`--server\`).

**Needs** a VS Code recent enough for tool calling with language models (roughly 1.95 or later); on an
older VS Code the preset is not offered. Pictures are passed only where VS Code supports it.

**Not done, deliberately:** reading Copilot's token and calling GitHub directly. That is an unofficial
interface, against GitHub's terms for other clients, and the kind of thing a managed machine raises an
alert about.
`,
  },
  {
    id: 'skills',
    title: 'Skills: teaching it things it cannot work out',
    keywords: ['skill', 'teach', 'instructions', 'standing', 'always', 'master skill', 'markdown', 'edit skill', 'editor', 'edit standing instructions', 'standing instructions', 'edit a skill', 'placeholder', 'placeholders', 'skill defaults', 'default values', 'skill inputs', 'stop asking', 'keep skill private', 'which skills to send', 'keep to myself', 'delete everywhere', 'force delete', 'delete a skill for the team', 'only me', 'personal skill'],
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

**Editing a skill, a tool or the standing instructions.** *Open* (Skills tab, Python tab, Usage) opens
the file for editing: in VS Code in its own editor; in Fire Code, the browser and JetBrains in Light
Code's editor, a full-panel text box with Save (Ctrl+S), Close (Esc) and a Preview for Markdown. A save
is refused if the file changed on disk after you opened it - another chat, the agent or a sync wrote
it - rather than overwriting that; open it again to see the new version. Editing a Python tool changes
its code, so it waits for approval again before it runs. On a shared server only an admin can save.

**Folders**: config:skills.dir is the one written to, and config:skills.paths are read-only extras
searched after it. Earlier folders win a name collision and a shadowed skill is reported rather
than dropped.

**Reference files.** A skill can carry a template — a spreadsheet, a document — in its own folder,
and the assistant copies it into the workspace with \`use_skill_file\` rather than reading the
bytes into the conversation. Describe each file in one line in the skill body; a file nobody
described is one the assistant will never know to reach for.

**Delete everywhere.** Each skill in Settings -> Skills, and each tool in Settings -> Python, has
**Delete everywhere**: it first lists exactly what will go - every copy on this computer, the objects in
each S3 bucket folder, and its files in the team repository - and only the second press removes them. The
repository cannot delete a file over Bitbucket's REST API, so each file is replaced by a one-line
"deleted by you on <date>" marker; history keeps the old version, and every Light Code treats it as gone:
colleagues' unchanged copies in folders Light Code syncs are removed at their next sync, and a copy someone
changed, or keeps in their own project folder, is reported rather than removed. The repository goes first:
if it refuses (someone changed the file meanwhile), nothing else is removed - press Sync now and try again.
Writing a new skill or tool of the same name brings it back. It is a button only: the assistant cannot
delete for the team. On a shared server only an admin may.

**Only me, or the team.** A new skill or Python tool is **for the team** unless you say it is personal
("just for me", "keep it private") - the assistant does not ask. **Only me** keeps it in your personal folder on this computer
(%LOCALAPPDATA%\\light-code\\personal) - used in every project, in VS Code, Fire Code and the Node host
alike, and never uploaded to a bucket, committed to the team repository or sent to the team skills
pool. **The team** saves it where your team shares: committed to the team repository and/or uploaded
to the bucket folder marked "Publish" - the approval prompt names the destination before anything is
written. Updating one keeps it where it is. Personal skills show **only you** in the Skills tab and can
be removed there. Not offered on a shared server, where every user is the same account.

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

**Choosing which skills go to the team.** Settings -> Project -> Team skills -> *Choose which skills to
send*: untick a skill to keep it to yourself. The choice is remembered (config:teamSkills), the Send
button counts what goes, and a skill unticked after it was sent is taken back from the pool by the
next Send - only your own copy; colleagues' collections are never touched. Check status marks it
"kept to yourself".

**Defaults for a skill's inputs.** A skill that needs answers - an environment, a team, a user name -
can be answered in advance, so the assistant fills them in instead of stopping to ask. Settings ->
Skills -> a skill -> *Defaults for its inputs*: placeholders written \`{{name}}\` or \`<NAME>\` in the
skill are offered as boxes, and any other input can be added by name. They are yours, kept in your own
settings (config:skillDefaults), never in the skill, so a shared skill stays the same for everyone.
The assistant is told them up front and again when it reads the skill, says which it used, and still
asks for anything without a default; a different value you give in the chat wins.

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
      'new team tools', 'check for new tools', 'pull tools', 'tools not showing for approval', 'python tab slow',
      'install package', 'module not found', 'library', 'approve tool', 'credential in a tool',
      'password in a python tool', 'read credential', '__credentials__', '__always_ask__',
      'always ask', 'never always allow', 'banned calls', 'ban function', 'forbid function', 'blocked function',
      'approved again', 'approval in fire code',
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

**A colleague's new tool, now**: Settings → Python → **Check for new team tools** pulls the team's bucket tool
folders and the team repository straight away (instead of at the next sync, every 15 minutes by default) and
says what came down; anything new appears above the chat for approval. The Python tab shows the tools already
approved at once, marked "Starting Python…", and fills in the rest once Python is running - starting uv and
Python can take seconds on a managed machine.

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

**Saved credentials (Fire Code)**: a tool reads one of Fire Code's saved credentials with
\`light_code.credential("Corp LDAP")\` - a string, or \`{"username", "password"}\` for a login - but only one
it declares at module level: \`__credentials__ = ["Corp LDAP"]\`. That line is part of the code you
approve (the approval card and the diff both say "Reads saved credentials: ..."), so asking for
another credential means approving the tool again. Nothing goes into the environment, and any value
handed out is replaced by [REDACTED] in what the tool returns or prints before the model sees it.
Reviewing the code is still what stops a tool sending a credential somewhere it should not.
Outside Fire Code, use a secret variable (config:python.env) instead.

**A tool that must always ask before it runs**, for everyone who has it: put
\`__always_ask__ = True\` at module level (ask the assistant to, when it creates the tool). It is part of
the approved source, so it travels with the tool to colleagues; the approval prompt then never offers
"Always allow", and neither the command auto-approve switch nor an earlier "always allow" covers it.

**Banned calls** (config:python.bannedCalls, Settings → Python): functions or modules no tool may use,
one per line - \`os.system\`, \`subprocess\`, \`certainLib.certainFunction\`. Every tool is checked when
it loads and again before every call, through import aliases (\`import os as o\` then \`o.system\`) and
\`from x import y\`; a tool that uses one is refused, naming the line. It reads the code, so it stops
the obvious uses, not a tool determined to hide a call (\`getattr\` with a built-up string) - reviewing
the source is still the real check.

**Approved once per machine.** A tool's code approved in the VS Code extension, the Node host or Fire
Code is approved in the others too, for the same Windows user: the approved hashes live in one list,
\`%LOCALAPPDATA%\\light-code\\approvals\` (no tool can read or write it). A changed file still needs
approving again.

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
      'codebase', 'team', 'dispatcher', 'tool definitions', 'context window', 'prompt size', 'not listed', 'offload',
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

**With a search index, the built-in integrations move there too.** When the dispatcher is on and a
documentation index is configured (a vector store and an embedding model), the Excel, Outlook,
Confluence, Jira, Bitbucket, Jenkins, AutoSys, JupyterHub, S3, API, data and Python tools leave the
prompt: their full instructions live in the index, and the prompt keeps a short list naming every one
of them, telling the assistant to call \`search_docs\` before using one or planning a job in that area.
With everything switched on that is roughly 38,000 tokens of tool definitions down to about 11,000 on
every request. **Without an index nothing changes** - every tool stays listed in full, because finding
a tool by name alone is not reliable enough to hide it. The file, edit, command and Rust file tools are
always listed, because nearly every conversation uses them.

**Switching over is automatic.** The message after you configure an index already uses the lighter
prompt, and the tool documentation is indexed in the background within seconds - so that first message
finds tools by name, and later ones by meaning. Switching on another integration later (Jira, Excel, ...)
is picked up the same way. Nothing to press; the Search tab's Index button forces a full rebuild.

**If a switch here breaks nothing when it fails, that is deliberate.** With the backend down,
\`search_docs\` falls back to matching names, the search tools are simply not offered, and chat,
editing, commands and MCP never touch it.
`,
  },
  {
    id: 'office',
    title: 'Excel, Outlook and Teams on Windows',
    keywords: [
      'excel', 'outlook', 'spreadsheet', 'workbook', 'email', 'mail', 'macro', 'vba', 'com',
      'draft', 'attachment', 'compose',
      'write an email', 'send an email', 'write a mail', 'draft an email',
      'outlook busy', 'outlook is busy', 'outlook slow', 'old emails', 'old mail', 'archive',
      'search outlook', 'outlook not responding', 'recalculate', 'shift f9', 'f9', 'calculate',
      'manual calculation', 'stale values',
      'teams', 'microsoft teams', 'message a colleague', 'tell a team member', 'chat',
    ],
    body: `
**Settings → Tools** for the switches, **Settings → Outlook** for the mail index. Both off by
default, both **user-scope only** (config:office), and **Windows only** — they attach over COM to
an application on your desktop.

**Teams** (its own switch in the same panel, config:office.teams): \`teams_open_chat\` opens a Teams
chat with colleagues, named by email, with a message already typed in - say, a pull request and its
link. It uses Teams' own \`msteams:\` link, handled by the Teams desktop app under your account (no
Graph API; new Teams has no automation interface). Long messages do not fit in a link; a title and a
link do.

**Sending**: ask it to message, tell or inform someone and it sends - it asks to open the chat *and
press Enter*, and the approval says so in capitals. Ask for a draft instead and it only types the message. Enter is pressed only once a Teams window has been in front,
unchanged, for 2.5 seconds, and is still in front at that instant - a keypress goes to whatever window
has focus, and Enter in a terminal runs what is typed there. If Teams does not come to the front within
20 seconds, or you click elsewhere, nothing is pressed and it says the message was not sent. A keypress
cannot confirm delivery, so glance at the chat if it matters.

**Recalculating** (\`excel_calculate\`): a range on its own, a sheet (as Shift+F9), a workbook, or
every open workbook (F9; full for Ctrl+Alt+F9). It reports whether calculation is set to manual -
the usual reason values look stale - and what a small range shows afterwards, and can select the
range so you see it. It asks first, like other changes to a workbook.

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
running - subject, from, to, cc, sent time and attachment names above the body. **Drag the email
into the chat instead** and its attachments are read as well. \`outlook_read_email\` also reads a
message's attachments (PDF, Word, Excel, attached emails, text; pictures are shown).

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
      'create job', 'new job', 'clone job', 'copy job', 'modify job', 'job parameters', 'add parameter', 'job config', 'config.xml',
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

- \`jenkins_write_job\` — **create a job, copy one into a new job, or change a job**. "A job like
  platform/api but with a HOTFIX branch parameter" is a copy with new parameters. Parameters are set by
  name, type (string, text, boolean, choice), default, description and choices, or removed; anything
  else (script path, branch, schedule, agent label) is an exact edit of the job's config.xml. The
  approval shows the diff of the configuration Jenkins will be sent - against the job copied, or the job
  as Jenkins holds it now - and it **cannot be set to always allow**. It never deletes a job, never
  creates or copies over an existing one, and refuses to save if the job was edited on Jenkins after
  you were shown the change. Ticking **My access is read-only** removes it with the other acting tools.
  Needs the Job/Create or Job/Configure permission on your Jenkins.
`,
  },
  {
    id: 'autosys',
    title: 'AutoSys jobs, status, logs and dependencies',
    keywords: [
      'autosys', 'workload automation', 'wcc', 'jil', 'sendevent', 'autorep', 'force start',
      'force_startjob', 'on hold', 'on ice', 'kill job', 'change status', 'job definition',
      'job dependencies', 'condition', 'box', 'why has my job not started', 'job failed', 'job log',
      'apigee', 'gateway', 'token url', 'client id', 'client secret', 'oauth', 'consumer key', 'consumer secret',
      'machine', 'agent', 'running on', 'jobs on host', 'long running', 'global variable', 'calendar',
      'run calendar', 'what runs at', 'scheduled', 'start times', 'read only', 'read-only', 'readonly access',
      '403', 'forbidden', 'test connection details', 'service account',
      'rerun', 're-run', 'started manually', 'who started', 'manual run', 'run history', 'runs today',
      'last n hours', 'aews', '404', 'wrong address', 'addresses', 'urls', 'endpoints', 'wiki', 'share addresses',
    ],
    body: `
**Settings → DevOps → AutoSys**: the web services address, as far as the web services' own prefix (for
example \`https://autosys.example.com:9443/AEWS\`), your **username** and **password**, and optionally a default
job pattern such as \`PAY_*\`, a CA file and the skip-verify escape hatch. Off until switched on;
**user-scope only** (config:autosys). The password is kept in secure storage. **Test connection**
signs in without listing any jobs; with **Job to check in Test connection** filled in
(config:autosys (testJob)) it reads that one job's definition instead - the same request as
\`<site>/job/<name>\` in Postman, so the two answers can be compared. Under its result, **Details** shows every request it made and what
came back - the address, HTTP status, response headers and the start of the body, the gateway's token
request first - with passwords, tokens and secrets masked; open by default when the test failed, with a
**Copy details** button for whoever runs the service. Details begin with **Likely cause**, the first step that failed
read in plain words (a name that does not resolve, a certificate not trusted, a redirect to a login page, what a
401, 403 or 404 usually means there), and each step says the same - for Confluence, Jira, Bitbucket and Jenkins too.
**A pattern finds only some jobs?** Many servers answer a page at a time; when an answer says it has more (a total,
a "next" link), the status and find tools say how many came back of how many, and to add the server's page-size
parameter to the address in config:autosys (paths) - autosys_check_addresses shows what each address answers. Error messages name the HTTP status (401 not signed
in, 403 forbidden - signed in but that account is not allowed) so they can be compared with Postman.

**Read-only access?** Tick **My access is read-only** in the panel. The tools that change things
(\`autosys_send_event\`, \`autosys_apply_jil\`) are then left out entirely and the reading tools tell
the assistant the access is read-only, so it explains what someone with access would need to do instead
of trying. The same tick box is on Confluence, Jira, Bitbucket and Jenkins (config:autosys (readOnly)).

**Behind an API gateway (Apigee)?** Fill in **API gateway (Apigee)** in the same panel — typing a
token URL ticks "Sign in through the gateway" — and press the panel's one **Save**, which stores the
site address and the gateway together. Test connection runs against what is saved and says on the
page what it is still waiting for; a refused save is explained there too. Enter the **token URL** (where the token is issued — usually a
different address from the AutoSys API), the **consumer key** and **consumer secret** (Apigee's names
for the client id and secret; the secret is kept in secure storage), and a scope if the gateway asks
for one. The token is fetched with those **alone** — your AutoSys username and password are never sent
to the token URL — kept in memory only, renewed before it expires, and sent with every call to the site
address. The **client certificate** comes from Settings → Network unless you
name one under *Client certificate* (certificate and key, or a PFX, plus a passphrase); the same
certificate is presented to the token URL and to the API. If the token request is refused with 401
and the secret is right, switch *How the consumer key and secret are sent* between the request body
and a Basic header — gateways differ. **Gateway token and AutoSys username and password together** (an AutoSys that wants both, plus the
certificate, for job status, details and actions): tick *Also send the AutoSys username and password
with each job call (HTTP Basic)* — it sends the username and password entered above as Basic on every
AutoSys call, alongside the gateway's token, and never on the token request. **Or paste the whole header
value yourself** in *Header value* (for example \`Basic \` followed by the base64 of username:password -
in Python \`"Basic " + base64.b64encode(b"user:pass").decode()\`): it is sent exactly as stored, kept in
secure storage, and the username and password are then not needed. *Header name for the sign-in* takes
whatever your gateway expects (for example x-api-authorization-header-for-service-provider), and is
editable if it was mistyped. One header holds one value, so the two must go in different headers:
usually the token in a gateway header (Advanced → *Header the token is sent in*, such as
x-apigee-token) and the Basic sign-in in Authorization, or the token in Authorization (Bearer) and the
sign-in in a header of its own. The panel warns before saving if both would land in the same one. *Advanced* covers the grant type, where the token and its
expiry sit in the response, the header and prefix it is sent with, extra headers (an API key, say)
and extra token parameters (config:autosys).

Without a gateway, it talks to AutoSys's REST web services (AEWS) with HTTP Basic. **The site address is used
exactly as typed, so include the web services' own prefix** - usually \`https://autosys.example.com:9443/AEWS\`.
Light Code adds only the resource and its query to it (\`/job\`, \`/job-run-info?filter=...\`, \`/event\`,
\`/jil\`); a 404 from Test connection usually means the prefix is missing or doubled - its Details show the
exact address used. A server that answers
elsewhere can be pointed at with config:autosys (paths) — one template each for jobs, job,
runInfo, jobRunInfo, boxMembers, event, jil, log, machines, machine, globalVariables, calendar,
extendedCalendar, runHistory and eventHistory. A tool whose address this server does not answer says which of these to set.

**Your office's server answers at other addresses?** (Test connection 404, one job works but \`JOB*UK\`
does not.) Fill in **Job to check in Test connection** with a job that exists, and ask the assistant to
**"find the AutoSys addresses"**. \`autosys_check_addresses\` tries the saved addresses and the usual
layouts (\`/v1\`, \`/AEWS\`, \`/AEWS/v1\`, \`/api/v1\`, other query forms) with that job and says what each
answered, with the field names. **If your wiki documents the AutoSys REST service**, ask it to read that
page first (Confluence configured: it searches and reads it; otherwise drop the page into the chat) - it tries
what the page names, since a wiki page can be out of date and the server cannot. \`autosys_set_addresses\`
then saves the ones that answered: it asks **every time**, the prompt shows the addresses before and after
with each changed one tried live, and it is never available to a schedule or with read-only access.
Addresses must be paths on your site (\`/v1/job/{job}\`) - never another host - and the ones that send
(events, JIL) are never tried. Placeholders: {job}, {pattern}, {filter:name} (\`name==PAY_LOAD\` for one job, \`name=@PAY_*\` for a pattern - \`=@\` is how AutoSys matches a wildcard), {runNum},
{type}, {machine}, {calendar}. Even without any of this, a **pattern** works on a server with no pattern
status address: the jobs are listed and each one's status read in turn.

**Share all of AutoSys**: Settings → Export, tick only **AutoSys** - the site, addresses, gateway (token address, client
id, headers), test job and read-only setting, without your user name or any password or secret; importing it with only
**AutoSys** ticked replaces the importer's AutoSys settings and nothing else, keeping their own user name.

**Share only the addresses**: Settings → Export, tick only **AutoSys addresses**; colleagues import the
file with that section ticked. It carries config:autosys (paths) alone, so their own site, sign-in and
other DevOps settings are not touched. The assistant can write the same file (\`light_code_export_config\`
with the section \`autosysAddresses\`), for example next to an onboarding page.

**Reading** — ordinary read tools, which you may set to always allow:
- \`autosys_find_jobs\` — jobs matching a name pattern, with type, box, machine and owner, narrowed by
  what their definitions say: the **machine** they run on, **owner**, **box**, **type**, a **calendar**
  they use, or text in their **command** ("which jobs call load_gl.sh").
- \`autosys_job\` — job definitions in JIL terms with each job's status, and a box's members. One
  job, a list, or a **pattern** for every matching job; for many jobs ask for just the attributes
  you need ("the command and start times of every PAY_* job").
- \`autosys_status\` — like autorep: status, last start and end, exit code, run number. One job, a
  pattern, or **several at once** ("PAY_LOAD and every GL_* job"), with a count by status first and
  failures at the top; \`only\` narrows to FAILURE, or to several statuses at once. Also by
  **machine** ("what is running on host X"), by **time** ("what failed in the last 6 hours"), and
  **long runners** ("running longer than 2 hours", each with how long it has run).
- \`autosys_runs\` — **today's runs, or the last N hours**, for a list of jobs: each run's start, end,
  status and exit code, and **how it was started** - on its schedule, **by hand** (a STARTJOB or
  FORCE_STARTJOB event shortly before it, with **who** sent it and when), or an automatic retry.
  It needs the server's run history and event history; where those live elsewhere set
  config:autosys (paths) runHistory and eventHistory, and the tool names which one is missing. A run
  with no event record is reported as "not known", never guessed as scheduled.
- Ask it to **follow a job until it finishes**: it checks the status, waits, and checks again.
- \`autosys_job_log\` — a job's stderr or stdout, the end of it or matching lines. If the server
  offers no log endpoint, it says which file on which machine the job writes to instead.
- \`autosys_dependencies\` — **why has it not started?** Upstream: each job its condition names
  (success, failure, done, notrunning, terminated, exit code) with its status and whether the
  condition is met, following unmet ones further up, and the box it runs in. Downstream: the jobs
  whose conditions name it, and a box's members.
- \`autosys_machines\` — machines (agents) like autorep -M: definition and status, and for one machine
  the jobs **running on it now** and the jobs **defined on it**, each with its status.
- \`autosys_schedule\` — **what starts when**, from the definitions' start times, start minutes, days and
  run calendar: "what runs between 2 and 4 am", "what is scheduled on Saturday", "what starts on host X
  tonight", in start order, optionally with each job's current status. Jobs started only by a condition
  or their box are counted rather than listed.
- \`autosys_calendar\` — a calendar's dates (between two days, or whether one day is in it), or an
  extended calendar's rules: "will this job run on the 31st?".
- \`autosys_global_variables\` — global variables like autorep -G, for conditions such as
  \`v(RUN_DATE)\`.
- There is no run-history tool: the web services report each job's latest run; earlier runs are in
  AutoSys's own reports.

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
      'open a pull request', 'comment on pr', 'file on branch', 'stash', 'merge', 'merge pull request',
      'tag', 'release tag', 'create tag',
    ],
    body: `
**Settings → DevOps → Bitbucket**: the site address, a personal access token, and optionally a
default project key and repository slug, used when a request names no repository. Off until switched
on; **user-scope only** (config:bitbucket).

Bitbucket **Data Center / Server** only; Cloud is not supported.

**Five tools.** \`bitbucket_pull_requests\` lists them, \`bitbucket_read_pull_request\` reads one with
reviewers, every comment (with its file and line) and the diff, \`bitbucket_read_file\` reads a file
at any branch, tag or commit, \`bitbucket_write_pull_request\` opens a pull request or comments on
one, and \`bitbucket_merge_pull_request\` merges one and can then tag the merge (e.g. \`v1.4.0\` on
master). Every write asks first, showing the literal text.

**Merging only after a person has approved.** The merge is refused unless a reviewer has approved,
nobody has marked it "needs work", there are no conflicts, and Bitbucket's own merge checks pass; the
refusal says which. Checked again at the moment of merging. If the merge succeeds and the tag does not
(say the tag already exists), it says so - the merge is not undone. Neither runs in a schedule.

**It cannot approve or decline — deliberately.** Those are a reviewer's decisions about somebody's
work, made under your name; commenting is what the assistant contributes to a review. To tell the
reviewer about a new pull request, it can open a Teams chat for you to send (see the Office topic).

**Behind single sign-on (SAML).** Everything goes through Bitbucket's REST API, which accepts the
personal access token; files are read with its \`browse\` resource a page of lines at a time. Earlier
versions read files from the web \`/raw/\` address, which a SAML site sends to the login page
whatever the token - so pull requests worked and files did not. If a call still comes back as "a web
page instead of data", the site address is going through the login portal: use the server's own
address. Granting the token more permission does not help with this; it is not a permission problem.
`,
  },
  {
    id: 'team-repository',
    title: 'Team repository for skills and tools (Bitbucket)',
    keywords: [
      'team repository', 'team repo', 'skills repository', 'tools repository', 'commit skills', 'push skills',
      'push tools', 'share skills with team', 'sync skills', 'git for skills', 'branch for skills',
      'cannot commit to main', 'bitbucket skills', 'skills and tools', 'commit our skills', 'team skills branch',
    ],
    body: `
**Settings → DevOps → Team repository for skills and tools.** Offered once Bitbucket is set up: the
repository is reached with that site and its personal access token, through Bitbucket's REST API -
nothing is cloned and git is not needed. It is a separate repository from your working folder's
(config:teamRepo): project key, repository slug, a **branch** (if your team cannot commit to main,
name another - it is created from the default branch when missing), an optional folder holding
\`skills/\` and \`tools/\`, and how often to sync. User-scope only; it travels in export under DevOps.

**Two-way, every few minutes, and soon after you save.** The first sync commits every skill and tool
you already have; after that, each one you write or change is committed directly to the branch, and
your colleagues' are brought into a local copy that joins your skill and tool folders read-only.
Tools from the repository still need approving once on each machine before they run.

**Nothing is overwritten.** A file changed both here and in the repository since the last sync is
listed as not synced, on the panel and in Settings → Usage → Needs attention; a commit Bitbucket
refuses because someone committed first is the same. A skill or tool you **delete** stays in the
repository until somebody removes it there - the panel lists them.

**With S3 buckets too.** Everything skills and tools load from is committed - the folder new ones are
saved in, the project's .lightcode folders, **and the S3 bucket folders** - so a team that keeps its
skills and tools in a bucket gets all of them in the repository. Never the repository's own copy, so the
two syncs cannot bounce files between them. Two colleagues committing the same bucket file meet as
identical content, which is agreement, not a conflict; an edit someone makes in the bucket is committed
by the next sync. The same name in two folders here is one file when identical; when the copies differ,
the one Light Code uses is committed and the other is listed.

**Deleting one for the team.** Use **Delete everywhere** on the skill (Settings -> Skills) or tool (Settings -> Python): it lists every copy - this computer, S3 bucket folders, the repository - before removing them, and replaces the repository file with a "deleted" marker that every Light Code honours. See the skills topic for the details.

**Where new ones are saved.** While the repository is on, new skills and Python tools are saved in a
folder of its own outside the project (the panel shows the path), so they never land in the project's git.
A folder you chose in Settings -> Skills or Settings -> Python, or an S3 bucket folder marked "Publish",
still wins. Skills and tools already in the project's .lightcode folders keep loading and are committed
too. The agent can read every skill and tool folder, wherever it is, without asking.

**Starting with the repository alone** needs no S3 bucket: set up Bitbucket, fill in this panel and press
Sync now. Everyone's skills and tools come down; yours are committed as you create them.

**Python tools from the repository** need approving once on each machine, like any shared tool. Tool code
approved before (from a bucket, say) with exactly the same content is recognised and not asked again.

**"Newer in the repository"** (grey, not red): a colleague's change reached the repository before your
bucket sync brought it here. Your copy is unchanged, so nothing clashes; it clears once the bucket syncs.
**"Not synced - changed both here and in the repository"** (red) means both sides really changed. Compare
your copy with the team copy, keep one, and the next sync agrees. Line-ending differences (Windows CRLF
against LF) are not counted as changes.

**Do I still need the S3 bucket?** Either is enough to share: the bucket delivers files to everyone's
machine, and the repository does too while keeping history and diffs. With both on, the same file in both
is one file. A team can switch the bucket folders off and use the repository alone: **Use the repository
instead of the S3 bucket**, in the same panel. **Check** syncs the bucket and the repository, then makes sure
every skill and tool in the bucket folders is in the repository with the same content, listing anything that
is not. Only after a clean check can **Switch bucket folders off** be pressed, and it checks once more first.
It switches the skills and tools bucket folders off together and only unticks them - nothing is deleted in the bucket or on this computer, and ticking them again in
Settings -> S3 undoes it. Afterwards new skills and tools are saved in the project's folders and committed to
the repository, and what came from the bucket loads from the team copy (tools approved before stay approved
when their content is the same). Colleagues still using only the bucket stop receiving yours, so switch over
together.

Problems from syncing in the background (the repository, buckets, tools that did not load) show in
**Settings → Usage → Needs attention**.
`,
  },
  {
    id: 'branches',
    title: 'Several branches at once, side by side',
    keywords: [
      'branch', 'branches', 'worktree', 'git worktree', 'different branches', 'another branch', 'switch branch',
      'work on two branches', 'parallel branches', 'branch folder', 'new chat on a branch', 'open branch',
      'close branch', 'run and debug a branch', 'port offset', 'setup command', 'pnpm install in branch',
    ],
    body: `
Work on several branches of one repository at the same time, each in its own folder - git worktrees, part of
git since 2015. You clone once; opening a branch makes a folder for it beside the repository
(<repo>.worktrees\\\\<branch>, or under config:branches (folder)), sharing the repository's history. Nothing is
downloaded again, your codebase stays on its own branch, and a commit in any branch folder is in the one
repository straight away.

**VS Code**: Light Code: Open Branch in New Window (Command Palette, or the branch button in Source Control)
lists local branches, fetched remote branches and those already open, plus New branch… - which starts from
the repository's main branch (the remote's default, else main or master) unless you pick another. The branch opens in a new VS Code window - running, debugging and terminals there use that
branch's files and its own launch.json, with its own Light Code. Light Code: Branches lists every branch folder
with its state (clean, uncommitted changes, commits not pushed) to open it or close it.

**Fire Code**: New chat on a branch… (the + button, a tab's right-click menu, or the codebase's) lists every
branch to pick from, and has a New branch box at the top: type a name and it is made starting from the main
branch (main or master) unless you pick another. The branch opens as a chat tab working in its own folder. Each tab shows its chat name with the branch underneath (trimmed when long - a Jira key is kept
whole - full name on hover); renaming the chat never changes the branch. Close branch… (right-click a branch
chat's tab) removes its folder and the chat. To debug a branch, right-click its tab -> Open this branch in
VS Code: that window runs and debugs the branch, and the agent in Fire Code can read the paused session
(read_debug_session). Tests run from the chat itself - ask the agent; it runs them in the branch's folder. Fire Code's Commit and push acts on the codebase's own folder; in
a branch chat, commit through the agent or git in that folder.

**Setting a branch up** (once, when its folder is first opened): config:branches (copyFiles) - files git does
not track that it needs, such as .env, copied from the main checkout - and config:branches (setupCommand),
e.g. pnpm install or uv sync (VS Code runs it in a terminal you can watch). Each branch folder has its own
node_modules or .venv, because a shared one breaks as soon as branches differ. Per project; user-scope only
(a repository cannot set a command for you), and never exported.

**.vscode and the venv**: a committed .vscode folder is part of the branch already. An uncommitted one is not -
add ".vscode" to config:branches (copyFiles) and it is copied (adding only what the branch lacks). A virtualenv
is never copied - it records absolute paths, so a copy breaks; give each branch its own with the setup command
(uv sync, or python -m venv .venv and a pip install), or point VS Code's python.defaultInterpreterPath at the
main folder's .venv while branches share the same dependencies.

**Running two at once**: commands and debug sessions in a branch folder get LIGHT_CODE_BRANCH and
LIGHT_CODE_PORT_OFFSET (0 in the main checkout, 1, 2... in branch folders), so a dev server can add the
offset to its port. Nothing is written into your repository for this.

**Shared or separate**: codebase instructions, skills, settings and "always allow" approvals are shared by all
of a repository's branches; checkpoints and rollback, chat history and running processes are each folder's own.
The agent in a branch folder can only change files in that folder.

**A repository with no commits yet has no branches** - git makes a branch with the first commit - so there is
nothing to open or start from until you make one (Commit and push, or ask the agent to commit). Both products
say so instead of showing an empty list.

**Safe by git's own rules**: one branch can be open in only one folder at a time; closing a folder checks for
uncommitted changes and unpushed commits first and never deletes the branch; folders stay until you close them
(not temporary). If you delete one by hand, git forgets it (git worktree prune) and committed work is safe.
`,
  },
  {
    id: 'commit-message',
    title: 'Writing a commit message',
    keywords: [
      'commit message', 'write commit message', 'source control', 'git commit', 'commit', 'scm',
      'describe my changes', 'light code button',
    ],
    body: `
**VS Code**: the Light Code button (its brackets-and-diamond mark) on the **Source Control** title bar (or the command "Write commit
message with Light Code") has the active model describe your changes and puts the message in the
commit box. When anything is staged, it describes what is staged - that is what VS Code will commit;
otherwise every change. You read and edit it, and commit yourself: nothing is committed for you. A
message you had already typed is only replaced after you agree. It uses VS Code's built-in Git
extension, so that has to be enabled.

**Fire Code**: **Write with agent** in the Commit and push dialog does the same from the codebase's own
model, describing everything changed (that dialog commits everything).

The diff is sent to the model with known secrets redacted, cut at 24,000 characters.
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
    id: 'http-api',
    title: 'Calling REST APIs, and their proxy',
    keywords: [
      'http', 'rest', 'rest api', 'api', 'call an api', 'try the api', 'get request', 'post request', 'endpoint',
      'negotiate', 'kerberos', 'ntlm', 'windows authentication', 'apigee', '202', 'accepted', 'poll',
      'client certificate', 'ca certificate', 'curl', 'proxy', 'http proxy', 'https proxy', 'proxy password',
      'proxy username', 'no proxy',
    ],
    body: `
\`http_request\` calls a REST API with GET or POST - give it the API's documentation and it can try the API.

**Only hosts you named.** The host must appear in something *you* wrote in this chat - typed, or in a
document you attached or @-mentioned. A host it read in a tool result does not count, so a web page or
file cannot send it somewhere else. Named the domain but not the exact host? It asks you to confirm.
**Every request asks first**, showing the method, URL, headers and body.

**Credentials**: never paste a token into the chat. Save it as a secret and write \`\${secret:NAME}\` in a
header (e.g. \`Authorization: Bearer \${secret:orders-token}\`); the approval shows the name, not the value.
**Negotiate** (Kerberos/NTLM as your Windows login): ask for "negotiate" - it goes through Windows' own
HTTP stack, trusts the Windows certificate store, and takes a client certificate only as a .pfx.
**Apigee or another gateway**: name a provider profile ("use the Gateway profile's auth") and its token,
refreshing and certificates are used. **Certificates**: Settings → Network's global CA and machine
certificate always apply; a request may add a CA file, a client cert + key, or a .pfx.

**202 Accepted** is polled - the Location it names, or the same request - waiting Retry-After or a growing
interval, for up to two minutes by default (ask for longer). Headers work on every request.

**Proxy** (Settings → Network → Proxy for API calls): an HTTP proxy (for http:// APIs) and an HTTPS proxy
(for https:// APIs) - usually the same one - and hosts to reach directly. Write the login into the address,
\`http://user:password@proxy.corp:8080\`: the password is moved into secret storage and the box keeps only
the user name; leave the password out when saving again to keep it. Used by \`http_request\` only, on both
transports - with negotiate, when no proxy is set, Windows' own proxy settings apply. A proxy never applies
to localhost or 127.0.0.1. A refused address is reported on the panel.
`,
  },
  {
    id: 'python-library',
    title: 'Pricing and other Python libraries, in parallel',
    keywords: [
      'pricing library', 'pricing', 'quant', 'quants', 'dll', 'dlls', 'pyd', 'library', 'python library', 'gil',
      'parallel', 'process pool', 'many calls', 'batch', 'import my library', 'library folders',
    ],
    body: `
\`python_library\` uses a Python library installed or kept in a folder - the quants' pricing modules whose DLLs
sit beside them: **list** its functions, **describe** one (signature and documentation), and **call** one -
once, or thousands of times at once.

**Parallel without the GIL.** Calls run in a pool of Python *processes* (Fire Code's Rust helper), each its
own interpreter with its own GIL, each importing the library once and taking calls from a shared queue -
so 8 workers really run 8 prices at the same moment, whatever the library does with the GIL, without
changing it. Results come back in the order asked. A call that hangs past its timeout is stopped and its
worker restarted; one failing call does not fail the rest.

**Where the DLLs are**: tell it the folder ("the pricing library is in C:\\quant\\bin"), or save it once
in **Settings → Python → Library folders**. It is added to Python's path and to Windows' DLL search path.
If the library will not import and no folder was given, it asks you - it never searches drives. Which
Python: the tools' own, Settings → Python's interpreter, the first on PATH, or one you name.

**Results**: numbers and strings come back as themselves; a list of lists shows as a table (like the range
an Excel array formula fills); numpy arrays and pandas frames are converted. Every call asks first - the
library's code runs on this machine as you. Needs Fire Code's helper (Fire Code, or VS Code with Fire
Code installed).
`,
  },
  {
    id: 'dataframe',
    title: 'Data analysis: dataframes over CSV, Excel and the clipboard',
    keywords: [
      'dataframe', 'polars', 'pandas', 'analyse data', 'analyze data', 'data analysis', 'pivot', 'group by',
      'join', 'clipboard', 'copied cells', 'csv', 'excel data', 'aggregate', 'window function',
      'combine data', 'join data from different sources', 'json records', 'join sqlite',
    ],
    body: `
\`dataframe\` reads CSV/TSV/delimited text, Excel sheets and **the clipboard** (cells copied in Excel) with
Polars, in Rust on every core: **describe** shows each source's columns, types, empty counts and first rows;
**sql** queries them - joins across several files, GROUP BY, window functions, CASE - and can **pivot**
the result (index columns, a column whose values become columns, a value column and sum/count/avg/min/
max/first/last). Each source gets a name you query it by.

**Joining data from different places.** Besides files and the clipboard, a source can be a **SQLite**
table or read-only query (the same never-create, never-lock reader as \`query_sqlite\`), a **JSON** file of
records (a list, a wrapper like \`{"results": [...]}\`, or one object per line), or **records the assistant
already has** - results from Jira, an API call, a mail search - passed straight in as a list of objects.
So "join the open Jira issues with the owners spreadsheet and the trade counts in our SQLite database" is
one query. Every key becomes a column, records of different shapes line up, nested values stay as JSON.
When a tool's output was too large to show in full, its note gives a handle, and that saved output can be a
source **by handle**: the records go straight from where they were saved into the table, never retyped.

**The assistant writes the joins itself** - inner, left, several tables at once - in SQL. For a join built
in stages ("totals per owner, then add each owner's team"), it uses **steps**: named intermediate results,
each a query, usable by the later steps and the final query like any source table.

**Forgiving, without losing data.** Every value is read as text first, so nothing is dropped; a column
becomes numbers, true/false, dates or date-times only when *every* value converts. Empty markers (NA,
N/A, null, -, #N/A, ...) count as empty; thousands separators and "(1,234.50)" negatives are understood;
ragged rows, odd bytes, duplicate or blank headers and Excel error cells are tolerated. A column with stray
values stays text and the answer says which values, so a total is never quietly wrong. A pivot cell with no
data is empty, not 0. Needs Fire Code's helper (Fire Code, or VS Code with Fire Code installed).
`,
  },
  {
    id: 'team-admins',
    title: 'Team admins, owners and team reviews of shared skills and tools',
    keywords: [
      'admin', 'admins', 'team admin', 'owner', 'ownership', 'owns', 'approve a change', 'approval of changes',
      'team reviews', 'pending review', 'pending reviews', 'waiting for approval', 'who can change', 'modify a skill',
      'someone changed my skill', 'changed my tool', 'review a change', 'readonly', 'read-only', 'windows user id',
      'approve changes', 'who can approve', 'changes to my skill', 'changes to my tool',
    ],
    body: `
**Settings → Project → Team admins**, kept in the team's OpenSearch index (\`light-code-team-<project>\`, on the
active OpenSearch connection), so everybody on the project sees the same list. Ids are **Windows user ids** (the
signed-in account, lower case, any \`DOMAIN\\\` dropped) - never a name typed in settings.

**The first list saved wins**: whoever saves it first decides it (two at once: one wins, the other is shown the winner's
list). From then on only an admin can change it - for everyone else the field is read-only. Saving a list without your
own id means you cannot change it afterwards; the panel warns.

**Whoever creates a skill or tool owns it.** The owner is recorded in the team index the first time it is saved or
seen (from its author label), once - editing the author line later does not move it. While the team has admins, a
change by anybody else - through write_skill, create/update_python_tool, or Delete everywhere - is **not written**: it
goes to the owner (or any admin) for approval, and **nobody, the person who made it included, uses it until it is
approved**. An approved change is published where the team keeps it (bucket folder, team repository, or the project
folder) and reaches everyone at their next sync; a tool's code is still approved once on each computer, as always.
A change that adds pictures or files to a skill cannot be sent for review yet. With no admins, nothing needs approval.

**Settings → Team reviews** lists the changes waiting, how long each has waited, and the diff; **Approve and publish** or
**Reject** (with a reason). It is shown to admins, and to an owner with something to decide. Two people approving at
once: one wins, the other is told.

These are Light Code's checks, not access control: somebody with write access to the cluster, bucket or repository can
still change files by hand.
`,
  },
  {
    id: 'auditor',
    title: 'Auditor and Anti Hallucinator: recording, reviewing and steering the agent',
    keywords: [
      'auditor', 'audit', 'audit log', 'audit trail', 'record everything', 'recording', 'compliance',
      'dangerous', 'not allowed', 'alert me', 'anti hallucinator', 'anti hallucination', 'hallucinate',
      'hallucinating', 'hallucination', 'focused', 'stay focused', 'making things up', 'watch the agent',
      'second model', 'reviewer', 'read_audit_log', 'audit index', 'handoff', 'observer',
      'audit everything', 'everything the agent does', 'what the agent did', 'audit the agent',
      'something dangerous', 'does something dangerous', 'dangerous command', 'not allowed to', 'from hallucinating', 'is hallucinating', 'hallucinates', 'makes things up', 'keep the agent focused', 'audit log',
    ],
    body: `
**Settings → Project → Auditor** and **Anti Hallucinator**, saved for the open project (\`observers\` in
config, user-scope only - a repository cannot switch either on or off, or choose their model).

**The Auditor records everything the agent does** in this project: your requests, its reasoning (unless
"Record the agent's reasoning too" is off), every tool call, every approval with the literal action you were
shown, every result, and how each turn ended. The record is written by Light Code itself, so it is complete
even with no model chosen. It goes to a journal on this machine (one file per session and day, under Light
Code's storage folder, outside the repository; kept 90 days, \`observers.auditor.retentionDays\`), with
secrets removed, and - when an OpenSearch connection exists - also to **your own index**,
\`light-code-audit-<your name>\` (untick "Also record in my own OpenSearch index" to stop that).

**It tells you at once when the agent does something dangerous or not allowed**: runs a command marked risky,
changes a file outside the workspace, is refused a path on the deny list or outside the workspace, or calls a
tool the mode does not allow. That is a Windows notification in Fire Code and a warning in VS Code; a run of
them becomes one notice. With a model chosen, the Auditor also reviews each batch of steps and raises its own
alerts. Agents can read the record back with **read_audit_log** (summary first, then records with filters;
rows go straight into the dataframe tool for custom analysis).

**The Anti Hallucinator watches the agent's reasoning and results** and, when it states something the evidence
does not support, contradicts a result, drifts from what you asked or loops, sends it a short note at its next
step. The note is labelled as the reviewer's, shown in the chat as such, never counts as your words, and grants
no permission. It stays silent otherwise.

**Each runs as its own process with its own context** - the Rust helper's \`fire-fs watch\`, which calls the
model you chose (an OpenAI, Anthropic or Gemini profile; GitHub Copilot cannot be used here). Its auth and
certificates are the profile's, exactly as for the chat. Every reply carries the observer's running notes, so
when its context passes 70% Light Code starts a fresh process seeded with those notes - nothing has to be
written at the limit. A process that keeps failing is stopped after five starts in ten minutes; **Restart
processes** starts both afresh. The helper ships with Fire Code and the Windows VS Code extension; elsewhere the
Auditor still records but nothing reviews.
`,
  },
  {
    id: 'usage-dashboard',
    title: 'Usage dashboard: most used skills, contributors, unused and duplicate skills and tools',
    keywords: [
      'usage', 'dashboard', 'usage dashboard', 'team dashboard', 'most used skill', 'most used skills', 'used the most', 'used most',
      'who contributes', 'contributors', 'leaderboard', 'unused skills', 'unused tools', 'delete unused',
      'duplicate skill', 'duplicate tool', 'statistics', 'stats', 'metrics', 'analytics', 'usage statistics',
      'where are statistics stored', 'user details', 'whoami', 'by team', 'user info tool', 'get_user_info',
      'employee lookup', 'create whoami', 'leaderboard', 'company directory', 'active directory',
      'who wrote the most skills', 'most contributions', 'usage_stats', 'custom metrics', 'usage data',
      'tokens burned', 'token usage', 'tokens by person', 'tokens per user', 'token spend', 'who uses the most tokens',
    ],
    body: `
**Settings → Usage** shows which skills and tools are used, by whom, who writes them, and what needs
attention - for **Me** or the whole **Team**, over the last 24 hours, 7 days, 30 days, 90 days, a year,
or a **custom** date range. Every figure is compared with the previous period of the same length.

**Tokens burned**: every model request's tokens - input (cached included), output, and how much of the input the
provider served from its cache - by person (with each person's share of the team's tokens, a trend line and the
models they used) and by model. The counts are the providers' own; a request whose provider gave no count is
estimated, and the section says what share was. Counts and the model only, never the prompt or the reply. The
\`usage_stats\` tool's \`events\` with kind \`tokens\` gives one row per request for your own sums.

**Collection is automatic** wherever the team already shares a store: an **OpenSearch** connection
first, then **any other vector store** (Qdrant, Chroma - from Settings → Search, in a collection named
\`light-code-usage\`), then a **team S3 bucket** (one a skills or tools folder syncs or publishes to,
under \`usage/\`). Nothing is asked: the first time a session sees such a store, collection starts.
With none of those configured nothing is collected and the tab only explains why. In the tab's
"Collection and storage" panel you can instead choose a **shared folder** (a network share everybody can
write to), a particular bucket or store, or tick **Stop collecting on this machine**. Choosing a store
by hand writes a test entry first, so one that cannot be written is refused with the reason. The
settings travel in Settings → Export as **Usage dashboard** (config:usage, config:usage.store,
config:usage.enabled, config:usage.userInfoTool); a repository cannot set them.

**The first time, past conversations are imported** - the saved chats on this machine are read for the
tools they called and the skills they read, so the dashboard has history from day one. With Fire Code
installed its Rust helper does this (and reads a shared folder) in parallel; otherwise it is done in
Node. It runs once per install.

**People instead of login names.** On a Windows machine on a company domain, names come from the
**company directory** first - display name, email, department (shown as the team), title and office -
read as you (Windows' own sign-in, nothing to configure). In the background only **you** are looked up;
every author named on a skill or tool and every colleague in the numbers are looked up when the dashboard
is opened. The Rust helper reads the directory through Windows' own LDAP client - Fire Code's, or the one
the Windows VS Code package carries. **PowerShell is never used for it**: that way raised a security alert
on a managed machine. With no helper (a plain Node host without Fire Code, or not Windows) the directory
is simply not used. Only searches, only those fields, only while usage is collected; answers are kept for
30 days. Off a domain, or for someone the directory does not list, the
**second way** is used: if a tool that looks users up is available - an MCP or Python tool named like
\`whoami\`, \`user_info\` or \`employee_lookup\`, the one named in the panel, or failing those a
**skill** named like \`who-am-i\` or \`user-info\` that describes how - the assistant does it once
(approved as usual) and records the result with \`record_user_profile\`. The dashboard then shows names and
a **By team** table. It asks again after 30 days. Settings → Usage says whether the directory is reachable.

**Ask the assistant for any other metric.** The same data is a tool, \`usage_stats\`: \`summary\` (the
dashboard in words), \`events\` (every use as a row - time, person, name, team, skill or tool, author,
project, failed, duration - filtered by range, person, team, kind or name), \`inventory\` (installed
skills and tools with author, version and dates) and \`people\` (who each user is). For a metric the page
does not draw - "which skills does Rates use that FX never touches", "failed tool calls per project per
week" - the assistant takes the rows into \`dataframe\` and answers it in SQL. It reads exactly what the
dashboard reads, so the numbers agree.

**The leaderboard** ranks authors three ways: **Most written** (skills and tools they wrote), **Most
impact** (uses of their work × people it reached, in the range) and **Most active this period** (skills
and tools they added or updated in the range - a label at version 1 is new, a later one an update).
Authorship comes from the \`author\` label on a skill or the \`__author__\` line in a tool; unlabelled
ones count for nobody and are listed under Needs attention.

**Which tools count as a user-info tool.** The name is matched by its words between underscores, so the
\`py__\` (Python) or \`<server>__\` (MCP) prefix does not matter: \`py__whoami\`, \`py__get_user_info\`,
\`py__user_info\`, \`py__employee_lookup\`, \`hr__whoami\` are all found. The words are whoami, who_am_i,
current_user, user_info, user_details, user_profile, my_profile, employee (with _info, _details, _lookup,
_profile), get_user, lookup_user, find_user, people_lookup and identity. A name that does not split into
one of them - \`py__getuserinfo\`, \`py__staff_record\` - is not found; type it in Settings → Usage →
"Tool that looks up who a user is" (with or without \`py__\`), which also makes it the only one used.

**Having the assistant create one.** Ask in the chat, for example: "Create a Python tool called whoami
that looks up the current user in our directory and returns displayName, email, team, department, title
and location." You approve its source like any Python tool, and it runs only after that. Name it
\`whoami\` (or another of the words above) so nothing needs configuring, and return those six field
names - \`record_user_profile\` keeps only them. If the directory needs a login, declare it in the tool
with \`__credentials__ = ['directory']\` and read it with \`light_code.credential('directory')\` rather
than writing it into the file. If looking people up is not obvious, write a skill first ("how to find
a person in our directory": the endpoint or library, and which field is the team) - the assistant reads
it when building the tool, and colleagues' assistants can build the same one. A tools folder that
publishes to the team bucket shares it: each person approves it once, and every machine then records its
own user.

**In a shared folder the statistics are plain files**: one JSON Lines file per person, per day, per
install (\`<folder>\\<user>\\2026-10-10__<install>.jsonl\`, one event per line) and one small JSON file
per person in \`_profiles\`. No database and no locks: each file is written whole and swapped in, so
readers never see half of one. **Each month is rolled up**: three days after a month ends, each machine
merges its own day files for it into one month file (\`2026-09__<install>.jsonl\`), reads it back to
check every event is there, and only then deletes those day files - so a year is about a dozen files per
person and machine rather than a few hundred. Only a machine's own files are ever merged or deleted. In a
bucket the layout is the same under \`usage/\`; in OpenSearch, Qdrant or Chroma each file is one document
(its text the events, its vector a placeholder - nothing is searched by meaning there).

**What is collected**: the skill or tool name, who, when, the project, the author named on the skill or
tool, whether a tool call failed and how long it took. Never arguments, file contents or results. A
skill counts as used when it is read with \`read_file\` or its file is copied with \`use_skill_file\`.
Events are queued on this machine (\`usage\\queue\` in Light Code's storage, one file per day per
window) and sent about a minute after the last one, and when the tab opens. Several windows or chats at
once are safe: each writes only its own files, a day is sent again whenever any of its files grew, and
whoever sends a day checks afterwards that nothing changed meanwhile - so nothing is lost or counted
twice, with no locks to get stuck.

**On the dashboard**: totals with trends; activity over time; most used skills and tools with
sparklines, people, failures and average time; rising skills; top contributors (skills and tools
written, how often their work is used, how many people it reached); who uses Light Code; a weekday and
hour heat map; **your contribution**; **unused** skills and tools (unused by *anybody* in the range,
marked *stale* when not updated for a year); and new or updated ones.

**Needs attention** lists problems: the same name with different content in two folders (only the first
is used), identical content under two names, near-identical names, skills without a description,
skills and tools without an author, Python tools not loaded, tools that fail often, and skills
colleagues use that are not installed here. A copy of the same file in a bucket mirror is *not* a
problem - that is how sharing works. Things that broke behind the scenes come first: a team repository
or bucket sync that failed or skipped a file to avoid overwriting it, and Python tools that did not load
(a banned call, a missing package) - each with what to do.

**Acting on it**: Open any skill or tool, and **Delete** one that lives in this project's own folder (two
clicks; the second names it). A shared or bucket copy belongs to everybody and is only opened here -
delete those from Settings → Skills or Python.
`,
  },
  {
    id: 'rust-tools',
    title: 'The fast Rust tools, and where they are available',
    keywords: [
      'rust', 'rust tools', 'fast tools', 'fire code tools', 'fire-fs', 'helper', 'what tools', 'which tools',
      'available tools', 'big file', 'huge log', 'find files', 'grep', 'grep files', 'search contents', 'search shares', 'read many files', 'query table', 'sqlite',
      'dataframe', 'python library', 'copy files', 'move files', 'zip', 'vs code rust', 'tools in vs code',
      'bundled helper', 'without fire code',
    ],
    body: `
A Rust helper (\`fire-fs.exe\`) runs file and data work on every CPU core. Fire Code ships the full one;
the Windows VS Code package carries a slim one with every tool below except \`dataframe\`. Its tools:

- \`find_files\` - find files by name, type, size or date across drives and shares; summarise a folder; find
  duplicate files by content.
- \`grep_files\` - search file contents (text or a regular expression, with context lines) across several
  folders, drives or shares at once, filtered by name, extension and date; reads UTF-16 files, and lists every
  file or folder it could not read with Windows' own reason - useful when a share says access is denied.
  \`search_files\` (ripgrep) is still the one for searching inside the workspace.
- \`read_many_files\` - up to 50 files (or line windows) in one call.
- \`big_file\` - a file of any size, logs especially: inspect (lines, columns), read a window, tail, or search
  with a regular expression and context lines.
- \`query_table\` - filter, group and total one CSV or Excel sheet.
- \`dataframe\` - SQL over CSV, Excel and the clipboard: joins, grouping, window functions, pivot; forgiving
  with messy data (see the dataframe topic).
- \`query_sqlite\` - read a SQLite database without creating it or locking it.
- \`python_library\` - call a Python library's functions many times in parallel processes (pricing DLLs).
- \`transfer_files\` / \`archive_files\` - copy or move, and zip/unzip, showing the plan before anything changes.

**Where they are available**
- **Fire Code**: always.
- **VS Code on Windows**: always - every tool but \`dataframe\`, from the helper bundled with the
  extension. With Fire Code installed on the same machine, its full helper is used instead and
  \`dataframe\` is there too. Nothing to configure; reload the VS Code window after installing or
  updating Fire Code.
- **\`light-code\` run on its own (Node host)**: when Fire Code is installed on the same machine.
- **Not**: on a shared server (\`--server\`), on a platform other than Windows, or in the Node host
  without Fire Code. There the built-in tools (read_file, search_files, list_files) do the work.

To see whether they are on right now, look at the tool list in Settings → Tools, or ask "which tools do
you have?" - the assistant answers from the tools it was actually given.


**For a monitor**: find_files, grep_files, big_file (search), query_table, query_sqlite and dataframe take \`"records": true\` and answer as a JSON list of records, so a Fire Code monitor can use them as its source directly - Rust collects, Rust judges, no Python in between. See the Monitoring topic.`,
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

**Pages look like the chat.** The assistant writes a page as Markdown - the same Markdown a reply
uses - and it is converted to Confluence's own format: real headings, tables with a shaded header row,
code in Confluence's code macro with highlighting, quotes, lists and links. Raw storage format is still
there for what Markdown cannot say (info and note panels, expand blocks, images on the page). The
approval shows the converted page, so what you approve is what is published.

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
Python, buckets, DevOps (Confluence, Jira, Bitbucket, Jenkins), AutoSys on its own, and more. The assistant can write the same file with
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
    id: 'jupyterhub',
    title: 'JupyterHub',
    keywords: [
      'jupyterhub', 'jupyter hub', 'jupyter', 'hub', 'notebook server', 'kernel', 'hub token', 'api token',
      'hub_run', 'hub_inspect', 'hub_sync', 'run on the hub', 'hub libraries', 'library only on the hub',
      'remote folder', 'remote code', 'not saved to the hub', 'changed on the hub', 'conflict', 'merge',
      'git on the hub', 'commit on the hub', 'push from the hub', 'hub git', 'outside the folder',
      'hub_browse', 'browse the hub', 'other codebase hub', 'files on the hub',
      'hubignore', '.hubignore', 'ignore files', 'do not sync', 'not synced', 'exclude from sync', 'skip folder',
      'node_modules', 'dist folder', 'angular', 'build output', 'sync ignore',
    ],
    body: `
**Add codebase → On JupyterHub** (Fire Code): the hub's address, your hub user name, the folders on
your hub server (one per line, from your home folder; / for all of it), and an API token - create one
on the hub's Token page (\`<hub>/hub/token\`). The token is saved encrypted in Credentials as
"JupyterHub <user>@<host>" and only ever sent to that hub, in a header. Optional: a named server and
a kernel (e.g. python3). Right-click the codebase → JupyterHub settings… changes them later.
Your hub server must be running; if it is not, the agent says so - start it from the hub's home page.

**\`.hubignore\`** lists files and folders that are never synced, either way - \`.gitignore\` syntax
(\`dist/\`, \`*.log\`, \`/build/\`, \`!keep.me\`), in any synced folder, applying beneath it. Dot-files and
dot-folders, \`node_modules\`, \`.git\`, virtualenvs and Python caches are skipped already; \`!.editorconfig\`
brings one back. The \`.hubignore\` file itself is synced, so the hub and other machines follow it too.
A file synced before a rule listed it just stops being synced - nothing is deleted on either side. For
an Angular project: \`dist/\`, \`.angular/\`, \`out-tsc/\`, \`coverage/\`, \`*.log\`. The agent writes one
when it sets up such a project, before installing or building, and says what it put in it.

**How it works**: Fire Code keeps a copy of the folders on this computer, so reading and searching
are as fast as for any local codebase (and the Rust search tools apply). Changes on the hub are
fetched when the agent starts and every 5 minutes; \`hub_sync\` "pull" fetches now. Every edit the
agent makes - approved with a diff, as always - is **saved straight back to the hub**, and the edit's
result says so. Nothing is ever overwritten that somebody changed: an edit to a file that changed on
the hub meanwhile is NOT saved (it is kept here; compare with \`hub_sync\` "hub_version" and choose
how to merge, or take theirs with "use_hub_version"), and fetching never replaces a local edit.
A file deleted on the hub is removed here only if unchanged here. Notebook checkpoints, \`__pycache__\`,
\`.git\` and hidden files are not copied; files over 20 MB are listed but not copied.

**Code runs on the hub**, where its libraries are: \`hub_run\` runs Python in a kernel kept for the
session (variables persist), a script from the copy (saved to the hub first, run from its own folder,
with arguments), or a shell command on the hub server. Every run asks first and shows the code - for
a script, the script itself; "Always allow" works for an identical command. Files a run writes on the
hub are fetched afterwards. Stop or a time limit interrupts the kernel; a kernel that ignores the
interrupt is replaced, and the result says earlier variables are gone. \`hub_inspect\` looks up a
library that exists only on the hub - signature, docs, members and (with source) its code - or lists
the hub's installed packages; it asks first because importing runs the module's code.
The local language server cannot see hub-only libraries, so "import could not be resolved" is not
reported for these codebases. Commands run with execute_command run on this computer, not the hub.

**Git runs on the hub too**: the repository, its remote and its credentials are there, not in the
copy. Fire Code's sidebar counts and its Commit and push / Pull buttons work for a hub codebase while
its chat is running - local edits are saved to the hub first, then git commits and pushes there
(fast-forward-only pulls, fetched here afterwards); "Write with agent" describes the hub's diff. The
agent runs any other git command with \`hub_run\` shell, approved like any command.
**Outside the added folders**: \`hub_browse\` lists folders, finds files by name and reads text files
anywhere your hub user can see - read only, nothing copied or changed. It is offered in the hub
codebase for its own hub, and in **every other Fire Code codebase** for each hub codebase, named by
its @name - so a local codebase can look at the hub's files without its own token. Only the added
folders are copied here and searched with the fast tools; editing stays in the hub codebase.

**Not done for you**: a file deleted here is not deleted on the hub (\`hub_sync\` "status" lists it);
edits made outside the agent (in VS Code, say) are saved with \`hub_sync\` "push".
`,
  },
  {
    id: 'monitoring',
    title: 'Monitoring dashboard (Fire Code)',
    keywords: [
      'monitoring', 'monitor', 'monitors', 'dashboard', 'alert', 'alerts', 'alerting', 'tile', 'tiles', 'data grid',
      'highlight', 'highlighted', 'traffic light', 'red amber green', 'watch', 'check every', 'notification level',
      'alarm', 'snooze', 'acknowledge', 'team alerts', 'personal alerts', 'monitor_create', 'quiet hours',
      'run window', 'specific time', 'once a day', 'history of alert', 'recurring alert', 'retention', 'cleanup',
      'opensearch history', 'explain alert', 'tool_calls', 'edit schedule', 'change schedule', 'delete monitor',
      'delete check', 'remove monitor', 'personal monitor', 'personal check', 'monitor schedule', 'schedule of a monitor',
      'monitor check', 'monitoring check', 'snooze until', 'snooze row', 'review all', 'approve several monitors',
      'run history', 'past failures', 'polars', 'team monitors', 'approve monitors', 'approve the team monitors',
      'offline', 'runs elsewhere', 'claim', 'who runs the check', 'not shared', 'team checks', 'my checks', 'checks offline',
      'past failure', 'specific date', 'grid as it was', 'delete a check', 'delete one check', 'rust tools',
      'find_files', 'grep_files', 'records', 'only alerted rows', 'all rows', 'lazy load', 'many rows',
      'older than', 'delete old history', 'delete history older than', 'clean up history',
      'not on time', 'not triggered', 'late check', 'check is late', 'waiting', 'scheduler', 'scheduler stopped',
      'start the scheduler', 'stop the scheduler', 'is the scheduler running', 'refresh monitors', 'new checks',
      'deleted checks', 'who wrote the monitor', 'author of the monitor', 'last updated by', 'who changed the monitor',
      'monitor changes', 'changes to the monitor', 'audit of changes', 'updated_by', 'takeover', 'due since',
      'who changed this monitor', 'commits', 'bitbucket history', 'git history', 'personal check created as team',
      'copy from the grid', 'copy cell', 'copy the grid', 'copy rows',
      'filter the grid', 'column filter', 'filter by value', 'column chooser', 'hide columns', 'greater than', 'between',
    ],
    body: `
**Fire Code only.** Settings → Monitoring switches it on; a Monitoring button then appears at the top of the
sidebar (Ctrl+M), showing the worst colour and how many monitors are alerting. Chats that were idle restart
so their agents get the monitoring tools.

**The dashboard** fills the window: one glowing tile per monitor, under **Team alerts** and **Personal**, with
a search box and a chip per colour - **red** failure, **amber** warning, **purple** no fresh data (the check
failed or is late), **blue** information, **green** all clear, **grey** paused, not run yet, or waiting for
your review. Hover a tile for what it watches and when it last checked; right-click it to check now, pause,
snooze or change how it notifies. **Click it for its grid**, in a window of its own: rows and cells coloured
by its alert rules, a filter on every column (text, or \`>10\`, \`<5\`, \`=x\`), sort by a header, the alerts
as chips above. **Double-click a row** for every field and, when the monitor names one, a breakdown fetched
for that row. **Acknowledge** an alert and it stops counting until it gets worse.

**A monitor is a skill** with a \`monitor\` block - what to read, how often (\`every\`, \`activeHours\`,
\`days\`), the columns and the alert rules - so it travels like any skill: a **personal** one stays in your
personal skills; a **team** one goes where the team shares skills (the codebase, a bucket, the team
repository), and each person's Fire Code runs it with their own credentials. Ask an agent: "monitor the
PAY_* jobs every 15 minutes, red when one fails". It reuses a tool that returns the data or writes a Python
tool, and creates the monitor with \`monitor_create\`; you approve the file, which approves it here. A
colleague's monitor shows grey **Review** until you approve exactly what it runs.

**Tools written for monitoring** return a list of records - one per job, host or feed, the same fields in each,
numbers as numbers, times as ISO timestamps, a field naming the row - return an empty list when there is
nothing to report, and fail loudly when the data cannot be read (the tile then turns purple rather than
falsely green). The agent tries a tool with \`monitor_create\` \`tryOnly\` first: it shows the columns, rows and
alerts Fire Code would see, saving nothing. A tool that answers in sentences is read one line per row, and the
result says how to change it.

**Checks need no model.** Fire Code (Rust) runs them on schedule and judges the rows itself. SQLite and
CSV/Excel/JSON files are read by Fire Code; a Python, MCP or read tool runs in a background agent with the
settings of the codebase chosen under Settings → Monitoring. A monitor may never run a tool that changes
things.

**Notifications at your level**, per colour (Settings → Monitoring): Off, Count (only on the button and
title bar), Silent, Sound, Stays (on screen until dismissed) or Alarm (loops until dismissed); a reminder
while it stays red or amber, a quiet word when it clears, and quiet hours when only failures get through.
Each monitor can override it (right-click → How this one notifies), and its own \`notify\` sets the least
severe level that notifies. Notifications have Open, Acknowledge and Snooze buttons.

**When checks run**: \`every\` ("15m") for an interval - once in each window of the clock (every 10 minutes is
10:00, 10:10, 10:20 ..., windows counted from UTC so a team across time zones agrees), whoever joined when, kept to \`activeHours\` ("07:00-19:00", or "09:00-" for not
before nine, "-17:00" for until five); \`at\` for exact times of day ("07:30" - once a day - or ["07:30", "12:00",
"18:00"]); \`days\` for the days of the week, for both. A time missed while Fire Code was closed is not made up the
next day.

**Change when it runs**: in its grid window, **Schedule** (or right-click a tile → Edit schedule…): every N minutes
or hours, only between two times (either may be empty), at set times of day, on chosen days. Saving writes only those
fields into the skill file and keeps an approved monitor approved. An agent can change it too ("run the batch check
every 10 minutes on weekdays"); you approve the change as a diff.

**Delete a monitor for good**: right-click its tile → Delete this monitor… (or ⋯ → Delete in its window). Its skill
file, its results and history here, and your own checks in the team history go; Pause stops it for a while instead.
A copy synced from the team's bucket or repository is changed or deleted **where the team keeps it** - uploaded
to the bucket or committed to the repository (a deletion goes from the repository, the bucket and this computer,
like Delete everywhere in Settings → Skills) - so the next sync does not put the old one back. Colleagues get the
change at their next sync and approve it once. This uses the bucket and repository of the codebase chosen under
Settings → Monitoring ("Run tools with the settings of").

**Snooze**: right-click a tile → Snooze 1 hour / until tomorrow / **Snooze until…** (a date and time, up to 30 days),
or the Snooze button in its window. **One row**: right-click the row in the grid (or **Snooze row** in its details)
→ 1 hour, 4 hours, until tomorrow 09:00, or until a date and time - its alerts stop counting until then, unless one
gets worse, which counts again at once.

**Reviewing a colleague's monitors**: a blue banner on the dashboard says how many wait for your review; **Review
all…** lists each with its definition and a tick box - approve the ones you ticked (Select all ticks every one).

**Run history**: the wide button across the bottom of each tile shows the last checks as bars, oldest on the left.
Press it for the monitor's History - every check kept, earlier days too (24 hours to 90 days, or **On** a chosen
date); press one bar to open on that check. Choosing a check shows, under the bars: its time, result, who ran it,
rows read, how long it took, and **its whole grid as it was** - every row, coloured as it was - straight away;
**Open in grid view** for filters and sorting, read-only, with **Back to now**. Whole grids are kept from Fire Code
0.64.0 on, once per distinct grid, for as long as its history; a **team** check's grid is also shared in the team
index (from 0.65.0), so **every member sees every row** of the newest check and of past ones, whoever ran it. A grid
over 5,000 rows or about 2 MB is not shared - members then see its alerted rows, and an older check says why.

**Big grids** are drawn as you scroll: the first 200 rows at once, more as the bottom comes near - filters, search,
sorting and counts cover every row. **Delete this check**
removes one check: here, and your own record of it in the team history.

**A team check is collected once, not once per person**: each scheduled run is claimed in the team index first, so
one member's Fire Code runs it and everyone sees that result ("checked by …"); **Run now** claims a two-minute slot, so
people pressing it together get one check. The full history is stored once, in the team index; each computer keeps
only the newest 200 checks of a team monitor, for its tile.

**Only a computer that can run it claims it.** Before claiming, Fire Code checks the monitor can run here: a SQLite
or file source's path is reachable, a tool exists, is approved here and is allowed for monitors (checked without
running it, re-checked every 10 minutes). A computer that cannot leaves it to colleagues, and its tile says **Runs
elsewhere** with the reason on hover. A check that **failed** here (a credential, a network route) makes this computer
step back for three windows (at least 30 minutes) while a colleague's runs succeed - unless nobody has checked it for
a window, when it tries again rather than leave it unrun.

**When a check has not run on time**, its tile says so: **waiting…** with the reason on hover (making sure it can run
here first, its turn behind 4 checks already running, a colleague's Fire Code has this window, the monitoring
executor still starting), or **due N min ago** when it is past its time; its grid window says **Due since** the time
it should have started (never "Next … ago"). The executor is started as soon as a monitor
uses a tool, not when the check falls due, and a tool's timeout counts from when the executor is up. A file or
database path on a share is checked in the background, so a share that does not answer never holds the dashboard up.
**If the colleague who won a window never reports** (their Fire Code closed or failed mid-check), one other member
takes the window over once its timeout and three more minutes have passed - by a second claim, so still only one.

**Is the scheduler working?** A line at the top of the dashboard says **Scheduler running** and when it last looked
(every 3 seconds), with **Stop**; stopped, it says so, with **Start**; not heard from for 90 seconds it says **not
responding**, with **Start again**, which lets go of anything stuck and restarts its timer. Stopped means no check
starts by itself - Run now still works and colleagues' checks still show - until you start it again or Fire Code
restarts: **it always starts with Fire Code**. Only you stop or start it, never an agent.

**Refresh** (the circular arrow at the top of the dashboard) brings the team's skills down now - its bucket folders and
the team repository - instead of at the next timed sync, reads the folders again, and says which monitors are new
and which are gone.

**Who wrote it, and who changed it** come from the file's history first: its commits in the **team repository
(Bitbucket)** when it is kept there, else in the **git checkout** holding it - the newest commit says who changed it
and when, unless the file has changed here since. Otherwise from its labels: every save Light Code or Fire Code makes
labels a skill with \`version\`, \`updated\` and \`updated_by\` (who saved it), and a new one with its \`author\`; a
file saved before \`updated_by\` existed shows no "by" rather than its author. The tile's tooltip and the grid
window's header show them, with "(Bitbucket)" or "(git)" when from a commit; **Changes** (the grid window's arrow button, or "Updated … by …" in its header) lists every
version - when, by whom, what changed (the schedule, which fields, or only the text around the monitor) and the
monitor as it was - and the file's commits, with who, when and the commit message. Each Fire Code records a version as it arrives; a team monitor's changes are also kept in the team
index, so every member sees the same list however long their Fire Code was closed. Cleaning up history keeps them;
deleting the monitor removes your own record of it. The grid window's buttons are icons - hover one to see what it does.

**Filtering the grid**: every column has a filter box under its name - text to find, or a condition: \`>50\`, \`>=50\`,
\`<50\`, \`10..50\` (between), \`=x\`, \`!=x\`, \`!text\` (does not contain), \`"exact"\`, \`=\` (empty), \`!=\` (not empty);
\`a, b\` for either and \`>10 & <50\` for both. A time column compares times. The funnel beside a column's name lists its
values with how many rows have each - search them, tick the ones to show, **Only these** for what the search found.
**Columns** in the toolbar chooses the columns shown, remembered for that monitor. Only the rows in view are drawn, so
a grid of 100,000 rows filters, sorts and scrolls quickly; the count says how many rows the filters leave, with
**Clear filters**.

**Copying from the grid**: click a cell to select it, Shift+click another for the block between, Ctrl+C to copy;
right-click a cell for Copy cell / row / column / whole grid; the grid window's copy button takes every row the filters
show, with headers. It pastes into Excel as cells and into Word or Outlook as a table, in the text the grid shows.

**Offline**: when the team history cannot be reached, a team monitor still runs on this computer - its tile, colours
and notifications stay current - and the tile says **Offline · N not shared**. Once the history answers again, each
offline check claims its window: written if nobody had it, dropped if a colleague already checked that window. At
most 50 per monitor are kept for this, on disk.

**Personal monitors need nothing set up.** Ask for "a personal check" (or just a check, before team history exists)
and the agent makes one only on this computer. Your own words decide: a request saying personal, private or just
for me is made personal whatever the agent passes.

**Team monitors need OpenSearch** (Settings → Monitoring → Team history): choose an OpenSearch connection from the
codebase monitoring runs with, and an index name the whole team shares. Without it a team monitor stays grey
("Needs team history"); personal monitors keep their history on this computer. Every member's Fire Code may run a
team monitor, but each slot is **claimed** first, so it runs once across the team, and everyone's dashboard shows
the newest check, saying who ran it. Writes never overwrite each other, and cleanup removes only your own checks.

**History** (the grid's History view): a bar per check in its colour, its height how many alerts it had; each
alert's pattern - **new** today, **ongoing** since when, **recurring** on several days ("usually starting around
02:00"), comes and goes, or cleared; and any past check's alerted rows. A check keeps its colour, headline and the
rows that had an alert. **Kept 90 days** by default (30 days to a year), cleaned every few hours; **Clean up now** in
Settings → Monitoring, and **Delete its history** on a tile's right-click menu - **everything, or only checks older
than 7, 30, 90 or any number of days**; **Clean up…** takes the same choice for every monitor. Both remove checks on
this computer (with the grids they kept) and **your own** records in the team index; a colleague's records are theirs
and stay until their Fire Code cleans them up. A snoozed or paused monitor keeps its
colour on its tile but no longer colours the Monitoring button.

**An alert explained**: double-click a coloured row. The author's advice for that rule comes first (asked for when
the monitor is created), then **the agent's explanation** - what is wrong, whether it is new or known from the
history, what to do. **Start a chat** opens a chat named after the alert in the codebase you pick (the first by
default), with what is known already in the message box - press Enter to send it.

**Fast data collection**: a monitor that reads SQLite or a CSV/Excel/JSON file is read by Fire Code's Rust helper
(Polars) - no Python at all. Fire Code's Rust tools can be a monitor's source too, with \`"records": true\` (a JSON list
of records): find_files (a feed file late or missing - ageMinutes, sizeBytes), grep_files (ERROR lines across logs or
shares), big_file search (one huge log), query_table, query_sqlite and dataframe. Prefer, in order: a SQLite or file
source, a Rust tool, an existing Python or MCP tool that returns records, and only then a new Python tool. Reusing an
existing Python tool is fine when it only reads and is approved on each member's computer. A Python tool source is Python: the agent is told whether Polars is installed in the tools'
environment and to prefer it to pandas (filter and aggregate there, return df.to_dicts()). Rust then judges the rows.

**Tools can call tools**: a Python tool lists what it calls in \`__tool_calls__ = ["server__query", "autosys_status"]\`
- MCP tools, other Python tools and Fire Code's reading tools. That line is part of the approved code; in a
monitor's check those calls run without asking - the same when the agent tries the monitor in a chat - and nothing
that edits or runs commands is reachable. A tool calling another Python tool several times works (before Fire Code
0.61.0 only the first call did, which read as an approval problem).

**Agents can**: \`monitor_history\` (an alert's history: new, ongoing, recurring), \`monitor_check_tool\` (run a tool once and check its answer strictly: PASS or FAIL with what
to change, and the columns and key for the monitor - an agent writing a Python tool for a monitor works until
it passes), \`monitor_status\` (every monitor, or one monitor's alerts and rows), \`monitor_show\` (check
now, open a grid or the dashboard), \`monitor_control\` (pause, snooze, acknowledge, notification level -
always asks you).
`,
  },
  {
    id: 'fire-code',
    title: 'Fire Code: several codebases in one Windows window',
    keywords: [
      'fire', 'fire code', 'sun', 'sun code', 'sun light code', 'several codebases', 'multiple codebases', 'multiple projects',
      'many projects', 'one window', 'parallel', 'background agents', 'desktop app', 'windows app',
      'sidebar', 'sleep', 'idle', 'switch project', 'credentials', 'saved credential',
      'share keys', 'share api keys', 'pycharm', 'intellij keys', 'shared drive', 'network drive',
      'big log', 'large log', 'big csv', 'large csv', 'huge file', 'find files', 'duplicate files',
      'sqlite', 'sqlite database', 'sqlite db', 'read a database', 'query a database', 'locking',
      'several chats', 'two chats', 'parallel chats', 'parallel agents', 'chat tabs', 'new chat tab',
      'archive chat', 'archived chat', 'close chat', 'blank chat', 'new chat shows old', 'reopen chat',
      'two agents same codebase', 'same codebase at once', 'same codebase', 'second chat',
      'environment variable', 'environment variables', 'startup script', 'setenv', 'add to path',
      'path variable', 'report viewer', 'open report', 'html report', 'markdown report',
      'copy folder', 'move folder', 'move files', 'copy files', 'zip', 'unzip', 'archive', 'compress',
      'export credentials', 'sun code', 'other codebase', 'another codebase', 'refer to another project',
      'file from another codebase', 'cross codebase', 'waiting for me', 'which codebase is waiting',
      'needs my approval', 'short name', 'codebase name', 'review python tools once',
    ],
    body: `
**Editing skills, tools and the standing instructions in Fire Code.** Fire Code has no code editor, so
*Open* on a skill or tool (and the standing-instructions button in the Skills tab) opens Light Code's own
editor: a full-panel text box with Save (Ctrl+S), Close (Esc) and a Markdown preview. A save is refused if
the file changed on disk after it was opened, rather than overwriting that change.

**Fire Code** (called Sun Code until 0.6.0, and Sun Light Code before that) is a Windows app holding every codebase you work on,
each with its own Light Code agent. Install with \`npm i -g @chosengeneration/fire-code\` and run
\`fire-code\`. Its data moves across from the old name by itself on first start. The
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

**Credentials** (the key button in Fire Code's sidebar): keys and passwords saved once, by name, encrypted for
your Windows account, and picked in any codebase's settings with "Use a saved credential" — changing one
updates everything that uses it. Values are never shown again. Bring keys in from VS Code with the command
"Light Code: Share credentials with Fire Code" (API keys, passwords, usernames, tokens), from IntelliJ / PyCharm with the button on the
Credentials page, or from another computer with Export / Import (a passphrase-encrypted file).
Codebases whose settings are linked to or copied from that VS Code config work at once - their settings
already point at what was shared. A codebase with its own (New) settings picks them with "Use a saved
credential". A username and password for the same connection arrive as one login, offered as
"— username" and "— password". Hover a long name in any dropdown to see it in full.

**Python tools are reviewed once for all codebases**: approving a tool records its exact code for this
machine, so every other codebase holding the identical file approves it too, within a few seconds and
with a note saying so - whether the copies come from a bucket, a shared folder or each project's own
.lightcode/tools. A changed byte is a different tool and asks again; a declined tool stays declined.

**Several chats per codebase**: the tabs above the chat. + (or Ctrl+T, or right-click → New chat) opens
another chat on the same codebase — its own agent, working at the same time, with the same settings and
keys. To rename a chat - the first one too - double-click its tab, or right-click it → Rename chat; the
name shows on the tab and in notifications. × or Ctrl+W asks how to close a chat: **Archive** keeps its
conversation and takes the tab away; **Close and delete** removes its conversations, reports and log
(files it changed in the codebase stay). **New chat** is always blank - a closed chat's number is never
reused - and when chats are archived, + offers *New blank chat* or any archived chat, which opens exactly
where it was left (each archived row also has a delete). Ctrl+T is always blank. Two safeguards make
this safe: an edit is refused when the file changed since that chat read it (another chat, you, or any
program edited it) — the agent re-reads and edits what is there now; and **Rollback undoes only the files
that chat changed**, never another chat's work. If another chat also changed one of those files since,
Rollback asks first and leaves it alone unless you say so. A **shell command** that names a file which
changed since the chat read it is refused until the chat reads it again (reading commands are fine).

**Environment** (Fire Code's Settings → Environment): given to every agent in every codebase. A **startup
script** (.cmd, .bat or .ps1) runs when Fire Code starts, and the variables it sets and folders it adds to PATH
reach every session — agents wait for it; Run now re-runs it after an edit. **Folders put in front of
PATH** (%NAME% expands). **Variables**, each a value or a saved credential (use a credential for anything
secret). Commands the agents run see all of it; Python tools and MCP servers see PATH only, unless their
own settings name a variable. Changes apply to agents started afterwards — the page offers to restart the
running ones.

**Reports**: "Open report" on a notification opens it in Fire Code's own viewer — Markdown (tables, code,
lists) or HTML (shown with its styles, but no scripts and nothing loaded from the internet).
Right-click a codebase → Reports… lists every report its chats wrote. An agent can attach a report file
it wrote, .md or .html, with \`notify\`'s \`report\`.

**Copy, move and zip** (Rust, every core): \`transfer_files\` copies or moves files and whole folders
(a move on one drive is an instant rename), and \`archive_files\` creates, extracts or lists a .zip.
Both **always ask**, showing every source, destination, file count, size and anything replaced, and are
never available to a schedule. An archive whose entries would land outside the destination is refused.

**Other codebases**: every agent knows the other codebases open in Fire Code, by a short name (shown when you
type \`@\`, and at the top of the codebase's right-click menu with a Copy button), and may read them.
\`@payments-api\` attaches that codebase's top folder; \`@payments-api:\` opens the picker inside it;
\`@payments-api:src/app.py\` attaches that file. A codebase's own name works in its own chats too.
@ matches file and folder **names**; when nothing matches, the picker says so - to find text inside
files, ask the assistant. Writing in another codebase asks every time. Just ask
"how does payments-api handle retries?" and the agent can look.

**@ search** in Fire Code runs on the Rust helper: every core, and files your .gitignore excludes stay out.

**Waiting for you**: when an agent needs you - an approval, an answer to its question, a form - a "!"
appears on top of that codebase's tile, its row turns amber and says what it needs, its chat tab is marked,
and "2 waiting" appears beside the Codebases heading (each click opens the next one). The title bar counts
them, the taskbar button flashes when Fire Code is in the background, and a notification says which.

**What changed, at a glance**: a codebase managed by git shows **+new ~modified −deleted** on its sidebar
row (only the non-zero ones; hover for the branch and the changed file names). Refreshed every 30 seconds,
when you open it, and when an agent finishes. It never takes git's lock, so it cannot get in the way of
your own git commands. Hover the row for two buttons: **Commit and push…** opens a dialog listing what
changed, with a message box and **Write with agent** (the codebase's model drafts a message from the
diff; you edit it; nothing is committed until you press Commit and push) - everything changed is
committed, and a new branch is pushed to origin and tracked. **Pull** brings in the remote's changes,
fast-forward only: when your branch and the remote have both moved, nothing is pulled and it says so.

**No Review or Variables tab**: those belong to a shared server (\`light-code --server\`), and a chat's
settings on your own machine leave them out. Environment variables for agents go in Fire Code's
Settings → Environment.

**Exporting credentials**: tick the ones to export (nothing is ticked to begin with; filter by label).

**Keyboard**: Ctrl+K switch, Ctrl+1–9 jump, Ctrl+Tab next, Ctrl+T new chat, Ctrl+W close chat, Ctrl+B
hide the sidebar (a strip of status dots stays), Ctrl+, Fire Code's settings.

**Appearance**: Fire Code's Settings choose light, dark or system and an accent colour; every chat follows
the theme. A codebase may keep its own accent — pick one in its Appearance tab — and its sidebar
icon follows; "Use Fire Code's accent" goes back. Role colours stay each chat's own. None of this
is written to the config file.

**Memory**: idle codebases sleep after 30 minutes by default (Fire Code's Settings), freeing their agent,
MCP servers and Python worker. Never while working or waiting for you. **Schedules still run**: Fire Code
keeps their timetable itself and wakes a codebase a minute before a job is due — asleep or never
started this session — then lets it sleep again a couple of minutes after. A job missed while the PC
slept runs when Fire Code next sees it. Only a codebase's first chat runs its schedules, so a job runs once
however many chats are open.
Clicking wakes it with the chat intact. Right-click → Keep awake exempts one.

**Reach beyond the codebase** (Fire Code's Settings, on by default): agents read any drive or shared folder
(\\\\server\\share) without a folder prompt, and may write anywhere — but every write outside the codebase
asks, shows the diff, and says Rollback cannot undo it. Keys, passwords, browser logins, Light Code's
own vault and Windows/program folders stay off-limits whatever the setting.

**DFS shares** (\`\\\\company\\dfs\\...\`) are used exactly as written - also through a drive letter mapped onto
one. Before 0.153.0 Light Code followed DFS to the server behind it and opened that path directly, which
can be refused even when the DFS path works for you; a plain NAS share was never affected.

**Parallel file tools** (Rust, every CPU core), for big jobs: \`find_files\` (find by name, type, size or
date across drives and shares; summarise a folder; find duplicate files), \`read_many_files\` (up to 50
at once), \`big_file\` (inspect, read any window, tail, or search a huge log with context) and
\`query_table\` (filter, group and total a CSV or Excel sheet of millions of rows, a page at a time).
All read-only. Ask in plain words — "summarise the errors in this 2 GB log", "total sales by region in
this spreadsheet".

**In VS Code too**: when Fire Code is installed on the machine, the Light Code extension (and \`light-code\`
run on its own) finds Fire Code's Rust helper and offers these tools as well - nothing extra to install,
and the extension stays small. Fire Code records where its helper is each time it starts; an older Fire
Code offers only the tools it has. Reload the VS Code window after installing or updating Fire Code.

**SQLite databases** (\`query_sqlite\`): the schema with row counts, any read-only SQL, a big table
filtered, grouped and sorted across every core, or a piece of text found in any column of any table.
**It never creates a database** - a mistyped path is reported, not turned into a new empty file - and
writes are refused. **It never blocks the program that owns the database**: a classic database is opened
without taking any lock (and checked before and after for a write that landed mid-read, retried, or
flagged as possibly inconsistent); a WAL database with recent changes is read as a WAL reader, which
never blocks a writer. Parallel ranges pay off on heavy work - grouping by several columns, text across
every column - by two to three times on 8 cores; a light filtered count is limited by reading the file.

**Reading a program paused in VS Code's debugger** works from Fire Code too: with a VS Code window open
(Light Code 0.166.0 or later installed there), \`read_debug_session\` asks every open VS Code window and
reads the one stopped at a breakpoint - call stack, variables, recent output - through the same private
link Copilot uses. Read-only: it cannot step or continue. IntelliJ and PyCharm are not supported yet.

**Memory and disk.** Each chat is its own agent process. A chat page you are not looking at is
**unloaded after a few idle minutes** while its agent keeps running (Settings → *Unload hidden chat
pages after*; never while it is working or waiting for you), and a whole codebase **sleeps** after
the idle time set there. The chats of one codebase **share** its checkpoint store, its Python venv
and its index bookkeeping, so a new chat no longer adds another copy of the codebase's snapshots.
WebView2's cache is capped at 32 MB.

**Not in Fire Code**: editor file pickers — paths are typed. Fire Code's
Settings → Export source code saves the whole repository as a zip that builds offline.
`,
  },
  {
    id: 'addons',
    title: 'Add-ons',
    keywords: [
      'addon', 'add-on', 'add-ons', 'addons', 'plugin', 'plugins', 'extension', 'extend', 'extendable',
      'more tools', 'my own tools', 'node app', 'node package', 'npm package', 'install tools', 'npm i -g',
      'write an addon', 'create an addon', 'build an addon', 'lightcode addon', 'package.json',
      'addon for fire code', 'fire code addon', 'addon for light code', 'light code addon', 'addon tools',
      'linux', 'linux machine', 'linux server', 'ssh', 'putty', 'plink', 'pageant', 'remote server', 'connect to a server',
      'run a command on a server', 'download a log', 'jump host', 'bastion', 'host key', 'addon tab', 'linux tab',
      'add-ons tab', 'enable addon', 'disable addon', 'linux tab missing', 'addon could not start', 'addon failed', 'start again',
      'ssh key', 'set up ssh key', 'key setup', 'authorized_keys', 'passwordless',
    ],
    body: `
**An add-on is an npm package that runs an MCP server**, labelled in its \`package.json\`:

    {
      "name": "light-code-addon-weather",
      "version": "1.0.0",
      "type": "module",
      "lightCode": { "addon": { "main": "server.js", "displayName": "Weather" } },
      "dependencies": { "@modelcontextprotocol/sdk": "^1.30.0", "zod": "^3.25.0" }
    }

\`main\` is an MCP server over stdio, written with \`@modelcontextprotocol/sdk\` (\`McpServer\`,
\`registerTool\`, \`StdioServerTransport\`). \`examples/light-code-addon-hello\` in the source is a
complete one. Light Code, Fire Code, the Node host and the JetBrains plugin all use the same add-ons.

**Install it** with \`npm i -g <package or folder>\`, then open **Settings → Add-ons** (the puzzle
piece). Light Code finds it by itself in npm's global folder - also where \`npm config set prefix\` moved
it, and beside node.exe - and in any folders listed there (Browse… adds one). **Installed is not
enabled**: press Enable, read the program it will run, and confirm. Its tools then appear as
\`addon-<name>__<tool>\` and are asked about like every other tool. An add-on's server is not listed on
the MCP tab, which keeps the servers you configured yourself.

**An update stays off until you enable the new version** - new code is looked at first. An add-on
that is no longer installed stays off and is listed so you can remove it. Enabling writes an ordinary
\`mcpServers\` entry, so export and the JSON editor carry it; on another machine it runs only if that
machine has the add-on installed, and from wherever it is installed there. A repository's own settings
can never switch an add-on on. \`addons.folders\` is user-scope only.

**Add-ons run as you and can do anything you can.** Only install ones you trust. They run with the
editor's own Node inside VS Code, so no Node install is needed there; Fire Code uses its Node.

**An add-on can bring its own settings tab**, with its own icon - it appears in Settings only while
the add-on is installed **and enabled**; disable it and the tab goes (what you entered is kept). The tab
lists the tools the add-on gives the assistant, each with Ask first / Always allow / Never. The add-on describes the fields in \`package.json\`
(\`lightCode.addon.settings\`: a title, its own fields, and a list such as "machines" with buttons like
Test connection); Light Code draws the form. What you enter is kept in your settings, passwords in
secret storage, and the add-on receives them when it starts - saving the tab restarts it.

**The Linux add-on** (\`npm i -g @chosengeneration/light-code-addon-linux\`): enable it on the
**Add-ons** tab, then add machines on its **Linux** tab, each with a short label (\`prod-web-1\`), host, user
and sign-in (Pageant - the default - the Windows OpenSSH agent, a key file, or a password), and press
Test connection. The assistant can then list the machines, **run read-only commands** (\`df -h\`, \`tail\`,
\`grep\`, \`ps\`, \`journalctl\`, \`systemctl status\`, \`docker ps\`... joined with \`|\`; nothing that writes,
chains or never ends is sent) and **download a file** to read here. SSH runs inside Node - no plink, no
ssh.exe, no new program - with one sign-in per machine reused, and a refused sign-in never retried, so
it does not set off security monitoring or lock an account. Host keys are trusted the first time and
checked after; a changed key is refused until you press Forget host key. A machine behind a bastion:
add the bastion too and put its label in *Connect through*. Newer PuTTY keys (.ppk version 3): load
them into Pageant, or export an OpenSSH key from PuTTYgen. **No key yet?** Choose Password, then press
**Set up SSH key** on the machine: it makes one key for this PC (\`.ssh\\light-code_ed25519\`), adds its
public half to the server's authorized_keys with the stored password, proves the key works, and switches
the machine to it. It is a button only - the assistant cannot call it - and the tab lists the tools the
assistant does get. A globally installed add-on is found by itself (npm's folder, your .npmrc prefix,
or beside node.exe); the folder box is only for somewhere else.

**The Linux tab is missing, or Enable seemed to do nothing?** Look at the add-on's row on the **Add-ons**
tab: once enabled it says Running, or *Could not start* with the reason, a **Log** with what the add-on
printed, and **Start again**. An add-on that cannot start is still enabled, so its tab is there. Any
other failure is shown at the top of the Add-ons tab (not in the chat). Fire Code writes the full error to
the agent's log too (right-click the codebase → View agent log); VS Code to View → Output → Light Code.
`,
  },
  {
    id: 'codebase-instructions',
    title: 'Codebase instructions',
    keywords: [
      'codebase instructions', 'project instructions', 'instructions for this codebase', 'every chat',
      'all chats', 'instructions for all chats', 'always tell it', 'remember for this project',
      'agents.md', 'claude.md', 'rules for this repo', 'house rules', 'system prompt', 'custom instructions',
      'edit codebase instructions', 'codebase instructions in fire code',
    ],
    body: `
**Three levels**, most specific first: what you say **in the chat**, then **codebase instructions**,
then **standing instructions**. Every chat on a codebase gets the codebase instructions with every
message; where they disagree with the standing instructions the codebase instructions win. They are
placed at the end of what the agent is told (before only a plan you set for the chat), and named at the
very start, because instructions in the middle of a long prompt are the ones a model follows least.

**Codebase instructions** are about one codebase and are kept on this machine, not in the repository,
so a cloned repository cannot write them. Edit them in **Settings → Skills → Codebase instructions**,
or in **Fire Code** from a codebase's right-click menu → **Codebase instructions…**. A save reaches every
chat on that codebase from its next message - nothing restarts. Only the first 20,000 characters are
sent; keep them short, they are paid for on every request.

**Standing instructions** are a skill with \`always: true\` (Settings → Skills → Standing
instructions). They can live in the repository or a shared bucket, so they can apply to many
codebases and a whole team. Fire Code's dialog has a button that opens them too.
`,
  },
  {
    id: 'diagrams',
    title: 'Diagrams in the chat: SVG and PNG',
    keywords: [
      'diagram', 'flowchart', 'flow chart', 'architecture diagram', 'draw', 'save svg', 'save png',
      'save diagram', 'export diagram', 'download diagram', 'diagram as image', 'show_diagram',
    ],
    body: `
Ask for a diagram ("draw the request flow", "show the architecture") and the assistant draws one in the
chat with \`show_diagram\`. It follows your theme and accent.

Under each diagram: **Copy SVG** copies the markup to paste into a document or editor; **Save SVG** and
**Save PNG** open a Save dialog - VS Code's own, or a Windows one in Fire Code starting in Downloads - and
say where the file went. A PNG is drawn at twice the size so it stays sharp in a slide. In a plain browser
the file downloads instead. If a save fails, the reason is shown under the buttons.
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
    id: 'strategies',
    title: 'Strategy: drawing how the agent team works, step by step',
    keywords: [
      'strategy', 'strategies', 'flow chart', 'flowchart', 'chart', 'draw', 'node', 'nodes', 'step', 'steps', 'connector',
      'connectors', 'arrow', 'connect', 'back and forth', 'loop', 'rounds', 'until', 'parallel', 'parallel box', 'contract',
      'read-only role', 'instructions for a role', 'what passed between', 'why did it go back', 'which step is running',
      'add steps', 'add a step', 'add connectors', 'how do i connect', 'sub agent', 'subagent', 'sub agents', 'own process',
      'in the strategy', 'strategy window', 'strategy button', 'a strategy', 'the strategy', 'strategy for', 'agents agreed', 'what was agreed', 'agreed between', 'specialists have', 'their own context', 'own context', 'specialist', 'specialists', 'data contract', 'contract between', 'between agents', 'know about the strategy', 'doesnt know about the strategy',
    ],
    body: `
A strategy is a flow chart of how the main agent uses its specialists: which role does what, in which order, which
pairs go back and forth until a condition holds, and which work at the same time. Saved strategies are reusable;
each chat uses one or none.

**Opening it.** Assign at least one specialist in Settings → Agents (any role - the expert is no longer required);
a **Strategy** button then appears beside the mode picker above the message box, in every mode. In VS Code it opens
as its own editor tab, where the chart has room; in Fire Code and the browser it opens over the chat. The command
"Light Code: Open Strategy (Agent team)" opens it too.

**Adding a step.** Click a role in the list on the left (Programmer, Tester...). It appears on the chart as a box.
Drag a box to move it. A role with no model yet is marked and has to be assigned before the strategy can run it.

**Connecting two steps.** Select a step and press **Connect to...** on the right, then click the step it should lead
to (Esc cancels). Or drag from the coloured dot on a step's right edge onto the other step. Click a connector to
change it; Delete removes whatever is selected.

**A back-and-forth** (the programmer changes it, the tester checks, and back): connect the two steps again the other
way, or tick **Back and forth** on the connector. Then write **Until** - the condition that ends it, judged by the
step the arrow points to ("every test passes and the tester has no concerns") - and **At most this many rounds**
(10 when left alone). **Reverse** swaps which side works and which judges. Light Code counts the rounds from the
consultations that actually ran, asks the judging role to end its answer with CONDITION: MET or NOT MET and why, and
refuses a round past the maximum - the agent then stops and tells you what is still open.

**A parallel box.** Press **Add a parallel box** on the left and drop steps into it: they are consulted at the same
time, each specialist in its own process, and the strategy carries on when all have answered (the agent uses one
ask_agents call). Drag the box to move it with its steps, its corner to resize it. One role belongs in a box once.
If several of them need your approval at once, the prompts come one at a time.

**Each step:** the ✎ on a box opens **Instructions for this specialist**, sent to it with every question it is asked
under this strategy - leave it empty and the main agent decides what to ask it, from its plan. **Read-only** means it
cannot change anything: it gets no tool that edits or runs commands, and recommends instead.

**A contract on a connector** ("What passes along here"): what one step hands to the next, such as "the failing
tests, each with file:line". The first is told its answer must contain it, the second that it will be given it and to
say what is missing - so what was agreed between them is written down. **Where to see it:** click the arrow - the
contract is on the right; with nothing selected, the right-hand panel lists every contract in the strategy, and an
arrow carrying one is labelled "contract". What was actually sent and answered along it is under "What passed
between them" (select the arrow to narrow it to those two).

**Using it.** **Save** only keeps it in your library; **Save and use in this chat** puts it to work here - the
button then reads "Strategy: <name>". The list at the top opens a saved one; **Stop using** takes it off this chat.

**When the agent knows it:** from your next message, in any mode. The strategy goes into the agent's instructions
each time you send something, so a strategy set while a reply is running applies from the next one. If the agent
seems not to know it, check the button says "Strategy: <name>" - Save alone does not use it. A new chat starts with
none (choose it from the list); New chat with handoff keeps it. With a strategy in use, the agent first proposes a
plan with update_plan that carries out every step, then follows it. A question of yours that is not part of the
strategy is answered normally.

**Watching it run.** The step at work glows (moving while it works), its box says "working now" or "answered last",
and the **Now** panel names it with every loop's round and verdict. The Strategy button shows who is working.
**What passed between them** lists every consultation - what was asked, what came back, the round and verdict -
for the whole strategy or for the selected step or connector. **Ask the agent why** puts a question in the chat for
the main agent, which answers from that record (the strategy_history tool), even after the chat was compacted.

**Each specialist is a sub-agent with its own process and its own memory**, in every mode, Auto included - the Rust
helper's fire-fs agent, for a role on an OpenAI, Anthropic or Gemini profile. It remembers earlier questions in the
chat; near its context limit it writes its own key points and starts a fresh session with them by itself. The main
agent sees only its answers, never its working. Its tool calls run through your approvals, and the prompt says which
specialist is asking. A new chat starts every specialist afresh. A role on the Claude CLI keeps the CLI's own session;
where the helper is missing, each question is answered on its own. Strategies are saved in config:strategies and can
be shared through export (the Strategies section).
`,
  },
  {
    id: 'agents',
    title: 'The expert and the agent team',
    keywords: ['expert', 'agent', 'team', 'role', 'reviewer', 'consult', 'claude', 'cost', 'budget', ],
    body: `
**Settings → Agents.** Off by default; nothing is spawned and nothing is spent until you enable it.

**Strategies** - a flow chart of how the specialists are used, each running as its own sub-agent process - have
their own topic: ask about strategies.

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
      'limit', 'continue', 'context length exceeded', 'too long', 'token limit', 'compact now',
      'lost what i typed', 'draft', 'missing context', 'forgot', 'forgets', 'auto compact', 'compact automatically',
      'retry', 'retries', 'stuck thinking', 'thinking forever', 'hangs', 'connection dropped', 'timeout', '502', '429', 'drag and drop', 'drop a file', 'dropped', 'attach a file',
      'file is too large', 'drag an email', 'add files to context', 'add file to chat', 'copilot',
      'select files', 'current file', 'handoff', 'hand over', 'new chat with handoff', 'new chat with a handoff', 'a handoff', 'start fresh', 'clean handover',
    ],
    body: `
The token bar under the composer shows where the window is going — system prompt, tool
definitions, history, results — plus the cache hit rate. Before a reply the numbers are **estimates**: a real tokeniser would be a large download and
would still be wrong for a gateway that rewrites the prompt. **After each reply the total is the
provider's own count** (OpenAI-compatible gateways and vLLM are asked for it; Anthropic and Gemini
send it), and that count corrects the estimate for the same model from then on - so the bar, and
the point where compaction starts, follow what the model really holds. Code, JSON, paths and logs
take more tokens per character than prose, which is why an estimate alone read 175k while the
gateway already counted over 262k. A refusal for length that states the prompt's size corrects it too.

**Results dominate**, not the prompt. So an oversized tool result is capped, the full output is
written to disk, and a handle is returned that the model can re-read with an offset. Nothing is
lost; it is just not all in the window at once.

**Superseded reads are dropped** — if a file was read three times, only the latest matters. Repeated
*commands* are not dropped, because running the tests twice gives two real answers.

**A new chat with a handoff** (the button beside +, a page with an arrow): when a long chat is near the
limit and compacting would blur it, start clean instead. The assistant writes a handoff - the goal, what
is done and decided, the current state, open questions and next steps - and a new chat opens with it as
its first message. Your own messages are quoted word for word, and the files read and changed and the
commands run are listed from the actual tool calls, so nothing important rests on the summary alone. A
progress panel shows each step and how much has been written; Cancel stops it, and a failure leaves the
chat as it was. The old chat stays in History. When a reply fails because the conversation is too long
for the model, the error offers this too - it still works then, because the write-up is made from a
shortened transcript.

**History is compacted only when you say so.** **Compact now** under the token bar summarises the
older part (highlighted near the limit); the stored transcript keeps everything, only what is sent to
the model is shortened, and never in the middle of a tool call. Your own messages are kept **word for
word** inside the summary, every time, so what you asked for is never paraphrased away.
Tick **Compact automatically** beside the button (config:autoCompact) to have it done near the limit,
keeping roughly the last third of the window verbatim - and only for a model whose window Light Code
knows: from the table, from the model's own server (a self-hosted vLLM or SGLang reports its real
limit on /models, and every server states it when it refuses a request as too long - Light Code
remembers that number), or from the window you set under the profile's capabilities, which wins.
For a model none of these covers it waits for the model to refuse instead of guessing. **When the model refuses the conversation as too long**: with
automatic compaction on it is compacted and sent again; with it off the message says to press Compact
now. Scheduled runs always compact by themselves - nobody is there to press the button.

**A reply that hangs or a connection that drops is retried by itself.** A request that sends nothing
at all - no text, no thinking - for 5 minutes is stopped and sent again, and a dropped connection, a
gateway error (5xx), rate limiting (429) or overload (529) is retried after a few seconds, waiting
longer each time, up to 3 times; the chat shows "Retrying in Ns" while it waits. A rejected key, a bad
request or a certificate problem is never retried. Both numbers are in Settings → Approvals →
"Unresponsive or failing model" (config:connection.stallSeconds, 0 = never give up;
config:connection.retries).

**What you type is kept** if you switch away - Settings, History, another view - and come back.

**Drop any file into the chat**, or attach it with the clip: a picture goes to the model as a picture;
a small text file is pasted in; anything else - a big log, a PDF, Word, Excel, an **email dragged out
of Outlook** (up to 20 MB) - is saved to a temporary folder and read for you, and an email's own
attachments are read too. A long one is cut, with the saved path, and the assistant reads the rest
with read_file without asking. Nothing is saved into your project.

**Choosing files for the message, as in Copilot** (VS Code): the page-with-a-plus button beside the
clip lists the workspace - open files first, the current one ticked - and adds what you tick as
\`@\` mentions. Or right-click files in the Explorer, an editor tab or the editor and choose **Add to
Light Code chat**. Typing \`@\` does the same from the keyboard, everywhere.

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

**In the Node host, PyCharm / IntelliJ and Fire Code** Light Code starts language servers itself —
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

**Where several chats share a codebase** (Fire Code's chat tabs, or a host started with
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
      'dark mode', 'light mode', 'change the colour', 'change the color', 'pycharm dark', 'intellij dark',
      'copy', 'paste', 'word', 'onenote', 'copy table', 'paste into word', 'formatting',
    ],
    body: `
**Copying a reply keeps its formatting.** Select part of a reply and press Ctrl+C, or press a reply's
**Copy** button for the whole of it: tables (with borders and a header row), headings, lists, quotes
and code paste into Word, OneNote, a wiki or an email as they look in the chat - in dark text on a
white page, whatever theme the editor uses. The plain-text version is the reply's Markdown, for wikis
and Markdown editors.

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

**In IntelliJ and PyCharm the panel follows the IDE's theme**, and changes with it (plugin 0.4.63 on).
There \`system\` means the IDE's theme - the embedded browser on its own always reports light - and
Light or Dark in Settings → Appearance overrides it.

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
      'greyed out', 'grayed out', 'disabled', 'cannot click', 'not clickable',
      'python.exe crashed', 'python crashed', 'stopped working', 'agent crashed', 'conversation lost', 'draft lost',
      'typed message gone', 'host.log',
    ],
    body: `
**The agent crashed, or python.exe "stopped working".** A Python tool's worker that crashes is restarted on the
next call, and the call that hit it says why - the Windows crash code in words (an access violation in a native
library, a stack overflow, a missing DLL) and Python's own last lines, which it now prints on a native crash. It no
longer takes the agent down with it (it used to, through the worker's closed input). Fire Code also stops Windows
showing its "stopped working" box for the programs it starts, which kept a crashed worker alive until dismissed. The
conversation is saved as the turn goes - after your message and after each tool result - and what you were typing is
kept by the agent as well, so a restart loses neither. Each chat's log is \`host.log\` in its data folder, with the
run before as \`host.previous.log\`: an error the agent survived is written there as "kept running".

**A button is greyed out.** Hover over it: every control that can be disabled says why in its
tooltip - nothing changed since the last save, a field still empty, a reply still running, a
feature switched off elsewhere - and usually what to do about it.

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
