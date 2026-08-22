/**
 * The guided tour, as data.
 *
 * Written once here and rendered twice: `scripts/generate-walkthrough.mjs` turns it into VS
 * Code's `contributes.walkthroughs`, and `packages/ui/src/guide` renders it inside the browser
 * host, which has no Get Started page to borrow.
 *
 * ## Why the tab link is structured rather than a markdown link
 *
 * VS Code wants `[Open the MCP tab](command:lightCode.openSettings?%5B%22mcp%22%5D)`. A browser
 * has no command URIs — the same intent is a button that switches the panel's tab directly. So
 * the step records *which tab*, and each renderer expresses that in its own terms. Baking the
 * command URI in here would have made the browser parse a VS Code URI back out to find the tab
 * name, which is a translation nobody should have to debug.
 *
 * Pure strings, no imports: this is reachable from `@light-code/core/browser`, so anything that
 * pulled in `node:*` would break the webview bundle (see `browser.ts`).
 */

/** Tabs a step can send the reader to. Matched against the settings panel's own tab ids. */
export type GuideTab =
  | 'providers'
  | 'approvals'
  | 'mcp'
  | 'search'
  | 'expert'
  | 'schedules'
  | 'python'
  | 'tools'
  | 'skills'
  | 'network'
  | 'appearance'

export interface GuideStep {
  id: string
  title: string
  /** Paragraphs. Light markdown — `**bold**` and backtick code — and nothing else. */
  body: string[]
  /** The settings tab this step is about, if any. */
  tab?: GuideTab
  /** True where the action is "look at the chat", not a settings tab. */
  opensPanel?: boolean
  /**
   * What marks the step done in VS Code.
   *
   * The first two are satisfied by *state* rather than by being clicked, so someone who already
   * configured a provider is not told to go and do it again. Meaningless in the browser, which
   * has no per-step completion, and harmless there.
   */
  completionEvents: string[]
  /** Describes the diagram for a screen reader. */
  altText: string
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: 'orientation',
    title: 'Where everything is',
    opensPanel: true,
    completionEvents: ['onCommand:lightCode.openPanel'],
    altText:
      'The VS Code window: the Light Code icon in the activity bar, the chat panel, and the new-task, history, settings and guide buttons in its header.',
    body: [
      'Light Code lives in one sidebar panel. The chat is the whole product; the gear opens eleven settings tabs, and the question mark reopens this guide whenever you want it.',
      'The numbers in the picture are the four things worth knowing before anything else.',
    ],
  },
  {
    id: 'providers',
    title: 'Providers - point it at a model',
    tab: 'providers',
    completionEvents: ['onContext:lightCode.hasProvider'],
    altText:
      'The Providers tab, showing the profile list and the fields for editing one: preset, label, base URL, authentication, API key, model and Test connection.',
    body: [
      'Nothing ships configured. There are no default endpoints, so a fresh install contacts nothing until you fill this in.',
      '**Preset** prefills a base URL and wire format - OpenAI-compatible, Anthropic, Gemini, DeepSeek - and every field stays editable for a gateway that fronts one differently. **Authentication** is a separate axis: an API key, or Apigee client-certificate mTLS with a token grant. **Model** is fetched from your gateway and always typeable, because many return nothing. Keep one profile per gateway and switch between them from the chat header.',
      '**Test connection** is the field worth using first: it loads certificates, gets a token, lists models, and tells you which of the three failed.',
    ],
  },
  {
    id: 'network',
    title: 'Network - certificates, once, for everything',
    tab: 'network',
    completionEvents: ['onStepSelected'],
    altText:
      'The Network tab, showing certificate directory, CA certificate, client certificate and key, PFX bundle, passphrase, and the verify-TLS toggle.',
    body: [
      'If your company intercepts TLS or issues client certificates, this is the only place you set that up. It applies to every connection: the gateway, the token endpoint, MCP over HTTP, the vector store and the embedder.',
      '**CA certificate** is added to the public roots rather than replacing them, so trusting your corporate root does not cost you every other host. **Certificate and key** - or a **PFX bundle**, which is what Windows PKI usually issues - identify you. Any single connection can override either.',
      '**Verify TLS certificates** can be turned off, and the panel says plainly what that costs: an interceptor can read and change the traffic, API key included. Add the CA instead.',
    ],
  },
  {
    id: 'chat',
    title: 'The chat - ask for something real',
    opensPanel: true,
    completionEvents: ['onContext:lightCode.hasChatted'],
    altText:
      'The chat header, with the mode selector, the expert budget, and the four header buttons labelled; below it, the composer.',
    body: [
      'Type a request. It reads files, searches, edits and runs commands, one step at a time, and stops when it is done or when it needs you.',
      '**@** names a file directly. Paste a screenshot, or drop a Word, Excel, PDF or HTML file in. Long output is truncated with a handle it can re-read, so a huge log does not eat the window - the bar above the composer shows what has.',
      '**Mode** picks what it may do: Code edits and runs, Ask is read-only, Junior brings the expert in. **History** keeps every past task, and reopening one restores the whole transcript.',
    ],
  },
  {
    id: 'approvals',
    title: 'Approvals - nothing happens without you',
    tab: 'approvals',
    completionEvents: ['onStepSelected'],
    altText:
      'The Approvals tab, showing four auto-approve toggles all off, the always-allowed command and tool lists, extra readable folders, and the maximum-steps setting.',
    body: [
      "Every tool call is shown before it runs, as ground truth: the real command, the computed diff, the actual source. Never the model's description of what it means to do. **Deny** is a real answer - it goes back as a result and the turn continues.",
      'This tab is where standing permission is granted and, more importantly, taken back. The four toggles skip the prompt by category and **all ship off**. Below them are the grants you made in the chat: always-allowed commands, always-allowed MCP tools, and folders outside the workspace it may read.',
      'Command matching is **exact, byte for byte**. Allowing `npm test` never allows `npm test && rm -rf /`.',
      'Before its first edit to a task it snapshots the workspace, so you can roll the whole thing back.',
    ],
  },
  {
    id: 'mcp',
    title: 'MCP - connect the servers you already run',
    tab: 'mcp',
    completionEvents: ['onStepSelected'],
    altText:
      'The MCP tab, showing two servers with health, per-tool Always/Ask/Never controls, and the JSON configuration box.',
    body: [
      'Standard `mcpServers` configuration, so a config from another client pastes in unchanged. stdio or HTTP, inferred from whether you gave a command or a URL.',
      'Servers connect when the panel opens and show health, so a mistyped command is visible immediately rather than the first time something needs it. Every tool is namespaced `server__tool`, and each one has its own **Always / Ask / Never** - one server can expose forty.',
      'Secrets go in as `${secret:NAME}` and are resolved from the OS keychain at spawn time, never written into the file.',
    ],
  },
  {
    id: 'python',
    title: 'Python - let it write its own tools',
    tab: 'python',
    completionEvents: ['onStepSelected'],
    altText:
      'The Python tab, showing the enable toggle, uv path, environment choice, tools folder, package index, timeout, and a created tool with its content-hash approval note.',
    body: [
      'It can write a Python tool mid-conversation and call it from the next message. Dependencies are declared in the file and installed with `uv`; the schema comes from your type hints, so there is no metadata to keep in step.',
      "**Python environment** prefers your project's own venv, because that is where your internal libraries already are. **Package index** can point at an internal mirror, or refuse the network entirely.",
      'This is the sharpest surface in the product, so it is off by default and creating a tool **always** prompts with the full source - no toggle skips it. Approval pins a hash of exactly what you saw; a file edited outside is refused and reported, and tools live in `.lightcode/tools/` so they land in git and get reviewed.',
    ],
  },
  {
    id: 'skills',
    title: 'Skills - teach it your conventions',
    tab: 'skills',
    completionEvents: ['onStepSelected'],
    altText:
      'The Skills tab, showing two skills, a note that they are found by searching rather than listing, the writable skills folder, extra read-only folders, the problems list, and the approval note.',
    body: [
      'A skill is a markdown file with a name and a description. The body is never in the prompt - it is read with `read_file` when a task actually calls for it, so a skill can be as long as you like.',
      'By default the summaries are not in the prompt either: the assistant searches for a relevant note with `search_docs`, the same way it finds tools. What stays is a count and an instruction to look, so it still knows notes exist - a description nobody sees is a note nobody reads. Switch it off in **Search** if you would rather every summary sat in the prompt.',
      'This is the answer to "it does not know about our internal libraries". It offers to write one when you explain something durable, and offers to correct one when something contradicts it - a stale skill is worse than a missing one.',
      'You get a writable folder plus any number of read-only ones, such as a shared team folder, with PATH-style precedence and shadowing reported rather than silently applied. Writing a skill needs approval too: it is prose that steers every future turn.',
    ],
  },
  {
    id: 'search',
    title: 'Search - find things by meaning',
    tab: 'search',
    completionEvents: ['onStepSelected'],
    altText:
      'The Search tab, showing the backend choice, connection fields, embedding profile, the index button, the two look-things-up toggles for tools and skills, index copying, and query limits.',
    body: [
      'Indexing is optional, ships disabled, and is **the largest thing Light Code ever sends anywhere**: it uploads the contents of your workspace to the embedding endpoint you name. It says so, and where to, before the first upload.',
      '**Qdrant** and **Chroma** run locally if you would rather nothing left the machine; **OpenSearch** is usually the one your company already has. Embeddings reuse a provider profile, so there is no second set of credentials. You can **copy an index between backends**, so changing your mind later does not orphan what you indexed.',
      '**Looking things up rather than listing them is the default.** MCP and Python tool schemas, and skill summaries, stay out of the prompt; the assistant finds them with `search_docs` and calls them through `call_tool`. Nothing is registered when there is nothing to hide, so a workspace with no MCP servers and no skills pays nothing for it. The tab shows how many things it is hiding, and either half can be switched off - models do call a tool listed in the prompt slightly more reliably than one named through a dispatcher.',
    ],
  },
  {
    id: 'tools',
    title: 'Tools - everything it can call',
    tab: 'tools',
    completionEvents: ['onStepSelected'],
    altText:
      'The Tools tab, showing the search box and the catalogue grouped into built-in, MCP and Python tools, with the looked-up badge explained.',
    body: [
      'One read-only list of every tool available right now: the built-in nine, everything your MCP servers expose, and the Python tools it has written. Search matches descriptions as well as names, so you can look for what you want done rather than what it is called.',
      'A **looked up** badge means the tool is kept out of the system prompt to save space - the default for MCP and Python tools. It is still callable: the assistant searches for it and calls it by name. A shorter prompt is not a shorter tool list; withholding a capability is what Approvals and modes are for.',
    ],
  },
  {
    id: 'expert',
    title: 'Expert - spend less on the hard parts',
    tab: 'expert',
    completionEvents: ['onStepSelected'],
    altText:
      'The Expert tab, showing the enable toggle, command and model, the per-task spend and consultation limits, cost estimate, skill assessment, and the read-only tool restriction.',
    body: [
      'In **Junior mode** a cheap model does the work and consults Claude, through the Claude CLI, on the parts that need it. The expert plans, sets checkpoints, and reviews each one as the junior finishes it.',
      'It is read-only by construction - Read, Grep and Glob, never edit or execute - so a second agent can never act outside the approval gate. It keeps one session per task, which makes the first consultation the expensive one and every later one about nineteen times cheaper.',
      '**Budget per task** caps both spend and number of consultations, and the same control sits in the chat header so you can raise it mid-task. The expert is told what is left and plans to fit, gives you a cost estimate up front, and can assess how your primary model is doing.',
    ],
  },
  {
    id: 'schedules',
    title: 'Schedules - let it run on its own',
    tab: 'schedules',
    completionEvents: ['onStepSelected'],
    altText:
      'The Schedules tab, showing a schedule name, prompt and interval, the file-permission, tool and skill filters for unattended runs, and the run history.',
    body: [
      'A prompt on a timer. Runs in the background without touching the chat you are in, and keeps running with the panel closed.',
      'Nobody is present to approve anything, so an unattended run does not inherit your auto-approve settings. Permission is granted **per schedule**: files are read-only unless you say otherwise, and you pick exactly which tools it may call. Creating Python tools or skills is never available to a schedule at all - model-authored code with no one watching is the one thing that stays out of reach.',
      '**A schedule names the skills it needs** rather than searching for them, under *What it should know*. Its tool list may not include `search_docs`, and a run that comes up empty has nobody to notice. All skills are included until you narrow it.',
      'Every run is logged with its full transcript, and `notify` raises a toast when a run has something to say.',
    ],
  },
  {
    id: 'appearance',
    title: 'Appearance - make it yours',
    tab: 'appearance',
    completionEvents: ['onStepSelected'],
    altText:
      'The Appearance tab, showing the accent colour swatches, the expert colour swatches, and the reduced-motion toggle.',
    body: [
      "The panel follows your editor theme. Two colours are yours to set: the **accent**, used for anything actionable, and the **expert** colour, which marks authorship - text in it is Claude's words rather than your primary model's.",
      'Text on either is computed rather than fixed, so it stays readable whatever you pick. Motion follows your OS reduced-motion setting, and can be turned off here regardless.',
    ],
  },
  {
    id: 'privacy',
    title: 'What it does not do',
    completionEvents: ['onStepSelected'],
    altText:
      'A diagram of what leaves the machine: your gateway and MCP servers, plus the vector store and embedder only if Search is enabled; then the four things Light Code never does, and a warning that nothing is sandboxed.',
    body: [
      'No telemetry. No update checks. No default endpoints - a fresh install contacts nothing. No remote assets in the panel.',
      'The only hosts it ever reaches are the ones you configured: your gateway, your MCP servers, and - only if you turn Search on - your vector store and embedding endpoint.',
      'Two things are stated plainly rather than glossed. **Indexing is the largest egress in the product**: enabling it sends your workspace to the embedder. And **nothing is sandboxed** - commands, Python tools and MCP servers run as you, with your permissions, and Light Code does not protect you from another process running as the same user. Approval is the real boundary, which is why it is per-invocation and why every toggle ships off.',
      'Source, issues and the full security section: [github.com/chosengenerationdev/light-code](https://github.com/chosengenerationdev/light-code)',
    ],
  },
]

export const GUIDE_TITLE = 'Light Code: a guided tour'
export const GUIDE_DESCRIPTION =
  'Every tab, what is in it, and what each setting does - with a button that takes you there.'
