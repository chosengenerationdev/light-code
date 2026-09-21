import { createHash, randomUUID } from 'node:crypto'
import { watch as watchPath, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { listSkillImages, skillImageDataUri, SKILL_IMAGE_DIR } from '../skills/images.js'
import { listSkillFiles } from '../skills/files.js'
import {
  applyImport,
  buildExport,
  defaultSelection,
  describeSections,
  SHARE_SECTIONS,
  type ShareSectionId,
} from '../config/share.js'
import os from 'node:os'
import path from 'node:path'

import { compareMentionCandidates, matchesMentionQuery } from '../context/mentionRanking.js'
import { pruneEvents, summariseSavings, type ExpertEvent } from '../expert/savings.js'
import { OfficeBridge, officeSupported } from '../office/bridge.js'
import { buildTeamGuidance, DEFAULT_TEAM_GUIDANCE } from '../agents/guidance.js'
import { describeDirectedRoles, findDirectedRoles } from '../agents/direct.js'
import { PLAN_LIMIT } from '../agent/plan.js'
import {
  attributeConsultation,
  checkpointViews,
  markCheckpoint,
  progressSummary,
  pruneProgress,
  type CheckpointView,
  type PlanProgress,
} from '../agent/checkpoints.js'
import {
  createPlanProgressTool,
  createUpdatePlanTool,
  type PlanAccess,
} from '../tools/planTools.js'
import {
  createCreateRoleTool,
  createDeleteRoleTool,
  createReadRolePromptTool,
  createUpdateRolePromptTool,
  type RolePromptAccess,
} from '../tools/roleTools.js'
import { buildAgentBriefing } from '../agents/briefing.js'
import { runConsultation, toolsForConsultation } from '../agents/consult.js'
import { toToolDefinitions } from '../tools/registry.js'
import {
  allRoles,
  buildAgentPrompt,
  CUSTOM_ROLE_LIMIT,
  defaultPromptFor,
  isAgentRole,
  isColourableAgent,
  isValidRoleId,
  knownRoles,
  roleInfo,
  type CustomRoleDefinition,
} from '../agents/roles.js'
import { budgetMatters, resolveTeam, type ResolvedAgent } from '../agents/team.js'
import { aliasFields, codebaseAliases, skillAliases } from '../rag/aliases.js'
import {
  deriveIndexName,
  DEFAULT_INDEX_PREFIX as DERIVED_INDEX_PREFIX,
} from '../rag/indexNaming.js'
import { EXPERT_GUIDANCE, SEAT_FITS } from '../agents/seats.js'
import { ASK_CLAUDE_TOOL } from '../tools/askExpert.js'
import type { Tool } from '../tools/types.js'
import {
  createExcelOpenTool,
  createExcelDiagnoseTool,
  createExcelSessionsTool,
  createExcelReadRangeTool,
  createExcelTraceTool,
  createExcelListMacrosTool,
  createExcelReadMacroTool,
  createExcelWriteMacroTool,
  createExcelWriteRangeTool,
  createExcelCreateTool,
  createExcelSaveTool,
  createExcelSheetsTool,
  createOutlookFoldersTool,
  createOutlookSearchTool,
  createOutlookReadTool,
} from '../tools/office.js'
import {
  createExcelCheckMacroTool,
  createExcelEvaluateTool,
  createExcelRunMacroTool,
} from '../tools/officeVba.js'
import { timeoutForTool, timeoutTargetFor } from '../tools/timeouts.js'
import {
  describeOverrides,
  overridesFor,
  OVERRIDABLE_KEYS,
  type WorkspaceOverrides,
} from '../config/workspaceOverrides.js'
import {
  coerceFormValue,
  type AskUserFormParams,
  type FormAnswer,
  type FormField,
  type FormValue,
} from '../tools/askUserForm.js'
import { confineToAny, normalizeForComparison } from '../fs/confine.js'
import { isValidEnvName, pythonEnvEntries, pythonEnvSecretRef } from '../python/env.js'
import {
  approveTool,
  forgetTool,
  hashSource,
  isValidToolName,
  toolFileName,
} from '../python/registry.js'
import { isTranscriptMessage } from './backgroundMessages.js'
import {
  ConfigManager,
  type SecretStore,
  Conversation,
  DiskTruncationStore,
  FetchHttpClient,
  Logger,
  RecordingTruncationStore,
  McpRegistry,
  PathDenylist,
  PolicyApprovalGate,
  riskyCommandRules,
  type RiskyCommandRule,
  ShadowGit,
  ToolRegistry,
  addToAllowlist,
  assertCertDirOutsideWorkspace,
  attachMentions,
  buildSystemPrompt,
  CONTROL_TOOLS,
  chartFromToolCall,
  diagramFromToolCall,
  consultationFromToolCall,
  toolCallSummary,
  createAuthStrategy,
  buildCodeGenerationPrompt,
  createChatProvider,
  mentionExcludes,
  PRICING_PROBE,
  pricingForPrompt,
  type ExpertPricing,
  type CodeGenerator,
  createAskExpertTool,
  createAskAgentTool,
  createRecallExpertTool,
  type ExpertConsultationRecord,
  createSearchOpensearchTool,
  createSearchCodebaseTool,
  createSearchDocsTool,
  SearchLog,
  createCallToolTool,
  createForgetDocsTool,
  PythonManager,
  createWriteSkillTool,
  createDeleteSkillTool,
  createUseSkillFileTool,
  loadSkills,
  renderSkillsForPrompt,
  renderSkillsHintForPrompt,
  renderAlwaysSkills,
  isValidSkillName,
  skillFileName,
  type Skill,
  Embedder,
  indexWorkspace,
  chunkSignatureFor,
  type IndexManifest,
  type IndexProgress,
  resolveConnectionTls,
  resolveS3,
  createS3Tools,
  mirrorFolder,
  removeSkillFromBucket,
  skillKeysInBucket,
  syncFromS3,
  uploadToS3,
  targetById,
  type ResolvedS3,
  vectorStoreTls,
  OpenSearchClient,
  createVectorSearcher,
  createVectorIndexWriter,
  type VectorSearcher,
  type VectorIndexWriter,
  createDefaultToolRegistry,
  detectClaudeCli,
  buildExpertBriefing,
  buildDocCorpus,
  MailStore,
  storeIdFor,
  type MailIndexConfig,
  syncMail,
  refreshMail,
  pruneMail,
  createScheduleFromChatTool,
  createSearchMailTool,
  createMailPatternsTool,
  createOpenEmailTool,
  createMailCoverageTool,
  createMailStatsTool,
  mayPythonToolCall,
  describeNestedCall,
  PYTHON_CALL_DENIED,
  createSearchDataTool,
  createCheckCollectorTool,
  DatasetStore,
  syncDataset,
  clearDataset,
  COLLECTOR_TOOL_GUIDANCE,
  type DatasetConfig,
  type HarvestedMessage,
  findTeamSkillsNamed,
  type TeamSkillsOptions,
  indexTeamSkills,
  createSearchTeamSkillsTool,
  parseDocEntryId,
  type DocEntryKind,
  createNotifyTool,
  parseNamespacedToolName,
  type ToolCatalogueEntry,
  syncVectorStores,
  ASSESSMENT_PROBES,
  buildAssessmentQuestion,
  consultExpert,
  allAssessments,
  assessmentFor,
  forgetAssessment,
  recordAssessment,
  type JuniorAssessment,
  type ProbeResult,
  checkExpertBudget,
  describeExpertBudget,
  type ExpertEstimate,
  expertBudgetUsage,
  type ExpertLimits,
  registryForSchedule,
  filterToolsForSchedule,
  skillsForSchedule,
  NEVER_AVAILABLE_TO_SCHEDULES,
  ScheduledApprovalGate,
  scheduledRunGuidance,
  scheduleAppliesHere,
  nextFireTime,
  isDue,
  MAX_REMEMBERED_RUNS,
  type Schedule,
  type ScheduleTrigger,
  createReadToolResultTool,
  deriveTitle,
  AGENT_TEAM_MODE,
  findMode,
  listModels,
  mcpServersSchema,
  venvPythonCandidates,
  VENV_DIR_NAMES,
  type McpServerConfig,
  namespacedToolName,
  parseConfig,
  redactTask,
  removeFromAllowlist,
  resolveActiveProfile,
  resolveMentions,
  resolveModelCapabilities,
  runAgentTurn,
  testConnection,
  toTranscript,
  validateProviderForm,
  type ApprovableGroup,
  type AuthStrategy,
  type AuthStrategyContext,
  type Auth,
  type Checkpoint,
  type ClaudeCliInfo,
  type OpenSearchConnection,
  type VectorStoreConfig,
  type HostToUiMessage,
  type ToolPreview,
  resolveSecretRef,
  describeSecretRef,
  type ProbeTarget,
  type IndexingKind,
  type ImageAttachmentInput,
  type LightCodeConfig,
  dispatcherEnabled,
  skillRetrievalEnabled,
  type NetworkSettingsInput,
  type McpServersConfig,
  type McpToolPermission,
  type ProfileInput,
  type ProfileSummary,
  type SearchConnectionInput,
  type SearchConnectionSummary,
  type ProviderProfile,
  type RunAgentTurnOptions,
  type Task,
  type ToolExecutionContext,
  type UiToHostMessage,
  type WorkspaceApprovals,
} from '../index.js'
import { WebviewApprovalGate } from './approvalGate.js'
import type { HostServices } from './services.js'
import { NodeFileSystem } from '../platform/node/filesystem.js'
import { NodeTerminal } from '../platform/node/terminal.js'
import { JsonTaskStore } from '../platform/node/taskStore.js'

/**
 * Secret keys are namespaced by profile so deleting a profile reliably deletes everything
 * it owns (§15) — orphans otherwise accumulate invisibly in the keychain.
 */
function apiKeyRefFor(profileId: string): string {
  return `profile:${profileId}:apiKey`
}
function clientSecretRefFor(profileId: string): string {
  return `profile:${profileId}:clientSecret`
}
function certPassphraseRefFor(profileId: string): string {
  return `profile:${profileId}:certPassphrase`
}
const SECRET_REFS_PER_PROFILE = [apiKeyRefFor, clientSecretRefFor, certPassphraseRefFor]

/** Cluster credentials, namespaced like a profile's so deleting one removes both (§15). */
function searchUserRefFor(id: string): string {
  return `search:${id}:username`
}
function searchPasswordRefFor(id: string): string {
  return `search:${id}:password`
}

/**
 * `hasApiKey` reflects whether the secret **actually exists in the store**, not merely
 * whether config claims an `apiKeyRef`. Those can diverge (a secret deleted or never
 * written leaves a dangling reference), and reporting the config's claim would show
 * "Set — leave blank to keep" for a key that isn't there — leaving the user no way to
 * fix it from the UI. Still never sends the value itself (invariant 7).
 */
async function toSummary(profile: ProviderProfile, secrets: SecretStore): Promise<ProfileSummary> {
  const summary: ProfileSummary = {
    id: profile.id,
    label: profile.label,
    wireFormat: profile.wireFormat,
    baseUrl: profile.baseUrl,
    model: profile.model,
    authType: profile.auth.type,
    hasApiKey:
      profile.auth.type === 'apiKey' &&
      (await resolveSecretRef(profile.auth.apiKeyRef, { secrets })) !== undefined,
    /*
     * The reference itself, when it names the environment.
     *
     * Sending it is not a secret leak (invariant 7) — a variable *name* is not its value, and the
     * user typed it. It is what lets the panel show "from $API_TOKEN" instead of an empty box that
     * reads as an unconfigured profile.
     */
    ...(profile.auth.type === 'apiKey' && describeSecretRef(profile.auth.apiKeyRef).kind === 'env'
      ? { apiKeyEnvVar: describeSecretRef(profile.auth.apiKeyRef).envVar as string }
      : {}),
    // Not a secret: a command describes how to *get* a credential. The token it produces never
    // crosses the bridge, and a form cannot edit what it is never shown.
    // References only — a store key or a variable name, never the credential (invariant 7).
    ...(profile.auth.type === 'header' ? { authHeaders: profile.auth.headers } : {}),
    ...(profile.auth.type === 'tokenCommand'
      ? {
          /*
           * `env` is dropped on the way out, deliberately.
           *
           * It is the one field here somebody might have put a credential in, and the panel has no
           * business rendering it. Dropping it from the summary rather than from the schema means a
           * hand-written one keeps working; the form simply never sees it, and never sends it back.
           */
          tokenCommand: ((whole) => {
            const { env, ...rest } = whole
            void env
            return rest
          })(profile.auth.tokenCommand),
        }
      : {}),
    hasClientSecret: false,
    hasCertPassphrase: false,
  }
  if (profile.modelCapabilities !== undefined) summary.modelCapabilities = profile.modelCapabilities
  // Not a secret, and the form cannot edit what it is never shown - the same reasoning that
  // seeds the token command rather than starting it blank.
  if (profile.thinking !== undefined) summary.thinking = profile.thinking
  // Not a secret: a path and a boolean. Only the passphrase is withheld (§15).
  if (profile.tls !== undefined) summary.connectionTls = profile.tls

  if (profile.auth.type === 'apigeeMtls') {
    // Every field below is non-secret: URLs, ids, header names, and cert *paths* (§15).
    // `clientSecretRef` and `passphraseRef` are deliberately reduced to booleans.
    const { clientSecretRef, ...apigee } = profile.auth.apigee
    const { passphraseRef, ...certs } = profile.auth.certs
    summary.apigee = apigee
    summary.certs = certs
    summary.hasClientSecret =
      clientSecretRef !== undefined && (await secrets.get(clientSecretRef)) !== undefined
    summary.hasCertPassphrase =
      passphraseRef !== undefined && (await secrets.get(passphraseRef)) !== undefined
  }
  return summary
}

/**
 * Drops empty strings so a cleared form field removes the key instead of persisting `""` —
 * an empty `tokenUrl` must fall back to the derived default, not override it with nothing.
 */
function stripEmpty<T extends object>(source: T): Partial<T> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim().length === 0) continue
    if (value === undefined) continue
    result[key] = typeof value === 'string' ? value.trim() : value
  }
  return result as Partial<T>
}

/**
 * Wires a chat UI to the agent loop and the settings screens.
 *
 * Host-agnostic: everything platform-specific arrives through `HostServices`. The VS Code
 * extension and the Node server both call this, which is the whole point — a fix to the
 * approval gate or the MCP tab reaches both without being written twice.
 */
/** How often the schedule timer looks. A quarter of the shortest interval a schedule can use. */
const SCHEDULE_TICK_MS = 15_000

/**
 * How long a single scheduled run may hold the scheduler before it is presumed wedged.
 *
 * Generous on purpose — a real run doing real work can take many minutes, and cutting one
 * short is worse than being late. This exists only to stop one stuck run from disabling every
 * schedule permanently.
 */
const STUCK_RUN_MS = 30 * 60_000

/**
 * A live bridge. Outlives any one view, so a host can rebuild its UI without rebuilding this.
 */
export interface ChatBridge {
  /** Re-pushes state a freshly created view could not have received. */
  resync: () => void
  /**
   * Whether the schedule timer is still ticking, for an outside watchdog.
   *
   * The timer has now stopped twice for reasons that left no trace, so the host polls this
   * and restarts it rather than trusting it to stay up. A scheduler that silently dies is
   * indistinguishable from one with nothing to do, which is why both failures took so long
   * to see.
   */
  schedulerHealth: () => { running: boolean; lastTickAt?: number; runningScheduleId?: string }
  /** Restarts the timer. Safe at any time; idempotent while it is healthy. */
  restartScheduler: () => void
  dispose: () => void
}

export function wireChatBridge(services: HostServices): ChatBridge {
  const { transport, secrets, ui, workspaceRoot, storageDir } = services
  const logger = new Logger({ level: 'debug', sink: services.logSink })
  // Given the open project, so per-project settings apply to every read without each call site
  // having to remember — one owner, as with every default in this file.
  const configManager = new ConfigManager(services.configStore, services.workspaceRoot)
  /*
   * The proxy environment is honoured here too, not only on the Node host.
   *
   * It was `new FetchHttpClient()` — no proxy support — so the extension ignored `HTTPS_PROXY`
   * entirely. On a corporate network that means anything not reachable directly simply fails, and
   * the failure is a DNS error naming a host the machine was never going to resolve. Reported
   * exactly that way against S3: "the host could not be resolved", from a network where nothing
   * external resolves without the proxy.
   *
   * Safe to turn on rather than a widening: `proxyForUrl` returns nothing for loopback and obeys
   * `NO_PROXY`, so a gateway that should be reached directly still is — provided it is listed
   * there, which is what that variable is for. A gateway reachable without a proxy on a machine
   * with `HTTPS_PROXY` set and no `NO_PROXY` is the one case this changes, and the fix for it is
   * the same variable every other tool on that machine already needs.
   */
  const httpClient = services.httpClient ?? new FetchHttpClient({ useEnvProxy: true })
  const conversation = new Conversation(
    workspaceRoot !== undefined ? buildSystemPrompt(workspaceRoot) : undefined,
  )

  // Wrapped so the current task knows which spilled results it owns — deleting a task has
  // to delete its spilled output, and only this layer sees the handles.
  // Refreshed whenever config is loaded (once per turn). Read synchronously by the spill
  // path, which cannot await a keychain lookup in the middle of writing a tool result.
  let cachedSecretValues: readonly string[] = []
  const truncationStore = new RecordingTruncationStore(
    new DiskTruncationStore(path.join(storageDir, 'tool-results'), () => cachedSecretValues),
  )
  // Constructed here rather than injected: it needs the truncation store built just above,
  // and the JSON-file layout is host-agnostic. Storage *location* is the host's decision;
  // storage *format* is not.
  const taskStore = new JsonTaskStore(storageDir, truncationStore, logger)
  /*
   * Owns uv, the venv and the worker. Constructed unconditionally but inert until config
   * turns it on — §13 requires the feature not to exist until someone enables it, and an
   * inert object is easier to reason about than a conditionally-undefined one.
   */
  const python = new PythonManager({
    workspaceRoot,
    storageDir,
    logger,
    // Read at spawn, never held: a variable the user declared secret has its value fetched when
    // a child is about to start, so rotating it reaches the next worker with nothing to clear.
    secrets,
    /*
     * Publishes a new tool to the bucket folder marked for it.
     *
     * A closure over the cached config rather than a value, because the manager is constructed
     * once for the window and the mirrors can be reconfigured at any time — a value captured here
     * would keep publishing to whatever was set when the panel opened.
     *
     * The same split the skills folders have: any number of folders read from, exactly one written
     * to. Without that, "where did that tool go" has several answers.
     */
    onToolSaved: async (name: string, source: string) => {
      const publishTo = cachedToolMirrors.find(
        (mirror) => mirror.enabled === true && mirror.publish === true,
      )
      if (publishTo === undefined) return
      const target = targetById(cachedS3, publishTo.connectionId)
      if (target === undefined || target.readOnly === true) return
      await uploadToS3({
        target,
        ...(publishTo.prefix !== undefined ? { prefix: publishTo.prefix } : {}),
        relative: `${name}.py`,
        contents: Buffer.from(source, 'utf8'),
      })
    },
    /*
     * Lets one Python tool call another, or an MCP tool.
     *
     * Here rather than in the Python package because this is the only place that can see all
     * three things the decision needs: the registry, the approval gate, and whether there is
     * anybody present to answer a prompt. `callPolicy.ts` holds the rule and the reasoning.
     */
    callTool: async (name, args, caller) => {
      if (!pythonNestedCallsAllowed) {
        throw new Error(
          'This run cannot call other tools from a Python tool: it is unattended, so nobody is ' +
            'here to approve one.',
        )
      }

      const registry = currentToolRegistry()
      const tool = registry.get(name) ?? registry.get(`py__${name}`)
      if (tool === undefined) {
        throw new Error(
          `There is no tool called "${name}". Settings \u2192 Tools lists everything callable; an ` +
            'MCP tool is named with its server, like `filesystem__read_file`.',
        )
      }
      if (!mayPythonToolCall(tool.name, tool.group)) throw new Error(PYTHON_CALL_DENIED)

      /*
       * Approved exactly as the model's own call would be, showing the tool's own preview.
       *
       * Invariant 8 does not stop applying because the caller is a program rather than a model —
       * if anything it matters more, since nobody read the Python source as carefully as they
       * read a diff. The prompt names the asking tool, because "allow filesystem__write_file?"
       * with no indication of who wants it is the prompt people click through.
       */
      const context = pythonNestedContext
      if (context === undefined) {
        throw new Error('No turn is in progress, so there is nothing to run this against.')
      }

      /*
       * Previewed from the tool itself, never from anything the caller said about it.
       *
       * Invariant 8 does not stop applying because the caller is a program: if anything it
       * matters more, since nobody reads a Python file as carefully as they read a diff. A
       * preview that throws degrades to text rather than becoming implicit approval.
       */
      let preview: ToolPreview
      try {
        preview = (await tool.preview?.(args as never, context)) ?? {
          kind: 'text',
          text: `${tool.name}(${JSON.stringify(args, null, 2)})`,
        }
      } catch (error) {
        preview = {
          kind: 'text',
          text:
            `${tool.name}(${JSON.stringify(args, null, 2)})\n\n` +
            `Could not preview this: ${error instanceof Error ? error.message : String(error)}`,
        }
      }

      const decision = await approvalGate.requestApproval({
        id: `py-nested-${String(Date.now())}-${tool.name}`,
        toolName: tool.name,
        group: tool.group,
        preview: {
          ...preview,
          // Says who is asking. "Allow filesystem__write_file?" with no indication of who wants
          // it is exactly the prompt people click through.
          ...(preview.kind === 'text'
            ? { text: `${describeNestedCall(caller, tool.name)}\n\n${preview.text}` }
            : {}),
        },
      })
      if (decision !== 'approve') throw new Error(`The user did not allow "${tool.name}" to run.`)

      const result = await tool.execute(args as never, context)
      if (result.isError === true) throw new Error(String(result.content))
      return result.content
    },
    // Read at worker spawn, so a changed variable applies to the next worker rather than being
    // frozen at construction. Added to the allowlist in minimalPythonEnv, never a way past it.
    ...(services.sessionEnv !== undefined ? { sessionEnv: services.sessionEnv } : {}),
    ...(services.submitForReview !== undefined
      ? {
          submitForReview: (request: {
            name: string
            content: string
            existingContent: string
            producedBy?: string
          }) =>
            services.submitForReview?.({ kind: 'python-tool', ...request }) ?? Promise.resolve(''),
        }
      : {}),
    /*
     * A resolver, not a generator: the tool's *parameters* change shape depending on whether one
     * is configured — specification versus source — so the answer is needed when the tool list is
     * built, not when it is called. Refreshed by `loadSettings`, which runs before every turn, so
     * changing the profile mid-session takes effect on the next message.
     */
    generateSource: () => cachedCodeGenerator,
    // A tool created, updated or deleted during a chat changes both the Python tab and the
    // documentation corpus. `postPython` refreshes the tab and schedules the reindex.
    onToolsChanged: () => {
      void postPython()
      // Same reasoning as MCP: a Python tool created after the panel opened must appear in
      // the schedule picker without the user reloading the window.
      void postSchedules()
      void postTools()
      /*
       * And in the collector picker, for exactly the same reason.
       *
       * This was missed when Custom data was added: `postTools` was pushed on every way the
       * catalogue can change and `postDatasetStatus` was not, so a collector written for a
       * dataset was absent from the list that exists to choose it. Reported as the tool list not
       * updating with what had just been added.
       */
      void postDatasetStatus()
    },
  })

  /**
   * Skills, reloaded per turn.
   *
   * In the workspace beside the tools, for the same reason: a skill is prose the model
   * injects into its own future context, and plain markdown in git is the main thing
   * standing between that and an unreviewed instruction (§13).
   */
  const defaultSkillsDir =
    workspaceRoot !== undefined ? path.join(workspaceRoot, '.lightcode', 'skills') : undefined

  /**
   * Where skills are written, and the ordered list of folders they are read from.
   *
   * Both derive from config, so they are refreshed with everything else once per turn rather
   * than fixed when the bridge is constructed — a folder added in Settings has to take effect
   * without reloading the window.
   */
  let skillsDir = defaultSkillsDir
  let extraSkillDirs: string[] = []
  /** The mirrored bucket folders in the skill search path, one per configured source. */
  let mirroredSkillsDirs: string[] = []
  /** The same for Python tools, reported so the tab can say where each landed. */
  let mirroredToolsDirs: string[] = []
  /** The skills mirrors as configured, so `write_skill` knows where to publish. */
  let cachedSkillMirrors: {
    connectionId: string
    prefix?: string | undefined
    enabled?: boolean | undefined
    publish?: boolean | undefined
  }[] = []
  /** And the same for Python tools, so `create_python_tool` knows where to publish. */
  let cachedToolMirrors: typeof cachedSkillMirrors = []
  /** One line about the last sync of each, for the panel. */
  let lastSync: { skills?: string; tools?: string } = {}

  /** Relative entries resolve against the workspace; absolute ones are taken as given. */
  function resolveSkillDir(entry: string): string | undefined {
    const trimmed = entry.trim()
    if (trimmed.length === 0) return undefined
    if (path.isAbsolute(trimmed)) return path.resolve(trimmed)
    return workspaceRoot === undefined ? undefined : path.resolve(workspaceRoot, trimmed)
  }

  /** The write folder first — it wins name collisions — then the read-only ones in order. */
  function skillSearchPath(): string[] {
    return [skillsDir, ...extraSkillDirs].filter((dir): dir is string => dir !== undefined)
  }

  let skills: Skill[] = []
  /**
   * The tool registry as the last turn built it, for briefing a specialist.
   *
   * A consultation happens inside a turn, but `consultAgent` is declared outside the closure that
   * builds the registry — so it is captured rather than rebuilt. Rebuilding would spawn MCP
   * connections and a Python worker for the sake of a list of names.
   */
  let agentBriefingTools: (() => readonly Tool[]) | undefined
  /**
   * The execution context a specialist's read-only lookups run in.
   *
   * The turn's own context, so confinement, the path deny list and the workspace root are exactly
   * what the assistant gets — rather than a second set of rules that could drift looser. Undefined
   * outside a turn, and then no tools are offered at all.
   */
  let consultationContext: (() => ToolExecutionContext) | undefined
  let skillIssues: { filePath: string; detail: string }[] = []
  const refreshSkills = async (): Promise<void> => {
    const dirs = skillSearchPath()
    if (dirs.length === 0) return
    const loaded = await loadSkills(dirs)
    skills = loaded.skills
    skillIssues = loaded.issues
    for (const issue of loaded.issues) logger.warn(`skill ${issue.filePath}: ${issue.detail}`)
  }

  /*
   * Watches the skill folders, so a file dropped in appears without reopening anything.
   *
   * A skill is a markdown file people create in an editor, in a folder they can see — and the
   * panel only refreshed when it was asked to, so adding one and looking at the tab showed
   * nothing. There was no error to notice, which made it read as the skill being rejected.
   *
   * Watches the *directory*, not the files: a new file is the event that matters, and editors
   * save by replacing rather than writing in place, so a per-file watch would miss both.
   */
  let skillWatchers: FSWatcher[] = []
  let skillWatchTimer: ReturnType<typeof setTimeout> | undefined

  function stopWatchingSkills(): void {
    for (const watcher of skillWatchers) watcher.close()
    skillWatchers = []
    if (skillWatchTimer !== undefined) clearTimeout(skillWatchTimer)
    skillWatchTimer = undefined
  }

  function watchSkillFolders(): void {
    stopWatchingSkills()
    /*
     * The parent is watched as well as the folder itself.
     *
     * `fs.watch` on a path that does not exist throws, so before the first skill is written
     * there is nothing to watch — and the moment that matters most is the *first* one being
     * added. Watching `.lightcode` catches `skills/` coming into existence; watching the folder
     * catches everything after. Duplicates are harmless: the callback is debounced and the
     * reload is idempotent.
     */
    const dirs = skillSearchPath()
    for (const dir of [...dirs, ...dirs.map((entry) => path.dirname(entry))]) {
      try {
        skillWatchers.push(
          // Recursive, because a skill may be a folder with SKILL.md inside — a non-recursive
          // watch sees the folder appear and then never hears about the file written into it.
          watchPath(dir, { recursive: true }, () => {
            /*
             * Debounced. One save produces several events on every platform, and each one would
             * otherwise reload the skills and schedule a documentation reindex.
             */
            if (skillWatchTimer !== undefined) clearTimeout(skillWatchTimer)
            skillWatchTimer = setTimeout(() => {
              void postSkills()
            }, 300)
          }),
        )
      } catch {
        // The folder may not exist yet — a first skill creates it, and `postSkills` re-arms the
        // watch afterwards. Failing to watch must never stop skills being read.
      }
    }
  }

  async function postSkills(): Promise<void> {
    // The folder list lives in config and is refreshed here, not only per turn — otherwise
    // adding a folder in Settings would show no change until the next message.
    await loadSettings()
    await refreshSkills()
    post({
      type: 'skills',
      // `body` is deliberately dropped: only an `always` skill carries one, the tab says which
      // skill it is rather than showing the text, and there is no reason to put a whole standing
      // instruction on the wire twice.
      skills: await Promise.all(
        skills.map(async (skill) => {
          /*
           * Names only. The bytes are fetched when somebody opens one — shipping every picture of
           * every skill so the tab can print a row of file names would be megabytes for something
           * most people never look at.
           */
          const readdir = async (dir: string) => {
            const entries = await fs.readdir(dir, { withFileTypes: true })
            return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
          }
          const images = await listSkillImages(skill.filePath, { readdir })
          // Names only, same rule as the pictures — and here it is not even a choice, since a
          // template is measured in megabytes and nothing in the tab would show its contents.
          const files = await listSkillFiles(skill.filePath, { readdir })
          return {
            name: skill.name,
            description: skill.description,
            filePath: skill.filePath,
            ...(images.length > 0 ? { images } : {}),
            ...(files.length > 0 ? { files } : {}),
            ...(skill.sourceDir !== undefined ? { sourceDir: skill.sourceDir } : {}),
            ...(skill.always === true ? { always: true } : {}),
            // Present only for a skill that came from a bucket; see `bucketFor`.
            ...(() => {
              const bucket = bucketFor(skill.sourceDir)
              return bucket === undefined ? {} : { bucket }
            })(),
          }
        }),
      ),
      issues: skillIssues,
      ...(skillsDir !== undefined ? { skillsDir } : {}),
      extraDirs: extraSkillDirs,
    })
    // Skills are part of the corpus, so a written, deleted or relocated one makes the index
    // stale. Debounced and fingerprinted, so the usual case costs nothing.
    scheduleDocsReindex('skills changed')
    // Re-armed here rather than once at startup: the folder list can change, and the folder
    // itself may not have existed the first time this ran.
    watchSkillFolders()
  }

  /**
   * Opens a skill or Python tool in an editor tab.
   *
   * Confined to the folders those things live in. The path arrives from the UI, which only ever
   * sends one it was given — but "the UI would not do that" is not a boundary, and this opens a
   * file in the user's editor.
   */
  async function handleOpenManagedFile(filePath: string): Promise<void> {
    try {
      if (ui.openFile === undefined) {
        ui.showWarning('This host cannot open files. The path is shown beside each entry.')
        return
      }
      const roots = [
        python.toolsDirectory(),
        ...(skillsDir === undefined ? [] : [skillsDir]),
        ...extraSkillDirs.filter((dir): dir is string => dir !== undefined),
        // Reports a scheduled run wrote. Confined like everything else here: the path arrives
        // from the UI, which only ever sends one it was given, and "the UI would not do that"
        // is not a boundary when the result is opening a file in the user's editor.
        path.join(storageDir, 'reports'),
      ]
      if (roots.length === 0) return
      const real = await confineToAny(path.resolve(filePath), roots)
      await ui.openFile(real)
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Opens the standing-instructions skill, creating it from a template the first time.
   *
   * The `always: true` flag was shipped before anything in the UI could show or set it, which
   * made a feature that costs tokens on every request invisible and hand-edit-only. This is the
   * smallest honest fix: one button that puts the file in the editor the user already has, with
   * the frontmatter already correct, since getting `always: true` wrong silently does nothing.
   */
  async function handleOpenStandingSkill(): Promise<void> {
    if (skillsDir === undefined) {
      ui.showWarning('Open a folder first — skills live in the workspace.')
      return
    }

    const existing = skills.find((skill) => skill.always === true)
    if (existing !== undefined) {
      await handleOpenManagedFile(existing.filePath)
      return
    }

    const target = path.join(skillsDir, 'standing-instructions.md')
    try {
      await fs.mkdir(skillsDir, { recursive: true })
      // Never overwrite: a file already there is the user's, whatever its frontmatter says.
      await fs.writeFile(target, STANDING_SKILL_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    await postSkills()
    await handleOpenManagedFile(target)
  }

  async function handleDeletePythonTool(name: string): Promise<void> {
    try {
      const dir = python.toolsDirectory()
      if (dir.length === 0) return
      if (!isValidToolName(name)) throw new Error(`"${name}" is not a valid tool name.`)
      await fs.rm(path.join(dir, toolFileName(name)), { force: true })
      // The registry entry goes too. Leaving it would re-approve the next file to appear under
      // that name without anyone looking at it.
      await forgetTool(dir, name)
      await python.refresh()
      await postPython()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Re-pins a tool to the file as it stands now.
   *
   * The hash pin refuses a tool whose source changed since approval (§13), which is exactly
   * right when a repository ships a modified `.py` and exactly infuriating when the user edited
   * it themselves. This is the "yes, that was me" path, and it deliberately runs the file
   * through the same validation a model-authored one gets — a tool that does not load must not
   * be pinned, or the pin would start certifying broken code.
   */
  /**
   * Approves one tool, returning what happened rather than telling the user.
   *
   * Split out so the bulk path can report a single outcome for several tools. Approving five
   * tools must not produce five toasts, and it must not stop at the first that will not load —
   * the other four are fine and the user needs to know which one is not.
   */
  async function approveOnePythonTool(name: string): Promise<string | undefined> {
    if (!isValidToolName(name)) return `"${name}" is not a valid tool name.`

    const onDisk = async (candidate: string): Promise<boolean> => {
      try {
        await fs.stat(candidate)
        return true
      } catch {
        return false
      }
    }
    let dir: string | undefined
    let filePath = ''
    for (const candidate of python.toolDirectories()) {
      const attempt = path.join(candidate, toolFileName(name))
      if (await onDisk(attempt)) {
        dir = candidate
        filePath = attempt
        break
      }
    }
    if (dir === undefined) return `no file for "${name}" in any configured tools folder`

    const source = await fs.readFile(filePath, 'utf8')
    const described = await python.describe(name, filePath)
    // A tool that does not load must not be pinned, or the pin starts certifying broken code.
    if (described === undefined) return `"${name}" could not be loaded, so it was not approved`

    await approveTool(dir, name, source, described)
    return undefined
  }

  /** One tool's source, so the chat can show it before anybody approves it. */
  async function handleRequestPythonToolSource(name: string): Promise<void> {
    try {
      if (!isValidToolName(name)) throw new Error(`"${name}" is not a valid tool name.`)
      for (const candidate of python.toolDirectories()) {
        const attempt = path.join(candidate, toolFileName(name))
        try {
          post({ type: 'pythonToolSource', name, source: await fs.readFile(attempt, 'utf8') })
          return
        } catch {
          // Next folder. A tool lives in exactly one of them.
        }
      }
      post({ type: 'pythonToolSource', name, problem: 'The file could not be found.' })
    } catch (error) {
      post({
        type: 'pythonToolSource',
        name,
        problem: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Approves several, after the chat has shown their sources.
   *
   * §13's requirement is that a human sees the source once, not that they press a button per file
   * — so a bulk action is legitimate exactly when the code was on screen, which is what the card
   * enforces by rendering every source before this can be reached.
   */
  async function handleApprovePythonTools(names: readonly string[]): Promise<void> {
    try {
      const problems: string[] = []
      let approved = 0
      for (const name of names) {
        const problem = await approveOnePythonTool(name)
        if (problem === undefined) approved += 1
        else problems.push(problem)
      }

      await python.refresh()
      await postPython()

      const summary = `${String(approved)} tool(s) approved.`
      if (problems.length === 0) ui.showInfo(summary)
      else ui.showWarning(`${summary} ${problems.join('; ')}.`)
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Records a "no" against the bytes a tool has right now.
   *
   * **Deletes nothing.** A decline is a judgement made in a second and people make them by
   * mistake, so the file stays where it is and this entry is what hides it — which makes
   * `restorePythonTool` free, with nothing to fetch again. Pinned to the hash, so a version the
   * team publishes later comes back for review on its own: the earlier "no" was about code that
   * is no longer what is on offer.
   */
  async function handleDeclinePythonTools(names: readonly string[]): Promise<void> {
    try {
      const { config } = await configManager.load()
      const declined = { ...(config.python?.declinedTools ?? {}) }

      let recorded = 0
      for (const name of names) {
        if (!isValidToolName(name)) continue
        for (const candidate of python.toolDirectories()) {
          try {
            const source = await fs.readFile(path.join(candidate, toolFileName(name)), 'utf8')
            declined[name] = hashSource(source)
            recorded += 1
            break
          } catch {
            // Next folder.
          }
        }
      }

      await configManager.save('user', {
        ...config,
        python: { ...(config.python ?? {}), declinedTools: declined },
      })
      await python.configure({
        ...((await configManager.load()).config.python ?? {}),
        extraToolDirs: mirroredToolsDirs,
      })
      await python.refresh()
      await postPython()
      ui.showInfo(
        `${String(recorded)} tool(s) declined. They are still on disk — restore one in Settings → Python.`,
      )
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Undoes a decline. The file never went anywhere, so this only removes the entry that hid it. */
  async function handleRestorePythonTool(name: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const declined = { ...(config.python?.declinedTools ?? {}) }
      delete declined[name]

      await configManager.save('user', {
        ...config,
        python: { ...(config.python ?? {}), declinedTools: declined },
      })
      await python.configure({
        ...((await configManager.load()).config.python ?? {}),
        extraToolDirs: mirroredToolsDirs,
      })
      await python.refresh()
      await postPython()
      ui.showInfo(`"${name}" is back, waiting to be approved.`)
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleApprovePythonTool(name: string): Promise<void> {
    try {
      if (!isValidToolName(name)) throw new Error(`"${name}" is not a valid tool name.`)

      /*
       * Searched across every folder, not just the writable one.
       *
       * A tool mirrored from a bucket arrives with no registry entry, so it is listed as
       * unapproved and this is the button that fixes it — approving into `toolsDir` instead would
       * write an entry in a folder that does not hold the file, and the tool would stay
       * unapproved with a registry claiming otherwise. Each folder keeps its own `.registry.json`,
       * which is what makes approvals per-machine and a synced change refuse itself.
       */
      const onDisk = async (candidate: string): Promise<boolean> => {
        try {
          await fs.stat(candidate)
          return true
        } catch {
          return false
        }
      }
      let dir: string | undefined
      let filePath = ''
      for (const candidate of python.toolDirectories()) {
        const attempt = path.join(candidate, toolFileName(name))
        if (await onDisk(attempt)) {
          dir = candidate
          filePath = attempt
          break
        }
      }
      if (dir === undefined) {
        throw new Error(`No file for "${name}" was found in any configured tools folder.`)
      }

      const source = await fs.readFile(filePath, 'utf8')
      const described = await python.describe(name, filePath)
      if (described === undefined) {
        throw new Error(
          `"${name}" could not be loaded, so it was not approved. Fix the file and try again.`,
        )
      }

      await approveTool(dir, name, source, described)
      await python.refresh()
      await postPython()
      ui.showInfo(`py__${name} approved as it stands now.`)
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The bucket mirror a skill folder belongs to, when it is one.
   *
   * Matched on the folder rather than carried around with the skill, because `mirrorFolder` is
   * deterministic — the same connection and prefix always give the same path — so the mapping is
   * a computation rather than a second piece of state that could disagree with the search path.
   */
  function mirrorForDir(sourceDir: string | undefined): {
    mirror: (typeof cachedSkillMirrors)[number]
    localDir: string
  } | undefined {
    if (sourceDir === undefined) return undefined
    const wanted = path.resolve(sourceDir).toLowerCase()
    for (const mirror of cachedSkillMirrors) {
      if (mirror.enabled !== true) continue
      const localDir = mirrorFolder({
        storageDir,
        connectionId: mirror.connectionId,
        kind: 'skills',
        ...(mirror.prefix !== undefined ? { prefix: mirror.prefix } : {}),
      })
      // Case-folded, per §16: Windows hands the same folder back spelled two ways.
      if (path.resolve(localDir).toLowerCase() === wanted) return { mirror, localDir }
    }
    return undefined
  }

  /** How the tab describes a skill's bucket, or undefined when it did not come from one. */
  function bucketFor(
    sourceDir: string | undefined,
  ): { label: string; canDelete: boolean; reason?: string } | undefined {
    const found = mirrorForDir(sourceDir)
    if (found === undefined) return undefined
    const target = targetById(cachedS3, found.mirror.connectionId)
    if (target === undefined) {
      // Named rather than omitted: a skill that is plainly from a bucket, with no way to act on
      // it and nothing saying why, reads as the feature being broken.
      return { label: found.mirror.connectionId, canDelete: false, reason: 'its connection is unusable' }
    }
    if (target.readOnly === true) {
      return { label: target.label, canDelete: false, reason: 'the connection is read-only' }
    }
    return { label: target.label, canDelete: true }
  }

  /**
   * What deleting a bucket skill would remove. Lists; changes nothing.
   *
   * The literal keys, because this is the one destructive act in `s3/` and a count would be a
   * description of what is about to happen rather than the thing itself (invariant 8).
   */
  async function handlePreviewBucketSkillDelete(name: string, sourceDir: string): Promise<void> {
    const fail = (error: string): void => {
      post({ type: 'bucketSkillDeletePlan', name, sourceDir, label: '', keys: [], error })
    }
    try {
      const found = mirrorForDir(sourceDir)
      if (found === undefined) {
        fail('That skill did not come from a bucket, so there is nothing to delete there.')
        return
      }
      const target = targetById(cachedS3, found.mirror.connectionId)
      if (target === undefined) {
        fail(`The connection "${found.mirror.connectionId}" is unusable — check its key in Settings.`)
        return
      }
      if (target.readOnly === true) {
        fail(`${target.label} is configured read-only, so nothing can be deleted from it.`)
        return
      }

      const keys = await skillKeysInBucket({
        target,
        ...(found.mirror.prefix !== undefined ? { prefix: found.mirror.prefix } : {}),
        name,
      })
      post({ type: 'bucketSkillDeletePlan', name, sourceDir, label: target.label, keys })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Removes a skill from its bucket, and then the local mirrored copy.
   *
   * **In that order, and the local half is not optional.** The sync never deletes (see
   * `s3/sync.ts`, which explains why), so a skill removed from the bucket and left on disk would
   * keep loading, keep being indexed, and keep appearing in the tab for ever — with the bucket
   * saying it is gone. That is the worst of both: the colleague's copy vanishes and yours does not.
   *
   * The local removal is best-effort and reported rather than thrown. The authoritative copy is
   * already gone by then, and failing the whole operation over a locked file would say the delete
   * did not happen when it did.
   */
  async function handleDeleteSkillFromBucket(
    name: string,
    sourceDir: string,
    keys: string[],
  ): Promise<void> {
    try {
      const found = mirrorForDir(sourceDir)
      if (found === undefined) {
        throw new Error('That skill did not come from a bucket, so there is nothing to delete there.')
      }
      const target = targetById(cachedS3, found.mirror.connectionId)
      if (target === undefined) {
        throw new Error(`The connection "${found.mirror.connectionId}" is unusable — check its key in Settings.`)
      }

      const result = await removeSkillFromBucket({
        target,
        ...(found.mirror.prefix !== undefined ? { prefix: found.mirror.prefix } : {}),
        name,
        keys,
      })

      // Both layouts, because either could be what was there. `force` so the one that was not
      // present is not an error.
      let localProblem: string | undefined
      try {
        await fs.rm(path.join(found.localDir, `${name}.md`), { force: true })
        await fs.rm(path.join(found.localDir, name), { recursive: true, force: true })
      } catch (error) {
        localProblem = error instanceof Error ? error.message : String(error)
      }

      await postSkills()

      const parts = [`Removed ${String(result.removed.length)} object(s) from ${target.label}.`]
      if (result.failed.length > 0) {
        parts.push(
          `${String(result.failed.length)} could not be removed: ${result.failed
            .map((failure: { key: string; problem: string }) => `${failure.key} (${failure.problem})`)
            .join('; ')}`,
        )
      }
      /*
       * Reported rather than swallowed. A key refused here means the request did not match what
       * the preview computed — stale, or malformed — and silently deleting fewer objects than the
       * user agreed to would leave them believing the skill was gone.
       */
      if (result.rejected.length > 0) {
        parts.push(`${String(result.rejected.length)} were not this skill's and were left alone.`)
      }
      if (localProblem !== undefined) {
        parts.push(`The bucket copy is gone, but the local copy could not be removed: ${localProblem}`)
      }

      if (result.failed.length > 0 || localProblem !== undefined) ui.showWarning(parts.join(' '))
      else ui.showInfo(parts.join(' '))
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeleteSkillFile(name: string): Promise<void> {
    try {
      if (skillsDir === undefined) return
      // Same name rule the tool uses, so a hand-typed name cannot escape the directory.
      if (!isValidSkillName(name)) throw new Error(`"${name}" is not a valid skill name.`)

      /*
       * Only the write folder can be deleted from. The extras are shared or reference
       * material, and one person's assistant must not be able to remove a file everyone
       * else depends on.
       *
       * Said explicitly rather than left to `force: true`, which would report success while
       * deleting nothing — the skill would still be listed afterwards and the user would have
       * no idea why.
       */
      const existing = skills.find((skill) => skill.name === name)
      if (
        existing !== undefined &&
        existing.sourceDir !== undefined &&
        existing.sourceDir !== skillsDir
      ) {
        throw new Error(
          `"${name}" lives in ${existing.sourceDir}, which is a read-only skills folder. Delete the file there, or remove the folder in Settings.`,
        )
      }

      await fs.rm(path.join(skillsDir, skillFileName(name)), { force: true })
      await postSkills()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const builtinTools = createDefaultToolRegistry()
  builtinTools.register(createReadToolResultTool(truncationStore))

  // Files read via read_file this session; write_to_file/apply_diff check this before
  // touching an existing file. Session-scoped, so it lives alongside the conversation.
  const readFiles = new Set<string>()
  const denylist = new PathDenylist()
  /** Certificates are re-read every request; without this the same warning would repeat. */
  const warnedExpiries = new Set<string>()

  /**
   * The Claude CLI expert, detected once per configured path. Spawning `claude --version`
   * on every turn would be wasteful, and the answer only changes when the user installs it
   * or edits the path.
   */
  let expertCli: ClaudeCliInfo | undefined
  let expertCliPath: string | undefined

  /**
   * Detects the Claude CLI once per configured path, and tells the Agents tab when it has.
   *
   * **One owner**, because there were two and they disagreed about when to run. The old one only
   * probed when `expert.enabled` was true — correct while the expert *was* the feature, and wrong
   * the moment Agents offered Claude as one choice among several: somebody who had never switched
   * the old feature on was told Claude was absent on a machine where it is installed. That is
   * exactly how it was reported.
   *
   * Probing is still not something that happens at startup. It happens when something asks — a
   * turn that needs the expert, or the Agents tab being opened — which is the same "panel open is
   * a signal of intent" rule §11 applies to MCP. `claude --version` is a local process that costs
   * nothing and spends nothing.
   */
  async function detectCli(configured: string): Promise<ClaudeCliInfo> {
    if (expertCli !== undefined && expertCliPath === configured) return expertCli
    expertCliPath = configured
    expertCli = await detectClaudeCli(configured)
    if (!expertCli.available) logger.warn('expert unavailable', expertCli.reason ?? '')
    /*
     * Pushed because detection is asynchronous and the panel asked before it finished.
     *
     * The Agents tab requests its state when it mounts, which is before any process has been
     * spawned and answered, so its first answer always says Claude is absent. Without this
     * nothing ever corrects it.
     */
    void postAgents()
    return expertCli
  }

  async function resolveExpert(config: LightCodeConfig): Promise<ClaudeCliInfo | undefined> {
    // Nothing is spawned for a *turn* unless the user turned it on (§13's opt-in posture). The
    // Agents tab probes on its own account, because being opened is the request.
    if (config.expert?.enabled !== true) return undefined
    const detected = await detectCli(config.expert.path ?? 'claude')
    return detected.available ? detected : undefined
  }

  /**
   * Messages typed while a turn is running. Held host-side rather than in the webview
   * because the loop consumes them mid-turn, and the webview can be destroyed and rebuilt
   * at any moment (it is whenever the view is hidden).
   */
  /**
   * Typed while a turn was running, waiting to be folded in.
   *
   * Entries rather than strings. It held only text, so a screenshot pasted into a message sent
   * mid-turn was dropped on the way in — the words arrived and the picture they were about did
   * not, which from the outside reads as the model ignoring what it was shown.
   */
  let queuedMessages: { text: string; images?: ImageAttachmentInput[] }[] = []

  function postQueued(): void {
    post({
      type: 'queued',
      // A count, not the attachments: the composer only needs to say one is there, and sending
      // the bytes back for something already on screen would be waste.
      messages: queuedMessages.map((entry) => ({
        text: entry.text,
        ...(entry.images !== undefined && entry.images.length > 0
          ? { images: entry.images.length }
          : {}),
      })),
    })
  }

  let activeAbortController: AbortController | undefined
  /** The task's rollback point — the snapshot taken before its first edit. */
  let taskCheckpoint: Checkpoint | undefined

  /**
   * The task being worked on. Created lazily on the first user message, so merely opening
   * the panel never leaves an empty task in the history list.
   *
   * Remembered in `workspaceState` rather than in memory, so reloading the window or
   * restarting VS Code reopens the conversation that was in progress rather than the most
   * recent one — those differ the moment the user reopens an older task.
   */
  const ACTIVE_TASK_KEY = 'lightCode.activeTaskId'
  let activeTaskId: string | undefined = services.workspaceState.get(ACTIVE_TASK_KEY)
  /**
   * The plan the user set for the open chat.
   *
   * Held here and saved with the task, so reopening a conversation from history reopens what it
   * was for. A restored chat whose assistant had forgotten the plan would be worse than no plan:
   * the user would believe it was still bound by something it had never been told.
   */
  let activePlan: string | undefined
  /**
   * How far through the plan this chat is, keyed by checkpoint id.
   *
   * Beside the plan rather than derived from the transcript: "step 3 is done" is something the
   * assistant reports, and nothing in the message history states it in a form that could be read
   * back reliably. What is *not* stored here is the steps themselves — those are parsed from the
   * plan text on demand, so there is only ever one plan.
   */
  let activePlanProgress: PlanProgress = {}
  let activeTaskCreatedAt = Date.now()

  /** The plan's steps with their progress, as the panel and the protocol want them. */
  function planViews(): CheckpointView[] {
    return checkpointViews(activePlan, activePlanProgress)
  }

  function postPlanProgress(): void {
    post({ type: 'planProgress', checkpoints: planViews() })
  }

  /**
   * Replaces the plan, from either side: the user's editor or an approved `update_plan`.
   *
   * One function because the two must behave identically — progress pruned to the steps that
   * still exist, the task saved at once, and both the plan and the progress reposted. Written
   * twice, one of them would eventually forget the pruning and the panel would report a step
   * that is no longer in the plan as done.
   */
  async function applyPlan(next: string | undefined): Promise<void> {
    const trimmed = next?.slice(0, PLAN_LIMIT).trim()
    activePlan = trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
    activePlanProgress = pruneProgress(activePlan, activePlanProgress)
    /*
     * Saved immediately rather than at the end of the next turn.
     *
     * Somebody who sets a plan and then closes the window has still set a plan, and a plan that
     * survives only if you happen to send a message is one people would stop trusting after the
     * first time it vanished.
     */
    await persistActiveTask()
    post({ type: 'plan', plan: activePlan ?? '' })
    postPlanProgress()
  }

  /**
   * What the role-prompt tools are given.
   *
   * Writes through `saveAgents`, the same function the Agents tab uses, so a prompt changed from
   * the chat and one changed in Settings cannot end up doing different things — the reload and
   * the repost of the panel come with it for free. One owner, as everywhere else here.
   */
  const rolePromptAccess: RolePromptAccess = {
    list: () =>
      knownRoles(cachedAgentDefinitions).map((role) => ({
        role,
        name: roleInfo(role, cachedAgentDefinitions).name,
        assigned: cachedTeam.some((agent) => agent.role === role),
        edited: cachedAgentRoles?.[role]?.prompt !== undefined,
      })),
    current: (role) => {
      if (!isAgentRole(role, cachedAgentDefinitions)) return undefined
      return cachedAgentRoles?.[role]?.prompt ?? defaultPromptFor(role, cachedAgentDefinitions)
    },
    fallback: (role) =>
      isAgentRole(role, cachedAgentDefinitions)
        ? defaultPromptFor(role, cachedAgentDefinitions)
        : undefined,
    details: (role) => {
      if (!isAgentRole(role, cachedAgentDefinitions)) return undefined
      const info = roleInfo(role, cachedAgentDefinitions)
      return {
        id: role,
        name: info.name,
        summary: info.summary,
        prompt: cachedAgentRoles?.[role]?.prompt ?? info.prompt,
        // What a reset restores. `info.prompt` is the definition's for a custom role and the
        // shipped text for a built-in one, in both cases ignoring any edit on top.
        originalPrompt: info.prompt,
        usesTools: cachedAgentRoles?.[role]?.tools ?? info.usesTools,
        custom: cachedAgentDefinitions.some((definition) => definition.id === role),
      }
    },
    remove: async (role) => {
      await handleDeleteCustomRole(role)
    },
    create: async (role) => {
      // Through the same handler the tab uses, so the id rules, the cap and the error wording are
      // written once. A second validation path is a second set of rules to drift apart.
      await handleSaveCustomRole(role)
    },
    capacity: () => ({ used: cachedAgentDefinitions.length, limit: CUSTOM_ROLE_LIMIT }),
    save: async (role, prompt) => {
      await saveAgents((current) => {
        const roles = { ...(current.roles ?? {}) }
        const existing = roles[role] ?? { kind: 'profile' as const }
        if (prompt === undefined) {
          // Cleared rather than stored empty, so "reset to default" and "the user wrote nothing"
          // cannot both exist and mean different things to different readers.
          const rest = { ...existing }
          delete rest.prompt
          roles[role] = rest
        } else {
          roles[role] = { ...existing, prompt }
        }
        return { ...current, roles }
      })
    },
  }

  /**
   * What `update_plan` and `plan_progress` are given.
   *
   * The tools hold no state of their own: they are a door onto this closure, the same shape
   * `ask_agent` already uses. A tool that kept its own copy of the plan would be a second answer
   * to "what is the plan", and the first thing to disagree with the system prompt.
   */
  const planAccess: PlanAccess = {
    current: () => activePlan,
    save: async (nextPlan) => {
      await applyPlan(nextPlan)
    },
    mark: async (index, status) => {
      const updated = markCheckpoint(activePlan, activePlanProgress, index, status)
      if (updated === undefined) {
        const total = planViews().length
        return {
          ok: false,
          reason:
            total === 0
              ? 'There is no plan set for this conversation, so there is nothing to report against.'
              : `There is no step ${String(index)}. The plan has ${String(total)} steps, numbered 1 to ${String(total)}.`,
        }
      }
      activePlanProgress = updated
      await persistActiveTask()
      postPlanProgress()
      const views = planViews()
      return {
        ok: true,
        summary: `Step ${String(index)} is now ${status}. ${progressSummary(views)} steps complete.`,
      }
    },
  }

  async function setActiveTaskId(id: string | undefined): Promise<void> {
    activeTaskId = id
    await services.workspaceState.set(ACTIVE_TASK_KEY, id)
  }

  function post(message: HostToUiMessage): void {
    // Only conversation traffic is withheld — see `backgroundMessages.ts` for why this is a
    // deny list rather than the allow list it started as.
    if (backgroundRun && isTranscriptMessage(message.type)) return
    transport.post(message)
  }

  /** True while a scheduled run is using the conversation, so the UI is not written to. */
  let backgroundRun = false

  /**
   * True while the *user's* turn is in flight.
   *
   * Distinct from `activeAbortController`, which a scheduled turn also sets. A schedule must
   * not start on top of someone who is mid-conversation, and this is the only thing that can
   * tell the two apart.
   */
  let userTurnRunning = false

  /** Set while a scheduled run is in flight, so a user message can wait for it rather than interleave. */
  let scheduledRunInFlight: Promise<void> | undefined
  /*
   * What a nested call from a Python tool needs, captured when a turn starts.
   *
   * The manager is built once, at bridge construction, but a nested call has to run against the
   * *current* turn's context — its abort signal, its read set, its session variables. Holding
   * them here is what lets one long-lived callback serve every turn without the manager knowing
   * anything about turns.
   */
  let pythonNestedContext: ToolExecutionContext | undefined
  /** False during an unattended run: nobody is there to approve a nested call. */
  let pythonNestedCallsAllowed = false

  /**
   * Approvals are keyed by workspace path but stored user-side (invariant 5) — a repo
   * must not be able to grant itself permissions via `.lightcode/config.json`.
   */
  /*
   * Scanned wide, shown narrow. The fetch limit is high enough that ranking has something to
   * choose from in a large repository, and bounded because this runs on every keystroke.
   */
  const MENTION_SCAN_LIMIT = 2000
  const MENTION_RESULT_LIMIT = 30

  /**
   * What the *currently running* schedule may call, or undefined in a chat.
   *
   * The tool registry — and the one `search_docs` inside it — is built before the run knows it
   * is a scheduled one, so this is read per call rather than captured. Set as a scheduled run
   * starts and cleared in its `finally`, alongside the conversation and task state the run
   * already snapshots and restores.
   */
  let scheduleToolAccess: ((toolName: string) => boolean) | undefined

  const approvalsKey = workspaceRoot ?? '__no_workspace__'

  /**
   * Finds this workspace's approvals however its path happens to be spelled.
   *
   * Approvals are stored under the workspace path, and on Windows the same folder legitimately
   * arrives as `d:\project` or `D:\project` depending on how the window was opened — with or
   * without a trailing separator, too. A JSON object key is an exact string, so the same
   * workspace could look like a different one between sessions and every "always allow" the
   * user had granted would silently stop applying. §16 is explicit that path comparison on
   * Windows must be case-insensitive; this is that rule reaching the one place that stored a
   * path as a key rather than comparing it.
   *
   * Reading tolerantly rather than rewriting the file: a rename on load would be a write on
   * every start, and two windows open on the same workspace would race to do it.
   */
  function comparableApprovalsKey(key: string): string {
    // `path.resolve` also drops a trailing separator, which is the other way one workspace
    // ends up with two spellings. The placeholder is left alone: resolving it would make the
    // key depend on the process's working directory, which is not stable between sessions.
    return key === '__no_workspace__' ? key : normalizeForComparison(path.resolve(key))
  }

  function approvalsFrom(
    stored: Record<string, WorkspaceApprovals> | undefined,
  ): WorkspaceApprovals {
    if (stored === undefined) return {}
    const exact = stored[approvalsKey]
    if (exact !== undefined) return exact
    const wanted = comparableApprovalsKey(approvalsKey)
    for (const [key, value] of Object.entries(stored)) {
      if (comparableApprovalsKey(key) === wanted) return value
    }
    return {}
  }
  // Cached so the policy gate can answer synchronously mid-turn without re-reading config.
  let cachedApprovals: WorkspaceApprovals = {}
  /** The risky-command rules in force: the user's, plus the built-in list unless switched off. */
  let cachedRiskyCommands: readonly RiskyCommandRule[] = riskyCommandRules()
  /** Mirrors config so the loop and the settings message agree without re-reading. */
  let cachedMaxIterations = 25
  // Mirrors packages/ui's DEFAULT_ACCENT. Duplicated rather than imported because core
  // must not depend on the UI package; the UI is authoritative and this is only the value
  // sent before the user has chosen one.
  let cachedAccentColor = '#22C55E'
  /** Undefined until the user chooses; the browser then follows its own setting. */
  let cachedTheme: 'system' | 'light' | 'dark' | undefined
  /**
   * The global tool timeout in seconds, when one is set.
   *
   * The fallback for every kind of tool: a per-tool limit wins, then a per-server one, then this.
   * It exists because "everything here is slow" is a property of the environment — a machine on a
   * slow network, a workbook on a share — rather than of any one tool, and there was nowhere to
   * say it once.
   */
  let cachedToolTimeoutSeconds: number | undefined
  /** Per-tool limits from `tools.timeouts`, keyed by the name the model calls. */
  let cachedToolTimeouts: Record<string, number> | undefined

  /** Whether a tool's limit is its own, rather than inherited from a server or the global one. */
  function ownTimeout(name: string): boolean {
    const target = timeoutTargetFor(name, mcpConfigs)
    return target.kind === 'mcp'
      ? mcpConfigs[target.server]?.toolTimeouts?.[target.tool] !== undefined
      : cachedToolTimeouts?.[target.name] !== undefined
  }

  /** One resolution, used by the loop and reported to the Tools tab, so they cannot disagree. */
  function toolTimeout(name: string): number | undefined {
    return timeoutForTool(name, {
      perTool: cachedToolTimeouts,
      global: cachedToolTimeoutSeconds,
      mcpServers: mcpConfigs,
    })
  }
  let cachedExpertColor = '#D97757'
  let cachedExpertLimits: ExpertLimits = {}
  /** The stored assessment, so the briefing can carry it without a config read per turn. */
  let cachedAssessment: JuniorAssessment | undefined
  /**
   * A ceiling for this chat only, overriding the configured default.
   *
   * Cleared with the task, like the spend it governs. One hard task deserving a bigger budget
   * is a real need; a raised ceiling that silently outlives it is a limit nobody set.
   */
  /**
   * Everything the expert has said in this task, kept so it can be re-read for nothing.
   *
   * Task-scoped like the session and the spend: advice about one piece of work is not advice
   * about the next, and offering it there would be worse than not having it.
   */
  /**
   * The Excel/Outlook helper, built on first use and never before.
   *
   * Constructing it spawns PowerShell, which is exactly the sort of thing section 11 says must
   * not happen because a panel opened. Enabling the feature registers the tools; calling one is
   * what starts the process.
   */
  let officeBridge: OfficeBridge | undefined
  function office(): OfficeBridge {
    officeBridge ??= new OfficeBridge({
      storageDir,
      logger,
      // Read per request, so raising the limit applies to the next call rather than after a
      // restart — which matters most when someone is raising it *because* a call just timed out.
      timeoutMs: () =>
        cachedToolTimeoutSeconds === undefined ? undefined : cachedToolTimeoutSeconds * 1000,
    })
    return officeBridge
  }

  let expertAdvice: ExpertConsultationRecord[] = []
  let taskExpertLimits: ExpertLimits | undefined
  /** The expert's estimate for this task, cleared with it. */
  let taskExpertEstimate: ExpertEstimate | undefined
  /** Non-empty while the junior is being assessed, for the progress line in the tab. */
  let assessmentStep: string | undefined

  function effectiveExpertLimits(): ExpertLimits {
    return taskExpertLimits ?? cachedExpertLimits
  }
  /**
   * Directories tools may read outside the workspace — a network share of logs, typically.
   *
   * Refreshed per turn with everything else, so adding one in Settings takes effect on the
   * next message rather than needing a reload.
   */
  let cachedReadRoots: string[] = []

  /**
   * Paths approved for this session only.
   *
   * "Allow once" means once per session, not once per call. A model reading the same log twice
   * would otherwise prompt twice, and a user clicking through repeats stops reading them —
   * which is how an approval prompt becomes a rubber stamp.
   */
  const sessionPathGrants = new Set<string>()

  /**
   * Asks whether a path outside every allowed root may be read.
   *
   * Goes through the same gate as a tool approval, so the prompt, the denial path and "always
   * allow" all behave as they do everywhere else. The preview shows the **resolved** path,
   * which is the ground truth invariant 8 asks for — the model's argument may be relative, or
   * a symlink pointing somewhere else entirely.
   */
  async function requestPathAccess(realPath: string): Promise<boolean> {
    const key = normalizeForComparison(realPath)
    if (sessionPathGrants.has(key)) return true

    const id = `path-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    pendingPathApprovals.set(id, realPath)
    try {
      const decision = await userGate.requestApproval({
        id,
        // Named as what it is rather than as a tool: the user is granting access to a place,
        // and calling it `read_file` would make "always allow" read as something much wider.
        toolName: 'read a file outside the workspace',
        group: 'read',
        alwaysScope: 'folder',
        preview: {
          kind: 'text',
          text: [
            'The assistant wants to read a file outside this workspace:',
            '',
            realPath,
            '',
            'Allow reads only — it cannot write here whatever you choose.',
          ].join('\n'),
        },
      })
      if (decision !== 'approve') return false
      sessionPathGrants.add(key)
      return true
    } finally {
      pendingPathApprovals.delete(id)
    }
  }

  /** Which approval ids are path requests, so "always allow" knows to remember a folder. */
  const pendingPathApprovals = new Map<string, string>()

  /**
   * Forms the assistant is waiting on, by request id.
   *
   * Parked exactly as an approval is, and for the same reason: the turn genuinely cannot
   * continue until a person answers. Every path out of a turn settles these — a dismissal, a
   * cancelled turn, a disposed bridge — because a promise nobody will ever resolve is a turn
   * that hangs with no error and nothing to click.
   */
  const pendingForms = new Map<string, (answer: FormAnswer) => void>()
  /** The fields each pending form asked for, so the reply is coerced against them. */
  const pendingFormFields = new Map<string, readonly FormField[]>()

  function settleAllForms(): void {
    for (const resolve of pendingForms.values()) resolve({ submitted: false, values: {} })
    pendingForms.clear()
    pendingFormFields.clear()
  }

  async function requestForm(request: AskUserFormParams): Promise<FormAnswer> {
    const id = `form-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    const answer = new Promise<FormAnswer>((resolve) => {
      pendingForms.set(id, resolve)
    })
    pendingFormFields.set(id, request.fields)
    post({
      type: 'formRequest',
      id,
      title: request.title,
      ...(request.description !== undefined ? { description: request.description } : {}),
      fields: request.fields,
    })
    try {
      return await answer
    } finally {
      pendingForms.delete(id)
      pendingFormFields.delete(id)
    }
  }

  /**
   * Turns a submitted form into typed values, refusing anything that does not fit its field.
   *
   * The form validates too, and that is for the user — but what reaches the model has to be
   * right regardless of what arrived over the bridge. An unanswered required field or a number
   * box holding letters comes back as a dismissal with the reason, not as a plausible value.
   */
  function answerFromResponse(
    fields: readonly FormField[],
    values: Record<string, string | boolean | string[]>,
  ): FormAnswer {
    const coerced: Record<string, FormValue> = {}
    for (const field of fields) {
      const result = coerceFormValue(field, values[field.name])
      if ('error' in result) {
        logger.warn(`form field rejected: ${result.error}`)
        return { submitted: false, values: {} }
      }
      coerced[field.name] = result.value
    }
    return { submitted: true, values: coerced }
  }

  /**
   * What the expert has cost since this task was opened.
   *
   * Scoped to the task rather than persisted, and the UI says so. Reconstructing a resumed
   * task's historical spend would mean parsing dollar figures back out of stored result text
   * — brittle, and wrong the moment that wording changes. A number that is *definitely* "this
   * session, this task" beats one that is quietly incomplete.
   *
   * `consultations` counts every attempt including failures; `usd` totals only the ones the
   * CLI priced, so `unpriced` records the gap rather than letting the total imply it is
   * complete when it is not.
   */
  /**
   * Every search the model ran this session.
   *
   * In memory and bounded. Retrieval is the one part of the product whose failures are quiet
   * — a search that returns confident neighbours for a query it misunderstood looks exactly
   * like one that worked — so the queries have to be visible somewhere to be judged at all.
   */
  const searchLog = new SearchLog(50, () =>
    post({ type: 'searchLog', entries: [...searchLog.list()] }),
  )

  let expertSpend = { usd: 0, consultations: 0, unpriced: 0, keepAlives: 0 }

  /**
   * The expert's conversation for the current task.
   *
   * Scoped to the task, not the workspace: consultations about one piece of work should build
   * on each other, and consultations about an unrelated task should not drag that history
   * along -- it would be paid for on every future call and would confuse the answer.
   */
  let expertSessionId: string | undefined

  function resetExpertSpend(): void {
    expertSpend = { usd: 0, consultations: 0, unpriced: 0, keepAlives: 0 }
    expertSessionId = undefined
    /*
     * A new task means a new session, so there is nothing left to keep warm. Without this the
     * timer would go on refreshing a session id that has just been discarded — spending on a
     * cache nothing will ever read.
     */
    stopKeepAlive()
    // Left in place: since a raised ceiling is now saved as the standing default, clearing it
    // here would make the next chat disagree with what the Expert tab says the budget is.
    expertAdvice = []
    taskExpertLimits = undefined
    taskExpertEstimate = undefined
    postExpertSpend()
  }

  function postExpertSpend(): void {
    const limits = effectiveExpertLimits()
    const usage = expertBudgetUsage(expertSpend, limits)
    post({
      type: 'expertSpend',
      ...expertSpend,
      ...(usage === undefined ? {} : { usage }),
      ...(checkExpertBudget(expertSpend, limits).allowed ? {} : { exhausted: true }),
      maxSpendUsd: limits.maxSpendUsd ?? 0,
      maxConsultations: limits.maxConsultations ?? 0,
      overridden: taskExpertLimits !== undefined,
      ...(taskExpertEstimate === undefined ? {} : { estimate: taskExpertEstimate }),
    })
  }

  /**
   * The durable record behind the savings figures, one JSON object per line.
   *
   * **Lines, not a JSON array.** An array means read-modify-write on every consultation, which
   * is precisely the shape that corrupted `config.json` (§15) — and this file is written from
   * inside a turn, where a cancelled run is normal rather than exceptional. An append is one
   * write, and a torn final line costs one event because every other line still parses.
   *
   * Held in memory as well, so the three windows can be summarised without a read per request.
   */
  const expertEventsPath = path.join(storageDir, 'expert-events.jsonl')
  let expertEvents: ExpertEvent[] | undefined
  /**
   * Set when a Junior-mode turn begins, cleared the moment the expert is consulted.
   *
   * So it is still true at the end only for a turn the cheap model handled alone — which is
   * exactly the turn worth counting.
   */
  let juniorTurnWithoutExpert = false

  async function loadExpertEvents(): Promise<ExpertEvent[]> {
    if (expertEvents !== undefined) return expertEvents
    try {
      const raw = await fs.readFile(expertEventsPath, 'utf8')
      const parsed: ExpertEvent[] = []
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          parsed.push(JSON.parse(line) as ExpertEvent)
        } catch {
          // One unreadable line — an interrupted append — must not cost the whole history.
        }
      }
      expertEvents = pruneEvents(parsed)
    } catch {
      expertEvents = []
    }
    return expertEvents
  }

  function appendExpertEvent(event: ExpertEvent): void {
    void (async () => {
      try {
        const events = await loadExpertEvents()
        events.push(event)
        await fs.mkdir(path.dirname(expertEventsPath), { recursive: true })
        await fs.appendFile(expertEventsPath, `${JSON.stringify(event)}\n`, 'utf8')
      } catch (error) {
        // A lost metric is not worth interrupting a turn over.
        logger.warn(`could not record expert spend: ${String(error)}`)
      }
    })()
  }

  function recordConsultation(info: { costUsd?: number; isError: boolean }): void {
    // This turn is no longer one the expert never saw.
    juniorTurnWithoutExpert = false
    expertSpend.consultations += 1
    if (info.costUsd !== undefined) expertSpend.usd += info.costUsd
    else expertSpend.unpriced += 1
    postExpertSpend()

    /*
     * `resumed` is read from whether a session existed *before* this call, which is what
     * decides whether a cold start was paid for. Taken from the id rather than from the mode,
     * because a resumed session is the thing that actually saved the money.
     */
    appendExpertEvent({
      at: Date.now(),
      kind: 'consultation',
      ...(info.costUsd !== undefined ? { usd: info.costUsd } : {}),
      resumed: expertSessionId !== undefined,
    })

    /*
     * What this plan does about pricing, learned from the answer rather than asked for.
     *
     * A failed consultation says nothing: it can return without a cost because it never got far
     * enough to have one, which is not the same as a plan that never prices anything.
     *
     * Written once. Re-writing config on every consultation would churn the file and its watcher
     * for a fact that does not change.
     */
    if (info.isError) return
    const learned = info.costUsd !== undefined
    if (cachedReportsCost === learned) return
    cachedReportsCost = learned
    void configManager
      .load()
      .then(async ({ config }) => {
        await configManager.save('user', {
          ...config,
          expert: { ...config.expert, reportsCost: learned },
        })
        await postExpert()
      })
      .catch(() => {
        // Not worth surfacing: the meter is already accurate for this session, and the only cost
        // of failing to persist is learning it again next time.
      })
  }
  let cachedModeId: string | undefined

  /** Rebuilt on every settings load, so a profile change reaches the next turn. */
  let cachedCodeGenerator: CodeGenerator | undefined
  /** Resolved with the rest of settings, so changing the profile takes effect on the next turn. */
  /**
   * The specialists, resolved once per settings load.
   *
   * Held rather than recomputed per call because the mode guidance and the tool both need the
   * same answer, and two resolutions of "who is the reviewer" would be two chances to disagree.
   */
  let cachedTeam: ResolvedAgent[] = []
  let cachedTeamGuidance: string | undefined
  let cachedAgentRoles: NonNullable<LightCodeConfig['agents']>['roles']
  let cachedAgentDefinitions: CustomRoleDefinition[] = []
  /**
   * Whether anything is counting what a consultation costs.
   *
   * Read by the prompt and by `ask_expert`'s description, so the advice about spending appears
   * only where there is spending to manage — telling a model to ration an unmetered gateway makes
   * it ask fewer questions for no benefit.
   */
  let cachedBudgetMatters = false
  /** Undefined means the defaults; an empty array means the user cleared the list. */
  let cachedMentionExcludes: string[] | undefined
  /** Undefined until a consultation has told us. See `recordConsultation`. */
  let cachedReportsCost: boolean | undefined
  /** Set while a measurement is running, so the panel can say what it is doing. */
  let measuringStep: string | undefined
  let cachedPricing: ExpertPricing | undefined
  let cachedKeepAlive = false
  let cachedProgrammingProfileId: string | undefined
  /** Mirrors config, because the registry is built synchronously and cannot await a load. */
  let cachedOffice: { excel?: boolean | undefined; outlook?: boolean | undefined } = {}
  /** Mirrors `mail`, for the same reason. */
  let cachedMail: MailIndexConfig = {}
  let cachedDatasets: DatasetConfig[] = []
  /**
   * Buckets this install can reach, rebuilt whenever settings are loaded.
   *
   * Cached rather than passed down, like the datasets above: building a client needs a secret,
   * which is async, and `currentToolRegistry` is synchronous on purpose so the tool block stays
   * byte-stable for a whole turn (§12).
   */
  let cachedS3: ResolvedS3 = { targets: [], problems: [] }
  /*
   * Names and counts for the system prompt, refreshed with the settings rather than read per
   * request: the prompt is built every turn and hitting the disk for every dataset each time
   * would be a file read per turn for something that changes on a timer.
   */
  let datasetSummaryForPrompt: { name: string; records: number }[] = []
  let cachedPythonEnabled = false
  const mailStore = new MailStore(storageDir)
  /** Set while a sync or prune runs, so two cannot overlap on one mailbox. */
  let mailBusy = false
  let mailTimer: ReturnType<typeof setInterval> | undefined
  /**
   * A stop switch per kind of index.
   *
   * Separate controllers rather than one, because these run independently: cancelling a mail
   * sync must not abort a codebase index that happens to be running, and a shared controller
   * would do exactly that while looking correct.
   */
  const indexingAborts = new Map<string, AbortController>()

  /** Starts a cancellable run, replacing any previous controller for that kind. */
  function beginIndexing(kind: string): AbortSignal {
    indexingAborts.get(kind)?.abort()
    const controller = new AbortController()
    indexingAborts.set(kind, controller)
    return controller.signal
  }

  function endIndexing(kind: string): void {
    indexingAborts.delete(kind)
  }

  /** Reports what a long run is doing. `running: false` is what clears the bar. */
  function reportIndexing(
    kind: IndexingKind,
    phase: string,
    extra: { done?: number; total?: number; detail?: string; running?: boolean } = {},
  ): void {
    post({
      type: 'indexingProgress',
      kind,
      phase,
      running: extra.running ?? true,
      ...(extra.done !== undefined ? { done: extra.done } : {}),
      ...(extra.total !== undefined ? { total: extra.total } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
    })
  }
  let mailLastResult: string | undefined

  async function loadSettings(): Promise<LightCodeConfig> {
    const { config } = await configManager.load()
    cachedApprovals = approvalsFrom(config.approvals)
    cachedRiskyCommands = riskyCommandRules(config.commands)
    cachedCodeGenerator = codeGeneratorFor(config)

    /*
     * The team is resolved from config plus what was detected, in one place.
     *
     * `expertCli?.available` rather than "is a path configured": a role assigned to Claude on a
     * machine where it is not installed must report as unavailable rather than be offered and
     * fail, which is the rule every other tool here follows.
     */
    const teamContext = {
      config: config.agents,
      profiles: (config.profiles ?? []).map((profile) => ({
        id: profile.id,
        label: profile.label,
      })),
      cliAvailable: expertCli?.available === true,
    }
    cachedTeam = resolveTeam(teamContext)
    /*
     * The raw blocks as well as the resolved team, because the role-prompt tools need two things
     * `ResolvedAgent` deliberately loses: whether a prompt is the *user's* or the default (the
     * resolved one is just a string either way), and the roles that exist but nobody has been
     * assigned to. Refreshed here so there is one moment when all of it becomes current.
     */
    cachedAgentRoles = config.agents?.roles
    cachedAgentDefinitions = config.agents?.definitions ?? []
    cachedTeamGuidance = config.agents?.teamGuidance
    cachedBudgetMatters = budgetMatters(teamContext)
    cachedProgrammingProfileId = config.programmingProfileId
    cachedOffice = config.office ?? {}
    cachedMail = config.mail ?? {}
    cachedDatasets = config.datasets ?? []
    /*
     * Resolved here so the tools, the skills sync and the Python tools sync all see the same
     * answer — three features resolving their own credentials would be three chances to get the
     * endpoint or the prefix subtly different.
     */
    cachedS3 = await resolveS3({
      config: config.s3,
      http: httpClient,
      secrets,
      /*
       * Through the one global resolver, so a corporate root certificate reaches S3 exactly as it
       * reaches the gateway and the vector store. §10: do not add another place to configure a CA.
       */
      tls: await resolveConnectionTls({
        ...(config.tls !== undefined ? { global: config.tls } : {}),
        ...(config.certDir !== undefined ? { certDir: config.certDir } : {}),
        onPaths: (paths) => {
          void Promise.all(paths.map((certPath) => denylist.add(certPath))).catch(() => undefined)
        },
      }),
    })
    cachedPythonEnabled = config.python?.dynamicTools === 'on'
    datasetSummaryForPrompt = await Promise.all(
      cachedDatasets.map(async (dataset) => ({
        name: dataset.name,
        records: (await new DatasetStore(storageDir, dataset.id).load()).length,
      })),
    )
    cachedModeId = config.modeId
    cachedMaxIterations = config.maxIterations ?? 25
    cachedAccentColor = config.ui?.accentColor ?? '#22C55E'
    cachedTheme = config.ui?.theme
    cachedToolTimeoutSeconds = config.tools?.timeoutSeconds
    cachedToolTimeouts = config.tools?.timeouts
    cachedExpertColor = config.ui?.expertColor ?? '#D97757'
    /*
     * The assessment that applies to the model now in the junior seat, chosen from everything
     * assessed rather than read from one slot. `allAssessments` owns the older single-field
     * shape, so this never has to know which shape the file is in.
     *
     * Tolerant of there being no profile at all, which `resolveActiveProfile` reports by
     * throwing. Every setting on this screen loads through here, so letting that escape means a
     * fresh install - the one state where nothing is configured yet - cannot open its settings.
     */
    const junior = ((): { model: string; label?: string } | undefined => {
      try {
        return resolveActiveProfile(config)
      } catch {
        return undefined
      }
    })()
    cachedAssessment =
      junior === undefined
        ? undefined
        : assessmentFor(allAssessments(config.expert ?? {}), junior.model, junior.label ?? junior.model)
    cachedReportsCost = config.expert?.reportsCost
    cachedPricing = config.expert?.pricing
    cachedKeepAlive = config.expert?.keepAlive === true
    // Switched off mid-task, the timer goes with it rather than waiting for its next tick.
    if (!cachedKeepAlive) stopKeepAlive()
    cachedExpertLimits = {
      ...(config.expert?.maxSpendUsd !== undefined
        ? { maxSpendUsd: config.expert.maxSpendUsd }
        : {}),
      ...(config.expert?.maxConsultations !== undefined
        ? { maxConsultations: config.expert.maxConsultations }
        : {}),
    }
    cachedMentionExcludes = config.filesystem?.excludeFromMentions
    cachedReadRoots = (config.filesystem?.readRoots ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    skillsDir =
      (config.skills?.dir !== undefined ? resolveSkillDir(config.skills.dir) : undefined) ??
      defaultSkillsDir
    extraSkillDirs = (config.skills?.paths ?? [])
      .map(resolveSkillDir)
      .filter((dir): dir is string => dir !== undefined)

    /*
     * A bucket folder joins the search path as one more read-only extra.
     *
     * This is the whole of what "keep skills in S3" changes. Nothing downstream — the loader, the
     * watcher, the tab, the documentation index, team publishing — learns that S3 exists; they see
     * a folder. Which is why indexing stays exactly as configured, as asked.
     *
     * Added whether or not the last sync worked: the files from the previous one are still there
     * and still valid, and dropping them because a refresh failed would take somebody's skills
     * away over a network blip.
     */
    cachedSkillMirrors = config.s3?.skills ?? []
    mirroredSkillsDirs = cachedSkillMirrors
      .filter((mirror) => mirror.enabled === true)
      .map((mirror) =>
        mirrorFolder({
          storageDir,
          connectionId: mirror.connectionId,
          kind: 'skills',
          ...(mirror.prefix !== undefined ? { prefix: mirror.prefix } : {}),
        }),
      )
    extraSkillDirs.push(...mirroredSkillsDirs)

    cachedToolMirrors = config.s3?.tools ?? []
    mirroredToolsDirs = (config.s3?.tools ?? [])
      .filter((mirror) => mirror.enabled === true)
      .map((mirror) =>
        mirrorFolder({
          storageDir,
          connectionId: mirror.connectionId,
          kind: 'tools',
          ...(mirror.prefix !== undefined ? { prefix: mirror.prefix } : {}),
        }),
      )

    return config
  }

  /**
   * Says so when a damaged config file was repaired from its backup.
   *
   * Recovery is deliberately not silent. Something wrote a file that could not be read, and a
   * user who is never told will not know a setting they changed just before it happened may
   * have gone with it — nor that the broken copy is still on disk if they want it.
   */
  function announceConfigRecovery(): void {
    const recovery = configManager.takeRecovery()
    if (recovery === undefined) return
    const where =
      recovery.quarantinedTo === undefined
        ? ''
        : ` The damaged file was kept as ${recovery.quarantinedTo}.`
    const message = `Your ${recovery.scope} settings file could not be read and was restored from the last good copy.${where} Anything changed immediately before this may need setting again.`
    logger.warn(message)
    post({ type: 'error', message })
  }

  /**
   * Everything a `settings` message says, built once.
   *
   * There were two of these, constructed separately, and they had already drifted: the theme
   * reached the one sent after saving approvals and not the one sent by `postSettings`, so a
   * theme the user picked was written to disk and reported back as unset. That is the third time
   * this shape has bitten — `hostCapabilities()` and `expertMessageFrom()` exist for the same
   * reason — and the fix is always the same: one constructor, and pass the whole thing.
   *
   * `approvals` is the one part a caller may override, because `saveApprovals` has the new value
   * in hand before the cache is refreshed.
   */
  function settingsMessageFrom(
    approvals: WorkspaceApprovals = cachedApprovals,
  ): Extract<HostToUiMessage, { type: 'settings' }> {
    return {
      type: 'settings',
      modeId: findMode(cachedModeId).id,
      approvals,
      maxIterations: cachedMaxIterations,
      accentColor: cachedAccentColor,
      expertColor: cachedExpertColor,
      ...(cachedTheme === undefined ? {} : { theme: cachedTheme }),
      ...(cachedToolTimeoutSeconds === undefined
        ? {}
        : { toolTimeoutSeconds: cachedToolTimeoutSeconds }),
      readRoots: cachedReadRoots,
      ...(cachedProgrammingProfileId !== undefined
        ? { programmingProfileId: cachedProgrammingProfileId }
        : {}),
      ...hostCapabilities(),
    }
  }

  async function saveApprovals(next: WorkspaceApprovals): Promise<void> {
    const { config } = await configManager.load()
    await configManager.save('user', { approvals: { ...config.approvals, [approvalsKey]: next } })
    cachedApprovals = next
    post(settingsMessageFrom(next))
  }

  /*
   * What the UI needs to know about the *host*, not the config.
   *
   * Derived from the services it was given rather than declared separately: a host that
   * implements `openWalkthrough` has native onboarding by definition, and one that does not is
   * telling the UI to render its own. Two ways of saying the same thing would eventually
   * disagree, and the failure is a button that does nothing.
   */
  function hostCapabilities(): {
    nativeGuide: boolean
    guideMediaBase?: string
    allowProgrammingProfile: boolean
    choosesTheme: boolean
    offersOffice: boolean
  } {
    return {
      nativeGuide: ui.openWalkthrough !== undefined,
      /*
       * Whether this host has a theme of its own to follow.
       *
       * VS Code does — the editor's — so offering a light/dark choice there would be a control
       * that fights the editor. A browser does not, and `prefers-color-scheme` follows the
       * browser's own appearance setting rather than the operating system's, so a corporate Edge
       * pinned to light leaves someone with no way to get a dark UI. Derived from the same signal
       * as `nativeGuide`: a host with native onboarding is the host with a native theme.
       */
      choosesTheme: ui.openWalkthrough === undefined,
      /*
       * So the Outlook tab is *absent* rather than present and explaining itself.
       *
       * A tab that exists only to say the feature is not available here teaches that the product
       * is bigger than it is, and it is the first thing anybody clicks. Same rule the tools
       * follow: absent beats present-and-failing.
       */
      offersOffice: officeAvailable(),
      allowProgrammingProfile: services.allowProgrammingProfile === true,
      ...(services.guideMediaBase !== undefined ? { guideMediaBase: services.guideMediaBase } : {}),
    }
  }

  /**
   * Whether Excel, Outlook and the mail index exist in this host.
   *
   * Two questions in one place: is this Windows, and does this host want the feature. They were
   * one question asked in six places, which was fine while the answer was only ever the platform
   * — the moment a second term appeared, six call sites would have had to learn about it, and the
   * one that did not would have left a tab, a timer or a tool behind.
   */
  function officeAvailable(): boolean {
    return officeSupported() && services.offersOffice !== false
  }

  const userGate = new WebviewApprovalGate(post)
  // Policy answers what it can from settings; anything else falls through to the user.
  const approvalGate = new PolicyApprovalGate(
    userGate,
    () => cachedApprovals,
    // Read per request, so a rule added mid-session applies to the next command rather than
    // after a reload - which is when somebody adds one.
    () => cachedRiskyCommands,
  )

  let mcpJson = '{\n  "mcpServers": {}\n}'
  /**
   * Mirrors what is on disk, so the form can edit one entry without reparsing the JSON.
   * Set together with `mcpJson` through `setMcpServersState` — two representations of the
   * same thing, kept in one place because that is exactly what drifts otherwise.
   */
  let mcpConfigs: McpServersConfig = {}

  function setMcpServersState(servers: McpServersConfig): void {
    mcpConfigs = servers
    mcpJson = JSON.stringify({ mcpServers: servers }, null, 2)
  }

  const mcp = new McpRegistry(
    secrets,
    {
      onStateChanged: () => {
        postMcp()
        /*
         * The schedule tool picker is built from the live registry, and MCP servers connect
         * seconds *after* the panel opens — the UI asks for schedules once, on mount, so it
         * captured an empty MCP list and never heard again. That is why no MCP tool could be
         * ticked for a schedule. Re-posting on every state change covers connect, disconnect
         * and tools/list_changed alike.
         */
        void postSchedules()
        // Same reasoning: MCP servers connect seconds after the panel opens, so a catalogue
        // fetched once on mount would show an empty list for ever.
        void postTools()
        // And the collector picker, which offers MCP tools too.
        void postDatasetStatus()
        // Fires on connect, disconnect and tools/list_changed — every way the MCP half of
        // the corpus can change. Opening the panel fires several at once, which is what the
        // debounce is for.
        scheduleDocsReindex('MCP tools changed')
      },
    },
    logger,
    () => cachedApprovals.allowedTools ?? [],
    () => cachedToolTimeoutSeconds,
  )

  function postMcp(): void {
    const servers = mcp.states_()
    const warnings: Record<string, string[]> = {}
    for (const server of servers) warnings[server.name] = mcp.warningsFor(server.name)
    post({
      type: 'mcp',
      servers,
      json: mcpJson,
      warnings,
      configs: mcpConfigs,
      platform: process.platform === 'win32' ? 'win32' : 'posix',
    })
  }

  /**
   * Built-ins plus every enabled MCP tool, rebuilt per turn. MCP tools are ordinary
   * `Tool`s by this point, so mode filtering and the approval gate apply to them with
   * no special-casing.
   */
  function currentToolRegistry(
    expert?: { cli: ClaudeCliInfo; model?: string },
    search?: { client: OpenSearchClient; store: VectorStoreConfig; indexes: string[] },
    codebase?: {
      searcher: VectorSearcher
      embedder: Embedder
      index: string
      connectionLabel: string
    },
    /** Retrieval for `search_docs`, when a store, an embedder and an indexed corpus exist. */
    docs?: { searcher: VectorSearcher; embedder: Embedder; index: string },
    /**
     * Hides MCP and Python schemas from the prompt, reachable through `call_tool` instead
     * (§12). Resolved once per turn like the mode, so the tool block stays byte-stable.
     */
    dispatcher = false,
    /**
     * Keeps skill summaries out of the prompt too, found with `search_docs` instead. Separate
     * from `dispatcher` because it is a separate trade — see `skillRetrievalEnabled`.
     */
    hideSkills = false,
    /**
     * The team's shared skills, when an alias is configured and reachable.
     *
     * Passed in rather than resolved here for the same reason `codebase` is: building it needs
     * an embedder and a connection, both of which are awaited, and this function is synchronous
     * so the tool block stays byte-stable for a whole turn (§12).
     */
    /*
     * The shape is `TeamSkillsOptions` itself rather than a copy of its fields. The copy had
     * already fallen behind — `collection` where the type now says `collections` — which is the
     * failure this project has paid for most, and a structural type is the version of it that
     * cannot happen.
     */
    teamSkills?: TeamSkillsOptions,
    /**
     * Semantic ranking for indexed mail, when a store and embedder exist.
     *
     * Optional in the strong sense: every temporal question — which is most of them — is
     * answered from the fact index alone, so mail search works completely without this. It only
     * reorders what the exact filters already produced.
     */
    mailSemantic?: { searcher: VectorSearcher; embedder: Embedder; collection: string },
    /** Ranking for custom datasets. Absent leaves `search_data` matching on words, which still works. */
    datasetSemanticForTools?: { searcher: VectorSearcher; embedder: Embedder; collection: string },
  ): ToolRegistry {
    const combined = new ToolRegistry()
    for (const tool of builtinTools.list()) combined.register(tool)
    /*
     * MCP and Python tools are the whole reason the dispatcher exists: a few servers can
     * contribute forty tools each, and their schemas sit at the front of every request.
     * Built-ins stay advertised — there are nine, the model needs them constantly, and
     * making it search for `read_file` would be absurd.
     *
     * `dispatchOnly` withholds the *advertisement*, never the capability: the mode filter and
     * the approval gate still apply exactly as before, because the loop unwraps `call_tool`
     * before either of them runs.
     */
    for (const tool of mcp.enabledTools()) combined.register(tool, { dispatchOnly: dispatcher })
    /*
     * Python tools are adapted into the ordinary Tool interface, exactly as MCP tools are.
     * That is the design choice that matters: the loop, the approval gate and mode filtering
     * treat py__* like execute_command, with no special-casing upstream — so a model-authored
     * tool is approval-gated for free.
     *
     * The split is deliberate. The user's *generated* tools grow without bound, so they are
     * what the dispatcher hides. The three tools for *creating* them never grow, and hiding
     * those produced a reported failure: asked for a tool, the model wrote a plain .py file in
     * the workspace root, because `write_to_file` was advertised and `create_python_tool` was
     * not. A capability the model has to search for is one it will sometimes not search for.
     */
    for (const tool of python.managementTools()) combined.register(tool)
    /*
     * The doctor, offered whenever Python tools are. It is `read` and changes nothing, so it
     * costs a description and can save a scheduled sync failing at three in the morning for a
     * reason nobody would connect to the file they wrote last week.
     */
    if (cachedPythonEnabled) {
      combined.register(
        createCheckCollectorTool({
          has: (name) => combined.get(name) !== undefined,
          run: async (name, args) => {
            const tool = combined.get(name)
            if (tool === undefined) throw new Error(`No tool called ${name}.`)
            const result = await tool.execute(args as never, {} as never)
            if (result.isError === true) throw new Error(String(result.content))
            try {
              return JSON.parse(typeof result.content === 'string' ? result.content : '')
            } catch {
              // Returned as-is so the diagnosis can say "a string of N characters", which is
              // exactly the finding when somebody returned a report instead of records.
              return result.content
            }
          },
        }) as unknown as Parameters<typeof combined.register>[0],
      )
    }
    for (const tool of python.generatedTools())
      combined.register(tool, { dispatchOnly: dispatcher })
    /*
     * The two plan tools, always registered and always *advertised*.
     *
     * They used to follow the dispatcher, on the argument that hiding them cost nothing because
     * the plan guidance names them both. Reported from real use, and the argument was wrong in
     * the one place it mattered most: agent team mode opens by telling the model to propose the
     * expert's plan with `update_plan`, and with the dispatcher on that tool is not in the list
     * it can see. So it was instructed to call something invisible while `write_to_file` sat
     * right there — and it wrote the plan into a file, which looks like progress and is not. The
     * user had to stop it and say so.
     *
     * Naming a tool in guidance and hiding it from the tool block are not compatible. Being
     * reachable through `search_docs` is not the same as being reachable: it asks the model to
     * notice an absence, infer indirection, and spend a step on it, which is exactly what a model
     * under instruction to get on with the plan will not do.
     *
     * §12 permits this outright. What it forbids is the advertised set *varying* — and always
     * present is the most stable thing there is, strictly more stable than conditioning on the
     * dispatcher. The price is two tool definitions in every session, which against a plan
     * silently written to a file is not a price worth haggling over.
     *
     * Registered unconditionally rather than only when a plan exists, for the original reason:
     * making the registry a function of whether a plan is set would put the plan into the tool
     * block, which is the one thing §12 rules out.
     */
    combined.register(createUpdatePlanTool(planAccess))
    combined.register(createPlanProgressTool(planAccess))

    /*
     * Changing what a specialist is, from the chat.
     *
     * `dispatchOnly` like the plan tools: this is wanted in the rare conversation where somebody
     * says "the reviewer is too soft", and paying for two descriptions at the front of every
     * prompt to serve that would be the wrong trade (§12). The user asks in words; the dispatcher
     * finds it.
     */
    combined.register(createReadRolePromptTool(rolePromptAccess), { dispatchOnly: dispatcher })
    combined.register(createUpdateRolePromptTool(rolePromptAccess), { dispatchOnly: dispatcher })
    combined.register(createCreateRoleTool(rolePromptAccess), { dispatchOnly: dispatcher })
    combined.register(createDeleteRoleTool(rolePromptAccess), { dispatchOnly: dispatcher })
    // Offered whenever a folder is open. Unlike Python tools these need no interpreter —
    // a skill is markdown, so the only prerequisite is somewhere to put it.
    /*
     * Registered always, not only for schedules. An interactive session rarely needs it — the
     * user is already reading the reply — and the description says so; but a scheduled run is
     * built from this same registry, and a run that could not report would be pointless.
     */
    combined.register(
      createNotifyTool({
        notify: (message, level, details) => {
          /*
           * A report goes to a document, because the toast cannot hold one. VS Code
           * notifications are a plain string plus buttons — no Markdown, no table, no colour —
           * so "rich notification" has to mean "a notification that opens something rich".
           */
          if (details !== undefined) {
            void (async () => {
              /*
               * Written to disk before the toast, not instead of it.
               *
               * The point of an unattended run is that nobody was watching. A notification is
               * gone by morning and an in-memory document dies with the window, so a report that
               * existed only in a closure was a report the user could not read — which is most
               * of the value of having the run at all. The file outlives both.
               */
              const saved = await saveReport(message, details)
              if (saved !== undefined) lastReportPath = saved

              const open = await ui.showActionMessage(message, 'Open report', level)
              if (!open) return
              // The file when there is one, so what opens has a path the user can find again.
              if (saved !== undefined && ui.openFile !== undefined) await ui.openFile(saved)
              else await ui.openDocument({ title: message, content: details })
            })()
            return
          }
          /*
           * From a scheduled run the notification is the only thing the user will see, so it
           * carries a way into the transcript. Captured at call time rather than at
           * registration: the task id changes with every run, and the registry is rebuilt per
           * turn but the closure would otherwise still point at whatever was open when it was
           * built.
           */
          const taskId = runningScheduleId !== undefined ? activeTaskId : undefined
          if (taskId === undefined) {
            if (level === 'warning') ui.showWarning(message)
            else ui.showInfo(message)
            return
          }
          void openFromNotification(message, level, taskId)
        },
      }),
    )
    if (skillsDir !== undefined) {
      const context = {
        skillsDir,
        onChanged: refreshSkills,
        /*
         * Every loaded skill, so `use_skill_file` can reach a template in a read-only shared
         * folder. A closure over the live array rather than a copy: the folders are watched, and
         * a registry built once per turn would otherwise hold a list from before the last change.
         */
        listSkills: () => skills,
        /*
         * So a new skill can say "a colleague already has one of these".
         *
         * A callback rather than the searcher itself: an edit tool has no business holding a
         * corpus, and the read/write split `VectorSearcher` exists to preserve is not worth
         * spending for convenience here.
         */
        ...(teamSkills !== undefined
          ? { findTeamSkillsNamed: async (name: string) => findTeamSkillsNamed(teamSkills, name) }
          : {}),
        ...(services.submitForReview !== undefined
          ? {
              submitForReview: (request: {
                name: string
                content: string
                existingContent: string
              }) =>
                services.submitForReview?.({ kind: 'skill' as const, ...request }) ??
                Promise.resolve(''),
            }
          : {}),
      }
      /*
       * Published back to the bucket when skills are kept in one.
       *
       * Absent unless the mirror is configured and the connection is writable, so writing is
       * unchanged for everyone else. A failure is reported in the tool result rather than failing
       * the write — the file is already on disk and correct.
       */
      /*
       * The one folder marked for publishing, of however many are read from.
       *
       * The same split the local folders already have: any number of places skills are read from,
       * one place new ones are saved. Without that, "where did that skill go" would have no
       * answer - or worse, several.
       */
      const publishTo = cachedSkillMirrors.find(
        (mirror) => mirror.enabled === true && mirror.publish === true,
      )
      const skillTarget =
        publishTo === undefined ? undefined : targetById(cachedS3, publishTo.connectionId)
      const mirrorPrefix = publishTo?.prefix
      combined.register(
        createWriteSkillTool({
          ...context,
          ...(skillTarget !== undefined && skillTarget.readOnly !== true
            ? {
                onSaved: async (name: string, content: string) => {
                  await uploadToS3({
                    target: skillTarget,
                    ...(mirrorPrefix !== undefined ? { prefix: mirrorPrefix } : {}),
                    relative: `${name}.md`,
                    contents: Buffer.from(content, 'utf8'),
                  })
                },
              }
            : {}),
        }),
      )
      combined.register(createDeleteSkillTool(context))
      // Registered beside them because it is the same feature: a skill that carries a template
      // is worth nothing if there is no way to get the template out of it.
      combined.register(createUseSkillFileTool(context))
    }
    /*
     * Scheduling from the chat. Offered only where somebody can answer the form and where there
     * is a project to bind the job to — a schedule with no workspace fires in whichever project
     * happens to be open, which is the hazard §12d exists to close.
     */
    if (workspaceRoot !== undefined) {
      combined.register(
        createScheduleFromChatTool({
          /*
           * The host's own policy decides what a schedule may be granted, and it is applied by
           * filtering the live registry rather than by keeping a second list here. Two lists
           * would be two things to keep in step.
           */
          schedulableTools: () =>
            filterToolsForSchedule(combined.list(), {
              allowedTools: combined.list().map((entry) => entry.name),
            })
              .filter((entry) => entry.name !== 'schedule_prompt')
              .map((entry) => ({ name: entry.name, description: entry.description })),
          requestForm: async (fields, title) => {
            const answer = await requestForm({ title, fields })
            return answer.submitted ? answer.values : undefined
          },
          create: createScheduleFromProposal,
        }),
      )
    }
    /*
     * Offered only when there is a shared corpus to search. Registering it without one would
     * advertise a tool that always answers "nothing found", and the model would keep reaching
     * for it instead of reading the local skills it does have.
     */
    if (teamSkills !== undefined) {
      combined.register(createSearchTeamSkillsTool({ ...teamSkills, observer: searchLog }))
    }
    if (search !== undefined) {
      combined.register(
        createSearchOpensearchTool({
          client: search.client,
          connectionLabel: search.store.label,
          ...(search.store.defaultIndex !== undefined
            ? { defaultIndex: search.store.defaultIndex }
            : {}),
          availableIndexes: search.indexes,
          ...(search.store.limits !== undefined ? { limits: search.store.limits } : {}),
        }),
      )
    }
    /*
     * Offered only when an index could actually be searched: a connection, an embedder, and
     * an index name. Registering it without them would advertise a tool that always errors,
     * and the model would keep reaching for it instead of using search_files.
     */
    if (codebase !== undefined) {
      combined.register(createSearchCodebaseTool({ ...codebase, observer: searchLog }))
    }

    /*
     * Offered only once a dataset exists.
     *
     * Registering it against nothing would advertise a tool that always answers "no datasets
     * configured", and the model would keep reaching for it — the same argument that gates the
     * mail tools on indexing being switched on.
     */
    /*
     * Offered only when a bucket is configured, like every other connection-backed tool here.
     * Registering them against nothing would advertise four tools that always fail, and the model
     * would keep reaching for them.
     */
    for (const tool of createS3Tools(cachedS3.targets)) combined.register(tool)

    if (cachedDatasets.length > 0) {
      combined.register(
        createSearchDataTool({
          load: async () =>
            Promise.all(
              cachedDatasets.map(async (dataset) => ({
                id: dataset.id,
                name: dataset.name,
                records: await new DatasetStore(storageDir, dataset.id).load(),
              })),
            ),
          ...(datasetSemanticForTools !== undefined ? { semantic: datasetSemanticForTools } : {}),
        }),
      )
    }
    /*
     * `search_docs` is registered whenever the dispatcher is on, with or without a vector
     * store. Without one it matches names and descriptions from the live registry instead of
     * by meaning — and that fallback is load-bearing, not a nicety: hiding every MCP tool
     * behind a `search_docs` that did not exist would make them all permanently unreachable.
     */
    /*
     * Nothing is hidden unless there is something to hide.
     *
     * The dispatcher is on by default now, and the one case where it costs more than it saves
     * is a workspace with no MCP servers, no Python tools and no skills: `call_tool`,
     * `search_docs` and `forget_docs` carry their own descriptions, so registering them to
     * search an empty catalogue is pure loss. Conditioning on the catalogue removes that case
     * entirely rather than asking the user to notice it.
     *
     * `call_tool` and `search_docs` are decided separately because they answer to different
     * things: a workspace with skills but no MCP tools needs to *find* documentation without
     * needing an indirect way to *call* anything.
     */
    /*
     * Windows only, and off by default. Registered rather than advertised-and-failing: on any
     * other platform the tools are simply absent, which is the same rule mode filtering follows.
     */
    // Constructed only when something will use it: a bridge object built for a feature nobody
    // switched on is a disposal path that has to stay correct for no benefit.
    if (officeAvailable() && (cachedOffice.excel === true || cachedOffice.outlook === true)) {
      const officeOptions = { bridge: office() }
      if (cachedOffice.excel === true) {
        combined.register(createExcelSessionsTool(officeOptions))
        // Registered alongside sessions rather than behind a flag: the moment it is wanted is
        // the moment something else has already failed, and a tool nobody can reach then is
        // worth nothing.
        combined.register(createExcelDiagnoseTool(officeOptions))
        combined.register(createExcelOpenTool(officeOptions))
        combined.register(createExcelReadRangeTool(officeOptions))
        combined.register(createExcelTraceTool(officeOptions))
        combined.register(createExcelListMacrosTool(officeOptions))
        combined.register(createExcelReadMacroTool(officeOptions))
        combined.register(createExcelWriteMacroTool(officeOptions))
        combined.register(createExcelWriteRangeTool(officeOptions))
        combined.register(createExcelCreateTool(officeOptions))
        combined.register(createExcelSaveTool(officeOptions))
        combined.register(createExcelSheetsTool(officeOptions))
        combined.register(createExcelCheckMacroTool(officeOptions))
        combined.register(createExcelEvaluateTool(officeOptions))
        combined.register(createExcelRunMacroTool(officeOptions))
      }
      if (cachedOffice.outlook === true) {
        /*
         * Mail investigation is offered only once indexing is switched on. Registering it
         * otherwise would advertise tools that always answer "nothing indexed", and the model
         * would keep reaching for them instead of `outlook_search`, which reads the live
         * mailbox and works immediately.
         */
        if (cachedMail.enabled === true) {
          const mailToolOptions = {
            loadRecords: () => mailStore.load(),
            // So `mail_coverage` can say whether a folder has been read all the way back,
            // rather than quoting its oldest indexed date as if that were the oldest message.
            loadBackfill: () => mailStore.loadBackfillState(),
            ...(mailSemantic !== undefined ? { semantic: mailSemantic } : {}),
          }
          combined.register(createSearchMailTool(mailToolOptions))
          combined.register(createMailPatternsTool(mailToolOptions))
          combined.register(createMailCoverageTool(mailToolOptions))
          combined.register(createMailStatsTool(mailToolOptions))
          combined.register(
            createOpenEmailTool({
              display: async (id: string) =>
                office().request<{ subject: string }>({ op: 'outlook.display', id }),
            }),
          )
        }
        combined.register(createOutlookFoldersTool(officeOptions))
        combined.register(createOutlookSearchTool(officeOptions))
        combined.register(createOutlookReadTool(officeOptions))
      }
    }

    const hasHiddenTools = dispatcher && combined.dispatchOnlyList().length > 0
    const hasHiddenSkills = hideSkills && skills.length > 0
    if (hasHiddenTools) {
      combined.register(createCallToolTool())
    }
    if (dispatcher && (hasHiddenTools || hasHiddenSkills)) {
      // Registered with search_docs, never without it: releasing documentation only makes
      // sense where documentation is being retrieved.
      combined.register(createForgetDocsTool())
      combined.register(
        createSearchDocsTool({
          // Resolved per call, so a tool registered later in this same function is still
          // found, and so a schema is never served from a snapshot.
          listTools: () => combined.list(),
          listSkills: () => skills,
          // A hit for a tool this run cannot call is still worth returning — annotated, so the
          // run can say what it needed instead of being refused and reporting a failure.
          accessibleTo: (name) => scheduleToolAccess?.(name) ?? true,
          ...(docs !== undefined ? { retrieval: docs } : {}),
          observer: searchLog,
        }),
      )
    }
    /*
     * The whole team, behind one tool.
     *
     * Registered alongside the CLI expert below rather than instead of it: `ask_agent` names a
     * role and `ask_expert` is the established name the transcript, `recall_expert_advice` and
     * older guidance all refer to.
     */
    if (cachedTeam.some((agent) => agent.available)) {
      combined.register(
        createAskAgentTool({
          agents: () => cachedTeam,
          onAdvice: (record) => expertAdvice.push(record),
          consult: async (agent, request) => consultAgent(agent, request),
        }) as unknown as Tool<never>,
      )
    }

    // Registered only when the CLI is actually runnable, so the model is never told about
    // a tool that would fail — the same rule mode filtering follows.
    if (expert !== undefined) {
      // Free by construction: it has no path to the CLI, only to what was already said.
      combined.register(createRecallExpertTool({ history: () => expertAdvice }))
      combined.register(
        createAskExpertTool({
          cli: expert.cli,
          budgetMatters: cachedBudgetMatters,
          ...(expert.model !== undefined ? { model: expert.model } : {}),
          onConsultation: recordConsultation,
          onAdvice: (record) => expertAdvice.push(record),
          // Read at call time, not captured: the user can raise the limit mid-task and the very
          // next consultation should honour it, without starting a new task to pick it up.
          budget: () => checkExpertBudget(expertSpend, effectiveExpertLimits()),
          /*
           * The measured cost goes with the budget, so the expert plans in this deployment's
           * units rather than from what it believes consultations cost in general.
           */
          budgetSummary: () =>
            describeExpertBudget(
              expertSpend,
              effectiveExpertLimits(),
              pricingForPrompt(cachedPricing),
            ),
          onEstimate: (estimate) => {
            taskExpertEstimate = estimate
            postExpertSpend()
          },
          session: {
            get: () => expertSessionId,
            set: (sessionId) => {
              expertSessionId = sessionId
              // Only ever refreshes a session a real consultation created.
              if (sessionId !== undefined && cachedKeepAlive) ensureKeepAlive()
            },
          },
          /*
           * Lazy, and reading `combined` — the registry it describes is still being built at
           * this point, and the expert must be told about tools registered after this line
           * as much as before it.
           */
          briefing: () =>
            buildExpertBriefing({
              ...(cachedAssessment === undefined ? {} : { juniorAssessment: cachedAssessment }),
              // `ask_expert` itself is excluded: telling the expert it can consult itself is
              // noise at best and a loop at worst.
              promptTools: combined.promptList().filter((tool) => tool.name !== ASK_CLAUDE_TOOL),
              dispatchOnlyTools: combined.dispatchOnlyList(),
              skills,
              retrievalAvailable: combined.get('search_docs') !== undefined,
            }),
        }),
      )
    }
    // Captured for `consultAgent`, which is outside this closure. See the declaration.
    agentBriefingTools = () => combined.list()
    return combined
  }

  async function syncMcpFromConfig(config: LightCodeConfig): Promise<void> {
    const servers: McpServersConfig = config.mcpServers ?? {}
    setMcpServersState(servers)
    await mcp.configure(servers)
  }

  // Kept outside globalStorage's config area and outside the workspace, so a checkpoint
  // never lands inside the very tree it snapshots.
  const shadowGit =
    workspaceRoot !== undefined
      ? new ShadowGit(workspaceRoot, path.join(storageDir, 'checkpoints', 'shadow.git'))
      : undefined

  async function postProfiles(): Promise<void> {
    const { config } = await configManager.load()
    const profiles = await Promise.all(
      (config.profiles ?? []).map((profile) => toSummary(profile, secrets)),
    )
    post({ type: 'profiles', profiles, activeProfileId: config.activeProfileId })
  }

  /**
   * The live auth strategy, kept across turns.
   *
   * This must NOT be rebuilt per turn: the token cache, the proactive refresh timer, and
   * the single-flight guard all live inside the strategy instance, so a fresh one every
   * turn would mean a full mTLS handshake and a new `client_credentials` grant for every
   * user message — the caching in §10 would never engage at all.
   *
   * Keyed by profile id plus a fingerprint of the auth block, so editing credentials or
   * switching profiles discards the cached token instead of silently reusing a stale one.
   */
  let cachedAuth: { key: string; strategy: AuthStrategy } | undefined

  function authStrategyFor(config: LightCodeConfig, profile: ProviderProfile): AuthStrategy {
    const key = `${profile.id}|${profile.baseUrl}|${JSON.stringify(profile.auth)}|${config.certDir ?? ''}|${JSON.stringify(config.tls ?? {})}`
    const cached = cachedAuth
    if (cached !== undefined && cached.key === key) return cached.strategy

    const strategy = createAuthStrategy(profile.auth, buildAuthContext(config, profile))
    cachedAuth = { key, strategy }
    return strategy
  }

  /**
   * Assembles what core needs to build an auth strategy. Kept in one place so the chat
   * turn, the model list, and Test Connection all authenticate identically — a divergence
   * here would make "Test Connection passed but chat fails" possible, which would destroy
   * the whole point of that button (§10).
   */
  function buildAuthContext(
    config: LightCodeConfig,
    profile: ProviderProfile,
  ): AuthStrategyContext {
    return {
      secrets,
      http: httpClient,
      baseUrl: profile.baseUrl,
      wireFormat: profile.wireFormat,
      ...(profile.tls !== undefined ? { connectionTls: profile.tls } : {}),
      ...(config.tls !== undefined ? { globalTls: config.tls } : {}),
      ...(config.certDir !== undefined ? { defaultCertDir: config.certDir } : {}),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      // Invariant 6: whatever the loader actually read becomes unreadable to file tools.
      onCertPaths: (paths) => {
        void Promise.all(paths.map((certPath) => denylist.add(certPath))).catch(
          (error: unknown) => {
            logger.warn('could not add cert path to the deny list', String(error))
          },
        )
      },
      onExpiryWarning: (warning) => {
        if (warnedExpiries.has(warning.message)) return
        warnedExpiries.add(warning.message)
        ui.showWarning(warning.message)
      },
    }
  }

  /**
   * Values that must never reach a stored transcript, gathered from the secret store.
   *
   * `redact()`'s patterns catch `Bearer` tokens and `sk-`-style keys, but a corporate
   * gateway key often looks like neither. Passing the actual values means a tool result
   * that happens to echo one — a command printing an env var, a config file read back —
   * is caught by exact match rather than by hoping it matches a shape.
   */
  async function knownSecretValues(): Promise<string[]> {
    try {
      const { config } = await configManager.load()
      const refs = (config.profiles ?? []).flatMap((profile) =>
        SECRET_REFS_PER_PROFILE.map((refFor) => refFor(profile.id)),
      )
      /*
       * References a profile names directly, not just the ones this product wrote.
       *
       * An `env:` key never passes through the keychain, so deriving the list from
       * `SECRET_REFS_PER_PROFILE` alone would leave it out — and a token that redaction does not
       * know about is a token that reaches a transcript and a spilled tool result verbatim. The
       * whole point of keying redaction on exact values is defeated by not knowing one of them.
       */
      const named = (config.profiles ?? [])
        .map((profile) => (profile.auth.type === 'apiKey' ? profile.auth.apiKeyRef : undefined))
        .filter((ref): ref is string => ref !== undefined)
      const values = await Promise.all(
        [...new Set([...refs, ...named])].map((ref) => resolveSecretRef(ref, { secrets })),
      )
      cachedSecretValues = values.filter(
        (value): value is string => value !== undefined && value.length > 0,
      )
      return [...cachedSecretValues]
    } catch (error) {
      // Redaction must never be the reason a transcript fails to save; the pattern-based
      // rules still apply, so this degrades rather than disables.
      logger.warn('could not read secrets for redaction', String(error))
      return []
    }
  }

  /** Writes the current conversation. Called after every turn, not only at the end. */
  async function persistActiveTask(): Promise<void> {
    if (workspaceRoot === undefined || conversation.isEmpty()) return

    if (activeTaskId === undefined) {
      await setActiveTaskId(randomUUID())
      activeTaskCreatedAt = Date.now()
      truncationStore.startTask()
    }

    const messages = conversation.toArray()
    const task: Task = {
      id: activeTaskId as string,
      workspaceRoot,
      title: deriveTitle(messages),
      createdAt: activeTaskCreatedAt,
      updatedAt: Date.now(),
      messages,
      resultHandles: truncationStore.spilledHandles(),
      ...(activePlan !== undefined && activePlan.trim().length > 0 ? { plan: activePlan } : {}),
      ...(Object.keys(activePlanProgress).length > 0 ? { planProgress: activePlanProgress } : {}),
    }

    try {
      await taskStore.save(redactTask(task, await knownSecretValues()))
    } catch (error) {
      // A failed save must not take the conversation down with it — the user would lose
      // the turn they just had on top of the history they were already going to lose.
      logger.warn('could not save task history', String(error))
    }
  }

  async function postTasks(): Promise<void> {
    if (workspaceRoot === undefined) {
      post({ type: 'tasks', tasks: [], activeTaskId: undefined })
      return
    }
    post({ type: 'tasks', tasks: await taskStore.list(workspaceRoot), activeTaskId })
  }

  /**
   * Loads a stored task into the live conversation.
   *
   * `readFiles` is deliberately NOT restored. The read-before-edit constraint (§6) is
   * session-scoped on purpose: a resumed task must re-read a file before editing it,
   * because the file may have changed since the transcript was written. Restoring the set
   * would quietly weaken the invariant across a restart — the exact case where the
   * model's picture of the workspace is most likely to be stale.
   */
  async function openTask(id: string): Promise<void> {
    const task = await taskStore.load(id)
    if (task === undefined) {
      post({ type: 'error', message: 'That task could not be loaded — it may have been deleted.' })
      await postTasks()
      return
    }

    conversation.restore(task.messages)
    readFiles.clear()
    /*
     * Both reset on a task switch. The spend counter is explicitly "since this task was
     * opened", and the expert session belongs to the work it was about — resuming it for a
     * different task would pay to carry irrelevant history and would muddy the answers.
     */
    resetExpertSpend()
    taskCheckpoint = undefined
    activeTaskCreatedAt = task.createdAt
    truncationStore.startTask(task.resultHandles)
    /*
     * The plan comes back with the conversation it belongs to.
     *
     * Leaving the previous chat's plan in place would be the worst of both: the assistant bound by
     * something this conversation never agreed, and the user with no reason to suspect it.
     */
    activePlan = task.plan
    // Pruned on the way in as well as on the way out: a task saved before a plan was edited by
    // hand in the config file could otherwise restore progress for steps that no longer exist.
    activePlanProgress = pruneProgress(activePlan, task.planProgress)
    await setActiveTaskId(task.id)

    post({ type: 'taskRestored', taskId: task.id, entries: toTranscript(task.messages) })
    post({ type: 'plan', plan: activePlan ?? '' })
    postPlanProgress()
    await postTasks()
  }

  async function startNewTask(): Promise<void> {
    // The current task is already saved after each turn, so nothing needs flushing here.
    conversation.reset()
    readFiles.clear()
    resetExpertSpend()
    taskCheckpoint = undefined
    activeTaskCreatedAt = Date.now()
    truncationStore.startTask()
    // A new conversation is a new job. Carrying the last one's plan forward would silently
    // constrain work nobody had scoped yet.
    activePlan = undefined
    activePlanProgress = {}
    await setActiveTaskId(undefined)

    post({ type: 'taskRestored', taskId: undefined, entries: [] })
    post({ type: 'plan', plan: '' })
    postPlanProgress()
    await postTasks()
  }

  async function deleteTask(id: string): Promise<void> {
    // Cascades to the task's spilled tool results inside the store.
    await taskStore.delete(id)
    if (id === activeTaskId) await startNewTask()
    else await postTasks()
  }

  /** Restores the in-progress task when the panel loads, so a reload is not a data loss. */
  async function restoreActiveTaskOnLoad(): Promise<void> {
    if (activeTaskId === undefined) {
      post({ type: 'taskRestored', taskId: undefined, entries: [] })
      return
    }

    const task = await taskStore.load(activeTaskId)
    if (task === undefined || task.workspaceRoot !== workspaceRoot) {
      // Deleted behind our back, or the remembered id belongs to another workspace.
      await setActiveTaskId(undefined)
      post({ type: 'taskRestored', taskId: undefined, entries: [] })
      return
    }

    conversation.restore(task.messages)
    activeTaskCreatedAt = task.createdAt
    truncationStore.startTask(task.resultHandles)
    post({ type: 'taskRestored', taskId: task.id, entries: toTranscript(task.messages) })
  }

  async function handleSendMessage(
    text: string,
    images?: ImageAttachmentInput[],
    /**
     * Set when this turn is an unattended scheduled run.
     *
     * Threaded through the ordinary path rather than duplicated: a second turn
     * implementation would drift from this one, and the drift would be in the half nobody
     * watches run. What changes is the registry, the approval gate and a paragraph of
     * guidance — everything else about a scheduled turn is an ordinary turn.
     */
    schedule?: Schedule,
  ): Promise<void> {
    if (workspaceRoot === undefined) {
      post({
        type: 'error',
        message: 'Open a folder in VS Code before using Light Code — tools need a workspace root.',
      })
      return
    }

    activeAbortController = new AbortController()
    try {
      const config = await loadSettings()

      // Invariant 6: cert/key paths are unreadable by every file tool. Re-added each
      // turn so a config change takes effect without restarting the session.
      if (config.certDir !== undefined) await denylist.add(config.certDir)

      // Refresh before the turn, not after: tool results spill to disk *during* the turn,
      // and the spill path reads this synchronously. Populating it only at save time would
      // leave the very first turn's spilled output unredacted.
      await knownSecretValues()

      const profile = resolveActiveProfile(config)
      // The wire adapter is chosen per profile; auth composes with any of them (§10).
      const provider = createChatProvider(
        profile,
        httpClient,
        authStrategyFor(config, profile),
        logger,
      )
      const capabilities = resolveModelCapabilities(profile.model, profile.modelCapabilities)
      const expertCliInfo = await resolveExpert(config)
      const search = await resolveSearch(config)
      const embedder = await resolveEmbedder(config)
      const codebaseIndex = codebaseIndexName(config)
      const docsIndex = docsIndexName(config)
      /*
       * Mail may live somewhere else entirely — that is the point of `retrieval.stores.mail`.
       * Resolved only when mail indexing is on, so an install without it pays nothing.
       */
      const mailCollection = config.mail?.enabled === true ? mailCollectionName(config) : undefined
      const mailSearch = mailCollection === undefined ? undefined : await resolveMailSearch(config)
      // Listed once per turn so the tool description can name real indexes; a failure here
      // only costs the model that hint, never the tool.
      const searchIndexes =
        search?.opensearch !== undefined
          ? await search.opensearch
              .listIndexes()
              .then((list) => list.map((i) => i.name))
              .catch(() => [])
          : []

      // Rebuilt whenever the profile or expert availability changes, so the model can
      // answer "which model are you?" accurately and knows whether ask_expert exists.
      // A profile switch is a session boundary, so replacing the prefix here is free (§12).
      /*
       * Skills are loaded before the prompt is built and then left alone for the whole turn.
       * They sit at the front of the prompt, so a mid-turn change would invalidate the cache
       * prefix and everything after it — the same rule tool definitions follow (§12). A skill
       * written during a turn therefore appears at the next one, which is what write_skill
       * tells the model.
       */
      await refreshSkills()

      /*
       * Resolved once here and reused for the turn. The mode contributes both tool filtering
       * and system-prompt guidance, and those two must agree — a prompt telling the model to
       * consult an expert whose tool was filtered out would be worse than either alone.
       */
      const activeMode = findMode(config.modeId)
      // A scheduled run is nobody's junior: it has no expert budget and no one delegating to it.
      juniorTurnWithoutExpert = activeMode.id === 'junior' && schedule === undefined

      /*
       * Computed from the *full* registry so the run is told the names it actually has, and
       * before the prompt is built because it lands in the cached prefix like everything else.
       */
      const scheduledGuidance =
        schedule === undefined
          ? undefined
          : scheduledRunGuidance(
              schedule,
              filterToolsForSchedule(
                currentToolRegistry(undefined, undefined, undefined, undefined, false).list(),
                schedule,
              )
                .map((tool) => tool.name)
                .filter((name) => name !== 'attempt_completion'),
            )

      /*
       * A schedule names its skills instead of searching for them.
       *
       * Its tools are an allowlist the user ticked and may well not include `search_docs`, so
       * telling an unattended run that notes exist and to go and find them can leave it with
       * nothing to search with — and nobody is there to notice. Naming them up front is also
       * simply the better fit: a job that runs the same prompt every night knows in advance
       * which conventions apply, where a chat cannot.
       *
       * `allowedSkills` absent means all of them, so schedules written before this keep the
       * behaviour they had.
       */
      /*
       * A schedule can search for skills too, now that `search_docs` is always available to one
       * (see `ALWAYS_AVAILABLE_TO_SCHEDULES`). The earlier objection was that its allowlist might
       * not include the tool, leaving it told to search with nothing to search with.
       *
       * The exception is a schedule that **named** its skills. That selection is the user saying
       * which conventions apply to this job; listing them is honouring it, and making them
       * searchable instead would quietly reach past the choice.
       */
      const skillsSearchable =
        skillRetrievalEnabled(config.retrieval) &&
        (schedule === undefined || schedule.allowedSkills === undefined)
      const turnSkills =
        schedule === undefined ? skills : skillsForSchedule(skills, schedule.allowedSkills)

      const desiredPrompt = buildSystemPrompt(workspaceRoot, {
        model: profile.model,
        providerLabel: profile.label,
        expertAvailable: expertCliInfo !== undefined,
        // Named only when there is an index to prefer.
        mailIndexed: cachedMail.enabled === true && cachedOffice.outlook === true,
        // Counted here rather than in the prompt builder, which has no filesystem.
        datasets: datasetSummaryForPrompt,
        canWriteCollectors: cachedPythonEnabled,
        /*
         * Either the whole list or a count and an instruction to search — never both, and
         * never neither. `renderSkillsHintForPrompt` explains why the count stays.
         */
        /*
         * A skill marked `always` is included in full down both paths. Retrieval decides whether
         * the *other* skills are listed or searched for; it does not get to withhold a standing
         * instruction, which by definition has to be present before the model decides anything.
         */
        skills: skillsSearchable
          ? [
              renderAlwaysSkills(turnSkills),
              renderSkillsHintForPrompt(skills.filter((skill) => skill.always !== true).length),
            ]
              .filter((section) => section.length > 0)
              .join('\n\n')
          : renderSkillsForPrompt(turnSkills),
        skillsSearchable,
        canWriteSkills: skillsDir !== undefined,
        // Last in the prompt, and the most specific thing in it — see `agent/plan.ts`.
        ...(activePlan !== undefined && activePlan.trim().length > 0 ? { plan: activePlan } : {}),
        // Only when a pool actually exists: telling the model about a tool it has not been given
        // is how it comes to report that it looked somewhere it could not reach.
        teamSkillsAvailable: skillAliases(config).length > 0,
        /*
         * Read from config rather than from the registry, because the prompt is built before the
         * registry is. Only the *off* case is claimed: "on but uv is missing" leaves the model
         * equally toolless, but the Python tab reports that with the actual reason, and telling
         * the user to switch on something already switched on would be worse than saying nothing.
         */
        pythonToolsDisabled: config.python?.dynamicTools !== 'on',
        // And the other half. Saying the capability exists is what stops "create a tool" being
        // answered with an ordinary file the model happened to have a tool for.
        pythonToolsAvailable: config.python?.dynamicTools === 'on',
        /*
         * Junior mode's instructions are worse than useless without the expert to delegate
         * to: the model would be told to consult something it has no tool for. The picker
         * disables the mode in that case, but config can still name it, so it is checked
         * here too.
         */
        ...(() => {
          const parts: string[] = []
          /*
           * Agent team builds its instruction from the configured team rather than carrying a
           * fixed one, so it names the roles that exist on *this* machine. A model told to
           * consult a reviewer nobody assigned spends a step being refused and then trusts the
           * rest of the instruction less.
           */
          if (activeMode.id === AGENT_TEAM_MODE.id) {
            parts.push(
              buildTeamGuidance(
                // The whole team, not only the available ones: the roster names what is missing
                // as well as what is there, and it cannot do that from a pre-filtered list.
                cachedTeam,
                cachedTeamGuidance,
                cachedBudgetMatters,
                /*
                 * Whether a plan already exists, which decides whether this mode is told to go
                 * and make one. Passed rather than inferred from the prompt: the plan section is
                 * assembled separately, and a mode guessing at whether it is there would be a
                 * second reading of the same fact.
                 */
                activePlan !== undefined && activePlan.trim().length > 0,
              ),
            )
          } else if (
            activeMode.guidance !== undefined &&
            (activeMode.requiresExpert !== true || expertCliInfo !== undefined)
          ) {
            parts.push(activeMode.guidance)
          }
          if (scheduledGuidance !== undefined) parts.push(scheduledGuidance)
          return parts.length > 0 ? { modeGuidance: parts.join('\n\n') } : {}
        })(),
      })
      if (conversation.systemPrompt() !== desiredPrompt) conversation.setSystemPrompt(desiredPrompt)

      // Lazy connect (§11): a configured-but-unused server costs nothing until a turn
      // actually needs its tools. Failures are per-server and surface in the MCP tab.
      await syncMcpFromConfig(config)
      await mcp.ensureConnected()
      await python.configure({ ...(config.python ?? {}), extraToolDirs: mirroredToolsDirs })

      const toolContext: ToolExecutionContext = {
        fs: new NodeFileSystem(),
        terminal: new NodeTerminal(),
        workspaceRoot,
        denylist,
        readFiles,
        readRoots: cachedReadRoots,
        // Resolved per turn by the host, so an edit applies to the next command rather than
        // needing a new session. Absent in the extension, where there is nothing to resolve.
        ...(services.sessionEnv !== undefined ? { sessionEnv: services.sessionEnv() } : {}),
        /*
         * Omitted for a scheduled run: there is nobody to answer, and a run that could grant
         * itself new filesystem access would defeat the point of its allowlist.
         */
        ...(schedule === undefined ? { requestPathAccess } : {}),
        // Also withheld from a scheduled run: nobody is there to fill a form in, and a job
        // that stops to wait for one would never finish.
        ...(schedule === undefined ? { requestForm } : {}),
        signal: activeAbortController.signal,
        /*
          * Supplied by the host, not imported by core: the binary is platform-specific and
          * lives in the VSIX, so resolving it is a host concern (§4).
          *
          * Asked per turn rather than captured once, because a VS Code extension update
          * deletes the folder the previous answer pointed into. See `HostServices`.
          */
        ...((): { ripgrepPath?: string } => {
          const resolved = services.ripgrepPath()
          return resolved !== undefined ? { ripgrepPath: resolved } : {}
        })(),
      }

      /*
       * Captured for a consultation's own lookups.
       *
       * The turn's context, not a second one: confinement, the deny list and the workspace root
       * are then exactly what the assistant has, rather than a parallel set of rules that could
       * drift looser without anybody noticing.
       */
      consultationContext = () => toolContext

      /*
       * Published for the duration of the turn, so a Python tool's nested call runs against this
       * turn rather than a stale one. Cleared in the same `finally` that restores everything else.
       */
      pythonNestedContext = toolContext
      pythonNestedCallsAllowed = schedule === undefined

      // `@`-mentions are resolved here, not by the model: the user named these paths
      // explicitly, so there is nothing to decide and nothing to approve. Confinement and
      // the deny list still apply, since the path is user-typed text.
      const mentions = await resolveMentions(text, { fs: toolContext.fs, workspaceRoot, denylist })
      /*
       * `#role` is resolved here for the same reason `@path` is: the user named the specialist,
       * so there is nothing for the model to decide. Left to guidance it would be a suggestion
       * weighed against the model's own judgement about whether a consultation earns its round
       * trip — and typing the name *is* that judgement, already made by the person making it.
       *
       * Available roles only. One addressed at a specialist nobody assigned is reported rather
       * than ignored, or the message simply does nothing unusual and the feature reads as broken.
       */
      const directed = findDirectedRoles(text, cachedTeam)
      const direction = describeDirectedRoles(directed, cachedTeam)
      const messageText =
        direction.length > 0
          ? `${attachMentions(text, mentions)}\n\n${direction}`
          : attachMentions(text, mentions)

      const turnOptions: RunAgentTurnOptions = {
        signal: activeAbortController.signal,
        truncationStore,
        approvalGate,
        // Resolved once per turn, so the tool definitions stay byte-stable for the whole
        // loop — swapping them mid-turn would break the prompt cache prefix (§12).
        mode: activeMode,
        contextWindow: capabilities.contextWindow,
        // CLAUDE.md §5 has called this configurable since Phase 0; until now it was not.
        maxIterations: cachedMaxIterations,
        drainQueuedMessages: () => {
          if (queuedMessages.length === 0) return []
          const drained = queuedMessages
          queuedMessages = []
          postQueued()
          /*
           * Attachments come through, and the same vision gate applies as on the main path.
           *
           * Without the gate a queued screenshot would be handed to a text-only model, which
           * fails or is ignored somewhere much further along — the backstop above exists because
           * that looks exactly like the model disregarding what it was shown.
           */
          return drained.map((entry) => {
            const attachments = entry.images ?? []
            if (attachments.length === 0) return { text: entry.text }
            if (!capabilities.supportsVision) {
              post({
                type: 'error',
                message: `${profile.model} does not accept images. The attachment on a queued message was not sent — set "Supports images" in the profile's advanced settings if that is wrong.`,
              })
              return { text: entry.text }
            }
            return {
              text: entry.text,
              images: attachments.map((image) => ({
                mediaType: image.mediaType,
                data: image.data,
              })),
            }
          })
        },
      }
      // Silently dropping an image on a text-only model would look like the model ignoring
      // it; the composer already hides attachment, so this is the backstop.
      if (images !== undefined && images.length > 0 && capabilities.supportsVision) {
        turnOptions.images = images.map((image) => ({
          mediaType: image.mediaType,
          data: image.data,
        }))
      } else if (images !== undefined && images.length > 0) {
        post({
          type: 'error',
          message: `${profile.model} does not accept images. Attachments were not sent — set "Supports images" in the profile's advanced settings if that is wrong.`,
        })
      }
      // Checkpoints degrade to unavailable rather than blocking the session when git
      // isn't installed — but edits then proceed with no rollback point, so say so.
      if (shadowGit !== undefined && (await ShadowGit.isGitAvailable())) {
        turnOptions.shadowGit = shadowGit
      } else {
        logger.warn('git not found on PATH — edits will proceed without a rollback checkpoint')
      }

      // Send cumulative text, not the delta — webview `postMessage` delivery isn't
      // guaranteed, and this makes each message self-correcting rather than letting
      // one dropped delta permanently corrupt everything streamed after it.
      let cumulativeText = ''
      let cumulativeReasoning = ''
      // Sticky once the expert has been consulted, matching how a restored transcript is
      // derived — so the live view and a reopened task mark the same work.
      /*
       * The specialist, not a boolean.
       *
       * It was `expertInformed = true`, all there was to say when there was one expert. With five,
       * the chat names and colours whoever actually answered — and deriving the flag from this,
       * rather than tracking both, is what stops the two disagreeing.
       */
      let informedBy: string | undefined
      const fullRegistry = currentToolRegistry(
        expertCliInfo !== undefined
          ? {
              cli: expertCliInfo,
              ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}),
            }
          : undefined,
        search?.opensearch !== undefined
          ? { client: search.opensearch, store: search.store, indexes: searchIndexes }
          : undefined,
        /*
         * Only when all three exist. Resolved once per turn like everything else feeding
         * the prefix, so the tool block stays byte-stable for the whole loop (§12).
         */
        search !== undefined && embedder !== undefined && codebaseIndex !== undefined
          ? {
              searcher: search.searcher,
              embedder,
              index: codebaseIndex,
              connectionLabel: search.store.label,
              /*
               * The team alias and this machine's identity, so `scope: "team"` has somewhere
               * to look and every hit can say whose it is. Both absent on a solo install,
               * where team scope is simply unavailable and says so.
               */
              ...(codebaseAliases(config).length > 0
                ? { teamAliases: codebaseAliases(config) }
                : {}),
              ...(indexOwner(config) !== undefined ? { owner: indexOwner(config) as string } : {}),
            }
          : undefined,
        /*
         * Retrieval for `search_docs`. Absent leaves it matching lexically over the live
         * registry, which is deliberately still useful — the dispatcher must not depend on
         * a vector store existing, or turning it on without one would hide every MCP tool
         * behind a search that could never find them.
         */
        search !== undefined && embedder !== undefined && docsIndex !== undefined
          ? { searcher: search.searcher, embedder, index: docsIndex }
          : undefined,
        dispatcherEnabled(config.retrieval),
        skillsSearchable,
        /*
         * The team's shared skills. Needs an alias, a connection and an embedder — without
         * all three there is nothing to search, and the tool is simply not offered.
         */
        skillAliases(config).length > 0 && search !== undefined && embedder !== undefined
          ? {
              searcher: search.searcher,
              embedder,
              /*
               * All of them, in order — the first is the ordinary circle and the rest are what a
               * search widens into when it holds nothing. Handing over only the first is what
               * made the extra names typed in the panel do nothing at all for skills.
               */
              collections: skillAliases(config),
              ...(indexOwner(config) !== undefined ? { owner: indexOwner(config) as string } : {}),
            }
          : undefined,
        /*
         * Mail ranking. Resolved against whichever store `retrieval.stores.mail` names, which
         * is frequently a local Qdrant while the code goes to a shared cluster — mail is the
         * corpus people most want kept off a team's infrastructure.
         */
        mailCollection !== undefined && mailSearch !== undefined && embedder !== undefined
          ? { searcher: mailSearch.searcher, embedder, collection: mailCollection }
          : undefined,
        /*
         * Datasets share one collection, resolved against whichever store `retrieval.stores.data`
         * names — the same per-corpus routing §12e added, for the same reason: somebody's own
         * collected data is frequently the corpus they most want kept off a shared cluster.
         */
        await (async () => {
          const collection = datasetCollectionName(config)
          const search = await resolveDatasetSearch(config)
          return collection !== undefined && search !== undefined && embedder !== undefined
            ? { searcher: search.searcher, embedder, collection }
            : undefined
        })(),
      )

      /*
       * The security boundary for an unattended run is the *registry*, not the approval gate.
       * A tool the schedule did not name is never registered, so it never reaches the system
       * prompt and the model is never told it exists — the same layering §11 uses for disabled
       * MCP tools. The gate below is a second line of defence, not the first.
       */
      const turnRegistry =
        schedule !== undefined ? registryForSchedule(fullRegistry.list(), schedule) : fullRegistry
      turnOptions.timeoutForTool = toolTimeout
      if (schedule !== undefined) {
        turnOptions.approvalGate = new ScheduledApprovalGate(schedule)
        /*
         * Derived from the registry the run actually gets, not from `allowedTools` — so what
         * `search_docs` reports as callable is by construction the same set the gate will let
         * through. Two lists here would be two lists to keep in step, which is the bug shape
         * this project has paid for most often.
         */
        const granted = new Set(turnRegistry.list().map((tool) => tool.name))
        scheduleToolAccess = (name) => granted.has(name)
      }

      await runAgentTurn(
        provider,
        conversation,
        messageText,
        turnRegistry,
        toolContext,
        {
          onContextUpdate: (breakdown, supersededCount, compactedCount) => {
            post({ type: 'contextUsage', usage: { ...breakdown, supersededCount, compactedCount } })
          },
          onCompacted: (summarisedCount) => post({ type: 'compacted', summarisedCount }),
          onNudgedToContinue: () => {
            // Logged, not shown. The transcript already reads correctly — the preamble, then the
            // tool call it should have made — and a banner between them would explain a seam the
            // user cannot otherwise see. It belongs in the log, where a model doing this every
            // turn becomes visible as a pattern.
            logger.warn(
              'the model described an action without calling a tool; asked it to continue',
            )
          },
          onQueuedMessageConsumed: (text) => {
            // Shown as an ordinary user turn: that is exactly what it became in the
            // conversation, and a restored transcript will render it the same way.
            post({ type: 'queuedMessageConsumed', text })
            // The assistant text that follows belongs to a new step.
            cumulativeText = ''
          },
          onTextChunk: (chunk) => {
            cumulativeText += chunk
            post({
              type: 'textChunk',
              text: cumulativeText,
              ...(informedBy !== undefined ? { expertInformed: true, informedBy } : {}),
            })
          },
          onReasoningChunk: (chunk) => {
            cumulativeReasoning += chunk
            post({ type: 'reasoningChunk', text: cumulativeReasoning })
          },
          onToolCall: (toolCall) => {
            // Each tool call starts a fresh assistant text block in the transcript.
            cumulativeText = ''
            cumulativeReasoning = ''
            /*
             * One owner for "is this a consultation, and by whom" — the same function the
             * transcript uses. Deciding it separately here is exactly how a chart drawn during a
             * turn came to render as nothing: the transcript derived it and the live path did not.
             */
            const consulting = consultationFromToolCall(toolCall.name, toolCall.arguments)
            if (consulting !== undefined) {
              informedBy = consulting
              /*
               * Who contributed to the step being worked, recorded from a consultation that
               * genuinely happened rather than from the model naming a role.
               *
               * The assistant says *which* step it is on; it does not get to say who helped with
               * it. That split is deliberate — the panel colours a checkpoint by role, and a
               * colour is read as a fact about who did the work. The same reasoning as
               * `search_codebase` testing the filesystem rather than trusting the owner field:
               * report the ground truth, not the description of it.
               */
              const attributed = attributeConsultation(activePlanProgress, consulting)
              if (attributed !== activePlanProgress) {
                activePlanProgress = attributed
                postPlanProgress()
              }
            }
            if (CONTROL_TOOLS.has(toolCall.name)) return
            /*
             * A chart is not a tool block. It is posted on the result instead, so nothing
             * collapsed appears in its place while it runs.
             *
             * The decision comes from `chartFromToolCall`, which the transcript also uses. It used
             * to be made only there, so a chart drawn mid-conversation showed as a collapsed
             * "show_chart ran" — as nothing — and became a picture only after a reload.
             */
            if (chartFromToolCall(toolCall.name, toolCall.arguments) !== undefined) return
            if (diagramFromToolCall(toolCall.name, toolCall.arguments) !== undefined) return
            const summary = toolCallSummary(toolCall)
            post({
              type: 'toolCall',
              toolCall: summary,
              ...(informedBy !== undefined ? { expertInformed: true, informedBy } : {}),
            })
          },
          onToolResult: (toolCall, result) => {
            // The control tools aren't work being done — they're the model addressing the
            // user. Their content is the answer, so render it as a message rather than
            // something the user has to expand a collapsed block to read.
            if (CONTROL_TOOLS.has(toolCall.name)) {
              post({ type: 'textChunk', text: result.content })
              return
            }
            const diagram = diagramFromToolCall(toolCall.name, toolCall.arguments)
            if (diagram !== undefined) {
              post(
                diagram.kind === 'diagram'
                  ? {
                      type: 'diagram',
                      diagram: diagram.diagram,
                      ...(informedBy !== undefined ? { expertInformed: true, informedBy } : {}),
                    }
                  : { type: 'diagramError', message: diagram.message },
              )
              return
            }
            const chart = chartFromToolCall(toolCall.name, toolCall.arguments)
            if (chart !== undefined) {
              post(
                chart.kind === 'chart'
                  ? {
                      type: 'chart',
                      chart: chart.chart,
                      ...(informedBy !== undefined ? { expertInformed: true, informedBy } : {}),
                    }
                  : { type: 'chartError', message: chart.message },
              )
              return
            }
            /*
             * The same builder the call used.
             *
             * This one was written out separately and omitted `consultingRole`, so a consultation
             * wore the specialist's colour while it ran and reverted to the expert's the moment it
             * finished — exactly what was reported. One builder, so there is nothing to forget.
             */
            const summary = toolCallSummary(toolCall, {
              result: result.content,
              ...(result.isError === true ? { isError: true } : {}),
            })
            post({
              type: 'toolResult',
              toolCall: summary,
              ...(informedBy !== undefined ? { expertInformed: true, informedBy } : {}),
            })
          },
          onCheckpoint: (checkpoint) => {
            taskCheckpoint = checkpoint
            post({ type: 'checkpointAvailable' })
          },
          onDone: () => post({ type: 'done' }),
          onError: (message) => post({ type: 'error', message }),
        },
        turnOptions,
      )
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      // Never leave the loop parked on an approval that can no longer be answered.
      userGate.denyAll()
      settleAllForms()
      activeAbortController = undefined
      // Cleared before anything else awaits, like the rest of a scheduled run's state: leaving
      // it set would make the next chat turn report its own tools as forbidden.
      scheduleToolAccess = undefined

      /*
       * A Junior-mode turn the expert never saw.
       *
       * Recorded per *turn*, because a turn is the unit a consultation would have replaced.
       * Counting tool calls would inflate the figure by however chatty the task happened to be,
       * and the number is only worth showing while it is a floor nobody can argue with.
       *
       * Recorded even when the turn failed: a turn the cheap model attempted is still a turn the
       * expert was not paid for.
       */
      if (juniorTurnWithoutExpert) {
        appendExpertEvent({ at: Date.now(), kind: 'juniorTurn' })
        juniorTurnWithoutExpert = false
      }
      // Save in `finally`, so a cancelled or errored turn is still persisted. A turn that
      // failed halfway is exactly the one the user most wants to see again afterwards.
      await persistActiveTask()
      await postTasks()

      // Whatever did not get folded in — a turn that ended before reaching a boundary —
      // starts the next turn rather than being silently dropped.
      if (queuedMessages.length > 0 && activeAbortController === undefined) {
        /*
         * Folded into one message, attachments included.
         *
         * Joining the text and dropping the images would lose exactly what this fix is about, and
         * on this path the loss would be harder to notice: it happens when a turn ended early, so
         * there is no visible seam where the picture went missing.
         */
        const next = queuedMessages.map((entry) => entry.text).join('\n\n')
        const images = queuedMessages.flatMap((entry) => entry.images ?? [])
        queuedMessages = []
        postQueued()
        void handleSendMessage(next, images.length > 0 ? images : undefined)
      }
    }
  }

  /**
   * Writes any newly-typed secrets and returns the `Auth` block that references them.
   *
   * The write-only rule (invariant 7) means an empty secret field is ambiguous — "unchanged"
   * or "never set" — so it is resolved by asking the store, never by trusting config. A
   * config that claims a ref the store doesn't have is exactly the dangling-reference bug
   * that made a profile permanently unusable with no way to fix it from the UI.
   */
  async function buildAuthFromInput(input: ProfileInput, id: string): Promise<Auth> {
    /** Stores a newly-typed secret, or reports whether a usable one is already there. */
    async function persistSecret(ref: string, typed: string | undefined): Promise<boolean> {
      const value = typed?.trim() ?? ''
      if (value.length > 0) {
        await secrets.set(ref, value)
        return true
      }
      return (await secrets.get(ref)) !== undefined
    }

    if (input.authType === 'apigeeMtls') {
      const hasClientSecret = await persistSecret(clientSecretRefFor(id), input.clientSecret)
      const hasPassphrase = await persistSecret(certPassphraseRefFor(id), input.certPassphrase)
      // Switching a profile to mTLS retires its API key rather than leaving it in the
      // keychain — §10 is explicit that the two must never both be live.
      await secrets.delete(apiKeyRefFor(id))

      const certs = input.certs ?? {}
      return {
        type: 'apigeeMtls',
        certs: {
          ...stripEmpty(certs),
          ...(hasPassphrase ? { passphraseRef: certPassphraseRefFor(id) } : {}),
        },
        apigee: {
          ...stripEmpty(input.apigee ?? {}),
          ...(hasClientSecret ? { clientSecretRef: clientSecretRefFor(id) } : {}),
        },
      }
    }

    /*
     * A token command is never built from the form, only preserved.
     *
     * The panel has no way to express one, so a save from a profile that uses it would otherwise
     * silently replace it with `none` — the profile would keep working until the token expired and
     * then fail in a way nobody would connect to having opened Settings.
     */
    if (input.authType === 'header') {
      const headers = (input.authHeaders ?? [])
        .map((header) => ({
          name: header.name.trim(),
          valueRef: header.valueRef.trim(),
          ...(header.prefix !== undefined && header.prefix.length > 0
            ? { prefix: header.prefix }
            : {}),
        }))
        .filter((header) => header.name.length > 0 && header.valueRef.length > 0)
      /*
       * A value typed in the form is written to the secret store and replaced by a reference.
       *
       * `env:` references are kept as they are, because that is the whole point of them — the
       * credential stays wherever the launcher put it. Anything else is a literal somebody typed,
       * and a literal must never reach the config file (§15).
       */
      const stored = await Promise.all(
        headers.map(async (header, index) => {
          if (describeSecretRef(header.valueRef).kind === 'env') return header
          const ref = `profile:${id}:header:${String(index)}`
          await secrets.set(ref, header.valueRef)
          return { ...header, valueRef: ref }
        }),
      )
      return stored.length > 0 ? { type: 'header', headers: stored } : { type: 'none' }
    }

    if (input.authType === 'tokenCommand') {
      // Refused before anything is written, so a restricted session cannot leave a half-saved
      // profile behind — and told why, rather than silently dropping to `none`.
      if (services.executableAuthRefusal !== undefined)
        throw new Error(services.executableAuthRefusal)
      const existing = (await configManager.load()).config.profiles?.find(
        (profile) => profile.id === id,
      )
      if (input.tokenCommand === undefined || input.tokenCommand.command.length === 0) {
        // Nothing sent means the form did not edit it — keep what is there rather than replacing a
        // working credential with `none`, which would fail only once the current token expired.
        return existing?.auth.type === 'tokenCommand' ? existing.auth : { type: 'none' }
      }
      return {
        type: 'tokenCommand',
        tokenCommand: {
          ...input.tokenCommand,
          command: input.tokenCommand.command.filter((part) => part.trim().length > 0),
        },
      }
    }

    if (input.authType === 'none') return { type: 'none' }

    /*
     * `env:API_TOKEN` is stored as the reference itself, and nothing is written to the keychain.
     *
     * That is the point: the credential stays wherever the launcher put it, so it can rotate
     * without Light Code holding a stale copy — and there is no second place for it to leak from.
     * A stored key for the same profile is deleted, because leaving one behind means the profile
     * has two credentials and only one of them is the one being used.
     */
    /*
     * The fall-through branch, which is `apiKey` auth — and which an *unrecognised* `authType`
     * also lands in. That is where `Cannot read properties of undefined (reading 'trim')` came
     * from: a message with no `authType` at all reached here and dereferenced a key nobody sent.
     *
     * Absent is read as "no key typed", which is already a case this handles — it means keep the
     * stored one, or none. Failing here instead would refuse a profile over a field the user was
     * not asked about.
     */
    const typed = (input.apiKey ?? '').trim()
    if (describeSecretRef(typed).kind === 'env') {
      await secrets.delete(apiKeyRefFor(id))
      return { type: 'apiKey', apiKeyRef: typed }
    }
    const existing = (await configManager.load()).config.profiles?.find(
      (profile) => profile.id === id,
    )
    if (
      typed.length === 0 &&
      existing?.auth.type === 'apiKey' &&
      describeSecretRef(existing.auth.apiKeyRef).kind === 'env'
    ) {
      // Blank means "leave it as it is", exactly as it does for a stored key.
      return existing.auth
    }

    const apiKeyRef = apiKeyRefFor(id)
    if (await persistSecret(apiKeyRef, input.apiKey)) {
      return { type: 'apiKey', apiKeyRef }
    }
    // No key typed and none stored — `none` rather than a reference to a secret that was
    // never written, which is the dangling-ref case described above.
    return { type: 'none' }
  }

  async function handleSaveProfile(input: ProfileInput): Promise<void> {
    const fieldErrors = validateProviderForm({
      label: input.label,
      wireFormat: input.wireFormat,
      baseUrl: input.baseUrl,
      model: input.model,
    })
    if (fieldErrors.length > 0) {
      post({ type: 'error', message: fieldErrors.map((e) => `${e.path}: ${e.message}`).join('; ') })
      return
    }

    // Invariant 6, checked **at config time** rather than only when a handshake is
    // attempted (§10). Rejecting the save is what stops the bad path from ever existing;
    // catching it later would mean key material already sat inside the workspace.
    const certDir = input.certs?.certDir
    if (input.authType === 'apigeeMtls' && certDir !== undefined && certDir.trim().length > 0) {
      try {
        assertCertDirOutsideWorkspace(certDir.trim(), workspaceRoot)
      } catch (error) {
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        return
      }
    }

    try {
      const { config } = await configManager.load()
      const profiles = config.profiles ?? []
      const id = input.id ?? randomUUID()
      const existing = profiles.find((p) => p.id === id)

      const auth = await buildAuthFromInput(input, id)

      const saved: ProviderProfile = {
        id,
        label: input.label.trim(),
        wireFormat: input.wireFormat,
        baseUrl: input.baseUrl.trim(),
        model: input.model.trim(),
        auth,
      }
      if (input.modelCapabilities !== undefined) saved.modelCapabilities = input.modelCapabilities
      // Absent stays absent: sending nothing is the only setting that cannot break a gateway
      // nobody has tested against, so an untouched profile keeps behaving exactly as before.
      if (input.thinking !== undefined) saved.thinking = input.thinking
      const connectionTls = stripEmpty(input.connectionTls ?? {})
      if (Object.keys(connectionTls).length > 0) saved.tls = connectionTls

      const nextProfiles = existing
        ? profiles.map((p) => (p.id === id ? saved : p))
        : [...profiles, saved]
      // The very first profile ever created becomes active automatically.
      const activeProfileId = config.activeProfileId ?? (nextProfiles.length === 1 ? id : undefined)
      await configManager.save('user', { profiles: nextProfiles, activeProfileId })
      // The cache key can't see a *rotated* secret — the ref is unchanged — so any save
      // drops the cached strategy rather than leaving a token minted from the old one.
      cachedAuth = undefined

      post({ type: 'profileSaved' })
      await postProfiles()
      // The Agents tab lists these as the models a role can be given, so it goes stale the moment
      // the list changes — a provider added and then not offered reads as the tab being broken.
      await postAgents()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDuplicateProfile(id: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const profiles = config.profiles ?? []
      const source = profiles.find((p) => p.id === id)
      if (source === undefined) {
        post({ type: 'error', message: `Profile "${id}" no longer exists.` })
        return
      }

      const newId = randomUUID()

      /** Copies a secret under the new profile's namespace; false when there was none. */
      async function copySecret(fromRef: string | undefined, toRef: string): Promise<boolean> {
        if (fromRef === undefined) return false
        const value = await secrets.get(fromRef)
        if (value === undefined) return false
        await secrets.set(toRef, value)
        return true
      }

      let auth: Auth = { type: 'none' }
      if (source.auth.type === 'apiKey') {
        // If the source secret is missing there's nothing to copy — leave the duplicate
        // as `none` rather than pointing it at a secret that was never written.
        if (await copySecret(source.auth.apiKeyRef, apiKeyRefFor(newId))) {
          auth = { type: 'apiKey', apiKeyRef: apiKeyRefFor(newId) }
        }
      } else if (source.auth.type === 'apigeeMtls') {
        const { clientSecretRef, ...apigee } = source.auth.apigee
        const { passphraseRef, ...certs } = source.auth.certs
        const copiedSecret = await copySecret(clientSecretRef, clientSecretRefFor(newId))
        const copiedPassphrase = await copySecret(passphraseRef, certPassphraseRefFor(newId))
        auth = {
          type: 'apigeeMtls',
          certs: {
            ...certs,
            ...(copiedPassphrase ? { passphraseRef: certPassphraseRefFor(newId) } : {}),
          },
          apigee: {
            ...apigee,
            ...(copiedSecret ? { clientSecretRef: clientSecretRefFor(newId) } : {}),
          },
        }
      }

      const duplicate: ProviderProfile = {
        ...source,
        id: newId,
        label: `${source.label} (copy)`,
        auth,
      }
      await configManager.save('user', { profiles: [...profiles, duplicate] })
      await postProfiles()
      // The Agents tab lists these as the models a role can be given, so it goes stale the moment
      // the list changes — a provider added and then not offered reads as the tab being broken.
      await postAgents()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeleteProfile(id: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const profiles = config.profiles ?? []
      const remaining = profiles.filter((p) => p.id !== id)

      // Every secret this profile could own, not just the one its current auth type uses —
      // a profile switched from apiKey to mTLS would otherwise leave an orphan behind (§15).
      for (const refFor of SECRET_REFS_PER_PROFILE) await secrets.delete(refFor(id))

      const activeProfileId =
        config.activeProfileId === id ? remaining[0]?.id : config.activeProfileId
      await configManager.save('user', { profiles: remaining, activeProfileId })
      await postProfiles()
      // The Agents tab lists these as the models a role can be given, so it goes stale the moment
      // the list changes — a provider added and then not offered reads as the tab being broken.
      await postAgents()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleSetActiveProfile(id: string, forProject?: boolean): Promise<void> {
    try {
      const { config } = await configManager.load()
      const exists = (config.profiles ?? []).some((p) => p.id === id)
      if (!exists) {
        post({ type: 'error', message: `Profile "${id}" no longer exists.` })
        return
      }
      if (forProject === true) await configManager.saveForWorkspace({ activeProfileId: id })
      else await configManager.save('user', { activeProfileId: id })
      await postProjectSettings()
      await postProfiles()
      // The Agents tab lists these as the models a role can be given, so it goes stale the moment
      // the list changes — a provider added and then not offered reads as the tab being broken.
      await postAgents()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Builds a throwaway profile from whatever is currently in the form, so Refresh Models
   * and Test Connection work before the profile is saved. Secrets are read from the store
   * under the form's profile id; a not-yet-saved profile therefore tests only what it can.
   */
  async function profileFromForm(
    input: ProfileInput,
  ): Promise<{ profile: ProviderProfile; auth: Auth } | undefined> {
    /*
     * The shape is checked rather than assumed, even though the type says it is fine.
     *
     * `ProfileInput` describes what the *panel* sends; what arrives is whatever was posted to
     * `/api/message`, which on the Node host is anything that can reach the port with a session
     * token. A payload missing a field produced `Cannot read properties of undefined (reading
     * 'trim')` — caught and shown, so nothing broke, but it names no field and suggests no fix,
     * which §17 says an error must do.
     *
     * Through `validateProviderForm`, which is what `handleSaveProfile` already uses and what the
     * form itself uses: one owner of "is this a usable profile", so a hand-posted message and a
     * mistyped field fail identically. Refresh Models and Test Connection had no check at all
     * before this — only saving did.
     */
    const fieldErrors = validateProviderForm({
      label: input.label,
      wireFormat: input.wireFormat,
      baseUrl: input.baseUrl,
      model: input.model,
    })
    if (fieldErrors.length > 0) {
      post({
        type: 'error',
        message: fieldErrors.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      })
      return undefined
    }

    const baseUrl = input.baseUrl.trim()
    if (baseUrl.length === 0) {
      post({ type: 'error', message: 'Enter a base URL first.' })
      return undefined
    }

    const id = input.id ?? '__unsaved__'
    // Deliberately writes any typed secret to the store before testing: otherwise a first
    // Test Connection on a new profile could never succeed, which is when it matters most.
    const auth = await buildAuthFromInput(input, id)
    const profile: ProviderProfile = {
      id,
      label: input.label.trim().length > 0 ? input.label.trim() : 'Untitled',
      wireFormat: input.wireFormat,
      baseUrl,
      model: input.model.trim().length > 0 ? input.model.trim() : 'unset',
      auth,
      ...(input.connectionTls !== undefined ? { tls: stripEmpty(input.connectionTls) } : {}),
    }
    return { profile, auth }
  }

  /**
   * Workspace files matching an `@` query, for composer autocomplete.
   *
   * Uses VS Code's own file index rather than walking the tree: it already respects
   * `files.exclude` and `search.exclude`, so `node_modules` never appears, and it stays
   * fast in a large repository where a manual walk would not.
   */
  async function handleMentionCandidates(query: string): Promise<void> {
    if (workspaceRoot === undefined) {
      post({ type: 'mentionCandidates', query, paths: [] })
      return
    }
    try {
      /*
       * Fetch widely, then rank, then cut.
       *
       * The limit used to be the same 30 the list shows, and a file index returns matches in
       * its own order — so in any real repository the thirty that came back were an arbitrary
       * thirty, and the file being typed was often not among them. That is "it is not scanning
       * the codebase properly": the search was fine, the truncation was doing the choosing.
       *
       * The wider fetch is capped too, because `@` runs on every keystroke.
       */
      /*
       * The glob asks about the **last path segment only**, and the ranking then judges the
       * whole path.
       *
       * `*` does not cross a separator, so `**\/*src/api*` — the obvious pattern for someone
       * typing `src/api` — matches almost nothing, and the picker went empty exactly when the
       * user was being *more* specific. Globbing one segment is something globs do reliably;
       * everything else is a comparison, and comparisons belong in code where they can be
       * tested.
       */
      const segment = query.slice(query.lastIndexOf('/') + 1)
      const pattern = segment.length > 0 ? `**/*${segment}*` : '**/*'
      const found = await ui.findFiles(
        pattern,
        MENTION_SCAN_LIMIT,
        mentionExcludes(cachedMentionExcludes),
      )
      const paths = found
        .map((absolute) => path.relative(workspaceRoot, absolute).split(path.sep).join('/'))
        .filter(matchesMentionQuery(query))
        .sort(compareMentionCandidates(query))
        .slice(0, MENTION_RESULT_LIMIT)
      post({ type: 'mentionCandidates', query, paths })
    } catch (error) {
      logger.warn('mention lookup failed', String(error))
      post({ type: 'mentionCandidates', query, paths: [] })
    }
  }

  /**
   * Reports the expert's state. Detection runs even when disabled, so the tab can say
   * "found, not enabled" rather than leaving the user guessing whether the path is wrong.
   */
  /**
   * Reports the expert's state — always, including when working it out fails.
   *
   * Every caller used to be `void postExpert()`, so a rejection anywhere in here vanished: no
   * message, no log, and a settings tab stuck on "Checking…" for the life of the session. An
   * answer the user can act on beats silence, even when the answer is "this went wrong".
   */
  async function postExpert(options: { redetect?: boolean } = {}): Promise<void> {
    try {
      await postExpertInner(options.redetect !== false)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`could not check the expert CLI: ${reason}`)
      /*
       * A failed *detection* must not report the rest of the settings as gone.
       *
       * This used to post `enabled: false` with no assessment, which is a claim about
       * configuration rather than about the probe that failed — and it wiped whatever the tab
       * was showing. Losing a freshly finished assessment that way is exactly the reported
       * bug. So config is read again, and only availability is reported as unknown.
       */
      const loaded = await configManager.load().then(
        (result) => result.config,
        () => undefined,
      )
      const settings = loaded?.expert
      post({
        // The whole thing, profiles included. Passing only half of what the constructor takes is
        // the same mistake as having two constructors, and this failure path is where the last
        // one hid: it runs rarely, so a field missing here is noticed much later than elsewhere.
        ...expertMessageFrom(settings),
        available: false,
        path: settings?.path ?? expertCliPath ?? 'claude',
        reason: `Could not check whether the Claude CLI is available: ${reason}`,
      })
    }
  }

  /**
   * Everything the Expert tab is told that comes from *settings* rather than from the probe.
   *
   * One construction, used by both the success and the failure path. They had drifted three
   * times — the guide capability, the programming profile, and the measured pricing all reached
   * one and not the other — and the failure is always the same shape: a panel that shows nothing
   * where something was just saved, with no error to explain it.
   */
  function expertMessageFrom(
    settings: LightCodeConfig['expert'],
  ): Extract<HostToUiMessage, { type: 'expert' }> {
    return {
      type: 'expert',
      enabled: settings?.enabled === true,
      available: false,
      path: settings?.path ?? expertCliPath ?? 'claude',
      maxSpendUsd: settings?.maxSpendUsd ?? 0,
      maxConsultations: settings?.maxConsultations ?? 0,
      keepAlive: settings?.keepAlive === true,
      ...(settings?.model !== undefined ? { model: settings.model } : {}),
      // The one that applies to the active junior, chosen through the module that owns both
      // config shapes - not `settings.assessment`, which is only the legacy slot.
      ...(cachedAssessment !== undefined ? { assessment: cachedAssessment } : {}),
      assessments: allAssessments(settings ?? {}),
      /*
       * What the probes predict about each seat, and who grades them.
       *
       * Sent rather than duplicated in the UI: the mapping is reasoned about beside the probes,
       * in `agents/seats.ts`, and a copy in a React component is the second declaration of one
       * fact that this repository keeps paying for.
       */
      seatFits: SEAT_FITS.map((fit) => ({
        role: fit.role,
        name: roleInfo(fit.role, cachedAgentDefinitions).name,
        probes: [...fit.probes],
        lookFor: fit.lookFor,
      })),
      expertGuidance: EXPERT_GUIDANCE,
      assessor: describeAssessor(),
      ...(settings?.reportsCost !== undefined ? { reportsCost: settings.reportsCost } : {}),
      ...(settings?.pricing !== undefined ? { pricing: settings.pricing } : {}),
      ...(measuringStep !== undefined ? { measuringStep } : {}),
      // Summarised from the in-memory log, which is loaded once. Undefined only before the
      // first read completes, which the panel renders as "nothing recorded yet".
      ...(expertEvents !== undefined
        ? { savings: summariseSavings(expertEvents, settings?.pricing) }
        : {}),
    }
  }

  /**
   * Everything the Agents tab is told, from one place.
   *
   * The whole message is built here rather than assembled at each call site, for the reason
   * CLAUDE.md records twice: two `expert` messages built separately drifted, and the symptom was
   * a measured price that reached one path and not the other. One constructor, one shape.
   */
  async function postAgents(): Promise<void> {
    const { config } = await configManager.load()
    /*
     * Detected here rather than read from whatever a turn happened to leave behind.
     *
     * `detectCli` caches, so this spawns a process at most once per configured path — and it must
     * happen on this path, because the tab offering Claude as a choice is the only thing that
     * will ask on a machine where the old expert feature was never enabled.
     */
    const cli = await detectCli(config.expert?.path ?? 'claude').catch(() => undefined)
    const teamContext = {
      config: config.agents,
      profiles: (config.profiles ?? []).map((profile) => ({
        id: profile.id,
        label: profile.label,
      })),
      cliAvailable: cli?.available === true,
    }

    /*
     * Every role, assigned or not — unlike `resolveTeam`, which returns only what is assigned.
     * The panel has to render the empty ones too: they are what you click to assign somebody,
     * and a tab showing only what already exists gives you nowhere to start.
     */
    const assigned = new Map(resolveTeam(teamContext).map((agent) => [agent.role, agent]))
    // Built-ins *and* whatever the user invented. Passing the definitions is the whole of what
    // makes a custom role appear in the tab — everything below already works by role id.
    const definitions = config.agents?.definitions ?? []
    const customIds = new Set(definitions.map((definition) => definition.id))
    const roles = allRoles(definitions).map((info) => {
      const agent = assigned.get(info.role)
      const prompt = config.agents?.roles?.[info.role]?.prompt
      return {
        role: info.role,
        name: info.name,
        summary: info.summary,
        ...(agent !== undefined ? { kind: agent.kind } : {}),
        ...(agent?.profileId !== undefined ? { profileId: agent.profileId } : {}),
        label: agent?.label ?? 'Nobody',
        available: agent?.available ?? false,
        ...(agent?.reason !== undefined ? { reason: agent.reason } : {}),
        prompt: prompt ?? defaultPromptFor(info.role, definitions),
        promptIsDefault: prompt === undefined,
        ...(customIds.has(info.role) ? { custom: true } : {}),
        // The assignment's override where there is one, else the role's own default — the same
        // resolution `resolveTeam` does, so the switch in the tab shows what will actually happen.
        usesTools: config.agents?.roles?.[info.role]?.tools ?? info.usesTools,
        canWrite: config.agents?.roles?.[info.role]?.write ?? info.canWrite,
        enabled: config.agents?.roles?.[info.role]?.enabled !== false,
        ...(() => {
          // Read once: `config.agents.roles[id]` narrows badly when indexed twice, and a second
          // read is a second chance for the two to disagree.
          const level = config.agents?.roles?.[info.role]?.thinking
          return level !== undefined ? { thinking: level } : {}
        })(),
      }
    })

    const guidance = config.agents?.teamGuidance
    post({
      type: 'agents',
      roles,
      profiles: teamContext.profiles,
      cliAvailable: teamContext.cliAvailable,
      ...(cli?.available === false && cli.reason !== undefined ? { cliReason: cli.reason } : {}),
      budgetMatters: budgetMatters(teamContext),
      /*
       * Assigned, rather than assigned *and* detected.
       *
       * Somebody who put Claude in a seat on a machine where it is momentarily missing has still
       * said they intend to spend money there, and taking the budget controls away from them
       * because a probe failed would be the panel arguing with the user.
       */
      claudeSeated: [...assigned.values()].some((agent) => agent.kind === 'cli'),
      teamGuidance: guidance ?? DEFAULT_TEAM_GUIDANCE,
      defaultTeamGuidance: DEFAULT_TEAM_GUIDANCE,
      teamGuidanceIsDefault: guidance === undefined,
      colors: {
        /*
         * The expert's colour comes from the control that has always owned it.
         *
         * It predates roles and lives under `ui.expertColor`, and the Agents work briefly gave it
         * a second home under `agents.colors.expert` — two pickers for one thing, backed by two
         * settings, which is the drift this project pays for most often. An explicit per-role
         * value still wins, so nothing is taken away; it is simply no longer the *default*
         * source for a colour that already had one.
         */
        expert: config.ui?.expertColor ?? '#D97757',
        ...(config.agents?.colors ?? {}),
      },
    })
  }

  /**
   * Writes one key of the `agents` block without disturbing the rest of it.
   *
   * `configManager.save` replaces whichever top-level keys it is given, so writing the whole block
   * from one control would erase every other control's value. That has cost real settings twice
   * here already — see `config/blockMerge.test.ts`.
   */
  /**
   * Creates or updates a role the user invented.
   *
   * The id is validated rather than trusted: it reaches a CSS custom property, a config key and
   * the `ask_agent` argument a model types, and somewhere in that chain a space or a capital
   * would be mangled with no error — presenting as a role that simply never answers.
   *
   * Editing keeps the same id on purpose. The id is what an assignment, a colour and any plan
   * already written refer to, so letting it change would silently orphan all three.
   */
  async function handleSaveCustomRole(role: {
    id: string
    name: string
    summary: string
    prompt: string
    usesTools: boolean
    canWrite?: boolean
  }): Promise<void> {
    const id = role.id.trim().toLowerCase()
    if (!isValidRoleId(id)) {
      post({
        type: 'error',
        message:
          `"${id}" is not a usable role id. Use lowercase letters, digits and hyphens, starting ` +
          'with a letter, and not the name of a built-in role.',
      })
      return
    }
    if (role.name.trim().length === 0) {
      post({ type: 'error', message: 'A role needs a name.' })
      return
    }

    await saveAgents((current) => {
      const definitions = [...(current.definitions ?? [])]
      const at = definitions.findIndex((candidate) => candidate.id === id)
      const next = {
        id,
        name: role.name.trim(),
        summary: role.summary.trim(),
        prompt: role.prompt.trim(),
        usesTools: role.usesTools,
        canWrite: role.canWrite === true,
      }
      if (at === -1) {
        if (definitions.length >= CUSTOM_ROLE_LIMIT) {
          throw new Error(
            `That would be ${String(definitions.length + 1)} custom roles. The limit is ` +
              `${String(CUSTOM_ROLE_LIMIT)}: the expert allocates from this list, and its judgement ` +
              'is what a longer one costs.',
          )
        }
        definitions.push(next)
      } else definitions[at] = next
      return { ...current, definitions }
    })
  }

  /** Removes a custom role, and the assignment that pointed at it. */
  async function handleDeleteCustomRole(id: string): Promise<void> {
    await saveAgents((current) => {
      const roles = { ...(current.roles ?? {}) }
      /*
       * The assignment goes with the definition.
       *
       * Left behind it would be a key naming a role that no longer exists — invisible in the tab,
       * still in the file, and resolving to the "no longer defined" placeholder if anything ever
       * read it. `handleSetAgentRole` refuses to *write* such a key for the same reason.
       */
      delete roles[id]
      return {
        ...current,
        roles,
        definitions: (current.definitions ?? []).filter((candidate) => candidate.id !== id),
      }
    })
  }

  async function saveAgents(
    change: (
      current: NonNullable<LightCodeConfig['agents']>,
    ) => NonNullable<LightCodeConfig['agents']>,
  ): Promise<void> {
    try {
      const { config } = await configManager.load()
      await configManager.save('user', { agents: change(config.agents ?? {}) })
      await loadSettings()
      await postAgents()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function postExpertInner(redetect: boolean): Promise<void> {
    // Read here rather than at construction: the panel opening is the first moment anything
    // needs it, and nothing should touch the disk just because a window opened.
    const { config } = await configManager.load()

    // Read here rather than at construction: the panel opening is the first moment anything
    // needs it, and nothing should touch the disk just because a window opened.
    await loadExpertEvents()
    const configured = config.expert?.path ?? 'claude'
    /*
     * Re-probing spawns a process. After an assessment we have just used the CLI successfully,
     * so doing it again tells us nothing and does it at the moment the machine is busiest —
     * which is when the probe is most likely to time out and report the CLI as missing.
     */
    const detected =
      !redetect && expertCli !== undefined && expertCliPath === configured
        ? expertCli
        : await detectClaudeCli(configured)
    // Cache the probe so the next turn does not re-spawn it.
    expertCli = detected
    expertCliPath = configured
    // The Agents tab is told too, since this path can be the one that first learns the answer.
    void postAgents()

    post({
      // Everything from settings comes from one place, so the two paths cannot drift again.
      ...expertMessageFrom(config.expert),
      available: detected.available,
      path: configured,
      ...(detected.version !== undefined ? { version: detected.version } : {}),
      ...(detected.reason !== undefined ? { reason: detected.reason } : {}),
      ...(assessmentStep === undefined ? {} : { assessing: true, assessmentStep }),
    })
  }

  /**
   * Asks the junior a handful of probes, then has the expert grade the answers.
   *
   * **Evidence, not recall.** Asking the expert what it thinks of a model *name* would produce
   * an authoritative-sounding answer from training data that may predate the release or
   * describe a different quantisation — and would say nothing about this deployment, where a
   * gateway's own prompt and context limit change the behaviour anyway. Grading real answers
   * makes the judgement falsifiable, and the answers are kept so the user can judge it too.
   *
   * Costs one expert consultation plus a few cheap junior calls, which is why it is a button
   * rather than something that happens on its own.
   */
  /**
   * Measures what a consultation costs here, by having two.
   *
   * There is no way to learn the price of a consultation without one, and one sample cannot show
   * the thing that matters — the *ratio* between a cold session and a resumed one, which is what
   * every rule about using the expert cheaply depends on. So it is two calls, and the button says
   * so before it spends anything.
   *
   * Deliberately not part of detection. Detection runs whenever the panel opens; this bills you.
   */
  /**
   * Refreshes the expert's cache before the hour is up, so a break does not cost a cold start.
   *
   * ## Why fifty minutes
   *
   * The cache is one hour (`ephemeral_1h_input_tokens`) and that TTL is Anthropic's, not ours —
   * one hour is already the longer of the two they offer. Fifty leaves room for a slow call
   * without leaving so much that the pings pile up.
   *
   * ## What it will not do
   *
   * It never starts a session, only refreshes one that a real consultation created — a task where
   * the expert was never used should cost nothing at all. It stops the moment the budget is spent,
   * because pinging past a limit the user set to protect themselves is precisely the behaviour
   * that makes a background timer untrustworthy. And its cost is recorded, so nothing is spent
   * that the meter does not show.
   */
  const KEEP_ALIVE_MS = 50 * 60 * 1000
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined

  function stopKeepAlive(): void {
    if (keepAliveTimer === undefined) return
    clearInterval(keepAliveTimer)
    keepAliveTimer = undefined
  }

  function ensureKeepAlive(): void {
    if (keepAliveTimer !== undefined) return
    keepAliveTimer = setInterval(() => {
      void runKeepAlive()
    }, KEEP_ALIVE_MS)
    // Never hold the process open for this. A server waiting to shut down should not be kept
    // alive by a timer whose whole purpose is saving money.
    keepAliveTimer.unref?.()
  }

  async function runKeepAlive(): Promise<void> {
    const session = expertSessionId
    // No session means no cache to keep warm, and starting one would be spending for nothing.
    if (session === undefined) {
      stopKeepAlive()
      stopWatchingSkills()
      return
    }
    try {
      const { config } = await configManager.load()
      if (config.expert?.keepAlive !== true) {
        stopKeepAlive()
        return
      }
      const verdict = checkExpertBudget(expertSpend, effectiveExpertLimits())
      if (!verdict.allowed) {
        logger.info('expert keep-alive stopped: the budget for this task is spent')
        stopKeepAlive()
        return
      }
      const cli = await resolveExpert(config)
      if (cli === undefined) {
        stopKeepAlive()
        return
      }

      const answer = await consultExpert(
        cli,
        {
          question: PRICING_PROBE,
          cwd: workspaceRoot ?? process.cwd(),
          ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}),
          resumeSessionId: session,
        },
        logger,
      )
      /*
       * Counted as a ping, not a consultation. The money goes into the total because money spent
       * is money spent; the count stays separate because a long task must not spend its
       * consultation allowance on automated pings and then refuse the expert when the work needs
       * it.
       */
      expertSpend.keepAlives += 1
      if (answer.costUsd !== undefined) expertSpend.usd += answer.costUsd
      // Overhead: real money, but not the expert answering anything. Kept out of the
      // consultation count so that count still means "times the expert was asked something".
      appendExpertEvent({
        at: Date.now(),
        kind: 'consultation',
        ...(answer.costUsd !== undefined ? { usd: answer.costUsd } : {}),
        resumed: true,
        overhead: true,
      })
      if (answer.sessionId !== undefined) expertSessionId = answer.sessionId
      postExpertSpend()
      logger.info('expert keep-alive refreshed the session cache')
    } catch (error) {
      // A failed ping is not worth interrupting anyone over — the only consequence is paying a
      // cold start later, which is what would have happened anyway.
      logger.warn(`expert keep-alive failed: ${String(error)}`)
    }
  }

  async function handleMeasureExpertCost(): Promise<void> {
    /*
     * Already running. Said rather than ignored: two consultations take a while, and a button
     * that silently does nothing on the second click is indistinguishable from one that is broken
     * — which is exactly how this was reported.
     */
    if (measuringStep !== undefined) {
      post({ type: 'error', message: `Already measuring — ${measuringStep}` })
      return
    }

    /*
     * The panel is told *before* anything is awaited.
     *
     * This used to load config and probe for the CLI first, and probing spawns a process — on
     * Windows through a .cmd shim, which antivirus can make slow. For those seconds the button
     * looked untouched, so a click that was working was indistinguishable from one that had done
     * nothing at all. Whatever else this handler does, the first thing it does is say it started.
     */
    measuringStep = 'Starting…'
    logger.info('measuring what an expert consultation costs')
    await postExpert({ redetect: false })

    try {
      const { config } = await configManager.load()
      const cli = await resolveExpert(config)
      if (cli === undefined) {
        post({
          type: 'error',
          message:
            'The Claude CLI could not be found, so there is nothing to measure. Check the path in this tab.',
        })
        return
      }

      /*
       * A session of its own, discarded afterwards. Measuring inside the task's session would
       * make the first real consultation of that task look cheap, because this one would have
       * paid to establish it — and would leave "reply OK" in the expert's context for the rest
       * of the task.
       */
      let sessionId: string | undefined
      let resumeWorked = false
      const samples: (number | undefined)[] = []

      for (const [index, label] of [
        'first consultation',
        'follow-up in the same session',
      ].entries()) {
        measuringStep = `Measuring the ${label} (${String(index + 1)}/2)…`
        await postExpert({ redetect: false })

        const answer = await consultExpert(
          cli,
          {
            question: PRICING_PROBE,
            cwd: workspaceRoot ?? process.cwd(),
            ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}),
            // Cold on the first pass, resumed on the second. That pair is the measurement.
            ...(sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
          },
          logger,
        )
        samples.push(answer.costUsd)
        /*
         * Whether the *second* pass had a session to resume. Without recording this, a CLI that
         * returns no session id produces two cold starts labelled cold and resumed, and the ratio
         * read off them is meaningless in a way nothing on screen would reveal.
         */
        if (index === 0) resumeWorked = answer.sessionId !== undefined
        sessionId = answer.sessionId ?? sessionId
      }

      const [cold, resumed] = samples
      const reportsCost = cold !== undefined || resumed !== undefined

      /*
       * The measurement's own two consultations cost real money, so they go in the log.
       *
       * Marked `overhead`, so they show up in what was spent without pretending the expert was
       * asked two questions. Omitting them entirely was the first version, and it made the
       * panel's "spent" figure quietly wrong the moment anyone pressed the button.
       */
      samples.forEach((usd, index) => {
        appendExpertEvent({
          at: Date.now(),
          kind: 'consultation',
          ...(usd !== undefined ? { usd } : {}),
          resumed: index > 0,
          overhead: true,
        })
      })
      const pricing = {
        measuredAt: Date.now(),
        reportsCost,
        resumeWorked,
        ...(cold !== undefined ? { coldUsd: cold } : {}),
        ...(resumed !== undefined ? { resumedUsd: resumed } : {}),
      }

      const { config: current } = await configManager.load()
      await configManager.save('user', {
        ...current,
        expert: { ...current.expert, pricing, reportsCost },
      })
      logger.info(
        reportsCost
          ? `expert pricing measured: cold ${String(cold)} / resumed ${String(resumed)}`
          : 'expert pricing measured: this plan reports no cost per consultation',
      )
    } catch (error) {
      post({ type: 'error', message: `Could not measure the expert's cost: ${String(error)}` })
    } finally {
      measuringStep = undefined
      await postExpert({ redetect: false })
    }
  }

  /**
   * Who grades the probe answers, for the tab to name before anything is spent.
   *
   * The Claude CLI when the expert seat is Claude, and otherwise whatever profile sits in that
   * seat. It used to be the CLI or nothing, which made the whole assessment unreachable for
   * anybody whose expert is a model on their gateway - the deployment this product is for.
   */
  function describeAssessor(): { label: string; available: boolean } {
    const expert = cachedTeam.find((agent) => agent.role === 'expert')
    if (expert === undefined) {
      return { label: 'Nobody is in the expert seat', available: false }
    }
    return { label: expert.label, available: expert.available }
  }

  /**
   * Puts one question to whoever is in the expert seat, with no tools and no workspace.
   *
   * Deliberately not the specialist consultation path: that one carries read tools, a budget
   * check and an approval gate, all of which are about a specialist working *on the task*. This
   * is a single graded question about text already gathered, and giving it tools would let it
   * grade the harness rather than the answers.
   */
  async function askExpertSeat(
    question: string,
    config: LightCodeConfig,
    expert: ResolvedAgent,
  ): Promise<{ text: string; costUsd?: number }> {
    if (expert.kind === 'cli') {
      const cli = await detectCli(config.expert?.path ?? 'claude')
      if (!cli.available) throw new Error('The Claude CLI is not available.')
      const graded = await consultExpert(cli, {
        question,
        cwd: workspaceRoot ?? process.cwd(),
        ...(config.expert?.model !== undefined ? { model: config.expert.model } : {}),
      })
      // Counted like any other consultation: it spent the user's money, and a total that
      // quietly omitted it would understate the spend.
      recordConsultation({
        isError: graded.isError,
        ...(graded.costUsd !== undefined ? { costUsd: graded.costUsd } : {}),
      })
      if (graded.isError) throw new Error(graded.text)
      return {
        text: graded.text,
        ...(graded.costUsd !== undefined ? { costUsd: graded.costUsd } : {}),
      }
    }

    const profile = config.profiles?.find((candidate) => candidate.id === expert.profileId)
    if (profile === undefined) {
      throw new Error(`No profile "${expert.profileId ?? ''}" exists any more.`)
    }
    // The seat's thinking level over the profile's, on a copy - see the consultation path for
    // why a mutation here would leak the Agents tab's setting into the chat model.
    const seatProfile =
      expert.thinking === undefined
        ? profile
        : {
            ...profile,
            thinking: {
              ...(profile.thinking ?? { level: expert.thinking }),
              level: expert.thinking,
            },
          }
    const provider = createChatProvider(
      seatProfile,
      httpClient,
      authStrategyFor(config, profile),
      logger,
    )
    let text = ''
    for await (const chunk of provider.streamChat([
      { role: 'system', content: expert.prompt },
      { role: 'user', content: question },
    ])) {
      if (chunk.type === 'text') text += chunk.text
      if (chunk.type === 'error') throw new Error(chunk.error)
    }
    if (text.trim().length === 0) throw new Error('The expert replied with nothing.')
    return { text }
  }

  async function handleAssessJunior(profileId?: string): Promise<void> {
    if (assessmentStep !== undefined) return
    try {
      const { config } = await configManager.load()

      /*
       * Graded by whoever is in the expert seat, which may be a profile.
       *
       * Resolved from freshly loaded config rather than from `cachedTeam`, because the user has
       * very often just assigned somebody to that seat in the tab next door.
       */
      const cli = await detectCli(config.expert?.path ?? 'claude').catch(() => undefined)
      const team = resolveTeam({
        config: config.agents,
        profiles: (config.profiles ?? []).map((entry) => ({ id: entry.id, label: entry.label })),
        cliAvailable: cli?.available === true,
      })
      const expert = team.find((agent) => agent.role === 'expert' && agent.available)
      if (expert === undefined) {
        post({
          type: 'error',
          message:
            'Nothing is in the expert seat. Assign one in the Agents tab - the assessment is ' +
            'its judgement, not ours.',
        })
        return
      }

      /*
       * The model being assessed, which is not necessarily the one in the chat.
       *
       * Naming it is what makes comparing four models on a gateway possible at all: before this
       * the only assessable model was whichever profile happened to be active, so finding out
       * which should review and which should write meant switching the active profile four
       * times and losing each verdict as the next was made.
       */
      const chosen =
        profileId === undefined
          ? undefined
          : config.profiles?.find((candidate) => candidate.id === profileId)
      if (profileId !== undefined && chosen === undefined) {
        post({ type: 'error', message: 'That profile no longer exists.' })
        return
      }
      const profile = chosen ?? resolveActiveProfile(config)

      const provider = createChatProvider(
        profile,
        httpClient,
        authStrategyFor(config, profile),
        logger,
      )

      const results: ProbeResult[] = []
      for (const [index, probe] of ASSESSMENT_PROBES.entries()) {
        assessmentStep = `Asking ${profile.label ?? profile.model}: ${probe.measures} (${String(index + 1)}/${String(ASSESSMENT_PROBES.length)})`
        await postExpert({ redetect: false })

        let answer = ''
        try {
          /*
           * No tools and no system prompt beyond the probe. The point is to measure the model,
           * not the scaffolding around it - and a probe that could call `read_file` would
           * measure whether the harness works.
           */
          for await (const chunk of provider.streamChat([
            { role: 'user', content: probe.prompt },
          ])) {
            if (chunk.type === 'text') answer += chunk.text
            // A provider that streams an error rather than throwing is still a failed probe.
            if (chunk.type === 'error') throw new Error(chunk.error)
          }
          results.push({ id: probe.id, measures: probe.measures, prompt: probe.prompt, answer })
        } catch (error) {
          // A probe that fails is itself a finding - a model that times out on five short
          // questions is one the expert should know about.
          results.push({
            id: probe.id,
            measures: probe.measures,
            prompt: probe.prompt,
            answer,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      assessmentStep = `Asking ${expert.label} to grade the answers`
      await postExpert({ redetect: false })

      const graded = await askExpertSeat(
        buildAssessmentQuestion(profile.model, results),
        config,
        expert,
      )

      const assessment: JuniorAssessment = {
        model: profile.model,
        profileLabel: profile.label ?? profile.model,
        assessedAt: Date.now(),
        verdict: graded.text.trim(),
        probes: results,
        ...(graded.costUsd !== undefined ? { costUsd: graded.costUsd } : {}),
      }

      const latest = (await configManager.load()).config
      await configManager.save('user', {
        expert: {
          ...latest.expert,
          assessments: recordAssessment(allAssessments(latest.expert ?? {}), assessment),
        },
      })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      assessmentStep = undefined
      await postExpert({ redetect: false })
    }
  }

  /** Forgets one assessment, or every one when no subject is named. */
  async function handleClearAssessment(model?: string, profileLabel?: string): Promise<void> {
    const { config } = await configManager.load()
    const expert = { ...config.expert }
    if (model === undefined || profileLabel === undefined) {
      delete expert.assessment
      delete expert.assessments
    } else {
      // Through `allAssessments` so forgetting one held in the older single field actually
      // forgets it, rather than filtering a list that never contained it.
      expert.assessments = forgetAssessment(allAssessments(expert), model, profileLabel)
      delete expert.assessment
    }
    await configManager.save('user', { expert })
    await postExpert()
  }

  async function handleSetExpert(
    enabled: boolean,
    cliPath?: string,
    model?: string,
    limits?: { maxSpendUsd?: number; maxConsultations?: number; profileId?: string },
  ): Promise<void> {
    try {
      const { config } = await configManager.load()
      await configManager.save('user', {
        expert: {
          ...config.expert,
          enabled,
          ...(cliPath !== undefined && cliPath.length > 0 ? { path: cliPath } : {}),
          ...(model !== undefined && model.length > 0 ? { model } : { model: undefined }),
          ...(limits?.maxSpendUsd !== undefined ? { maxSpendUsd: limits.maxSpendUsd } : {}),
          ...(limits?.maxConsultations !== undefined
            ? { maxConsultations: limits.maxConsultations }
            : {}),
          /*
           * Cleared means cleared. With the spread of `config.expert` above, omitting an empty
           * value would keep the old one, so choosing "none" in the picker would appear to do
           * nothing — the same three-way distinction the Python block had to learn.
           */
          ...(limits?.profileId !== undefined
            ? limits.profileId.length > 0
              ? { profileId: limits.profileId }
              : { profileId: undefined }
            : {}),
        },
      })
      // Reloaded so the cap applies to the next consultation rather than to the next task.
      await loadSettings()
      postExpertSpend()
      // Force re-detection: the path may have changed, and a stale probe would report the
      // old binary as still present.
      expertCli = undefined
      expertCliPath = undefined
      await postExpert()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Builds a connection for *any* vector store, resolving credentials from secure storage and
   * the CA from disk at call time rather than caching either.
   *
   * **Backend-neutral, and named so since Qdrant and Chroma arrived.** It was
   * `openSearchConnectionFor`, which was accurate when there was one backend and became a lie
   * the moment there were three — the sort of name that has someone add a second, subtly
   * different connection builder rather than reuse this one. `OpenSearchConnection` is itself
   * an alias of `VectorStoreConnection` for the same reason.
   *
   * Every backend therefore inherits the global TLS block: a corporate root set once in
   * Settings → Network covers the gateway, the token endpoint, the embedder and the vector
   * store alike, and a per-connection CA adds to it rather than replacing it (§19).
   */
  async function vectorStoreConnectionFor(
    store: VectorStoreConfig,
    id: string,
  ): Promise<OpenSearchConnection> {
    const connection: OpenSearchConnection = { url: store.url, label: store.label }

    const username =
      store.usernameRef !== undefined ? await secrets.get(searchUserRefFor(id)) : undefined
    const password =
      store.passwordRef !== undefined ? await secrets.get(searchPasswordRefFor(id)) : undefined
    if (username !== undefined) connection.username = username
    if (password !== undefined) connection.password = password

    // Same resolver the gateway uses, so a corporate root set once in Settings → Network
    // covers the cluster too, and a per-cluster CA adds to it rather than replacing it.
    const { config } = await configManager.load()
    const perStore = vectorStoreTls(store)
    const passphraseRef = perStore?.passphraseRef ?? config.tls?.passphraseRef
    const tls = await resolveConnectionTls({
      ...(config.tls !== undefined ? { global: config.tls } : {}),
      ...(perStore !== undefined ? { connection: perStore } : {}),
      ...(config.certDir !== undefined ? { certDir: config.certDir } : {}),
      ...(passphraseRef !== undefined ? { passphrase: await secrets.get(passphraseRef) } : {}),
      onPaths: (paths) => {
        void Promise.all(paths.map((certPath) => denylist.add(certPath))).catch(
          (error: unknown) => {
            logger.warn('could not add cert path to the deny list', String(error))
          },
        )
      },
    })
    if (tls !== undefined) connection.tls = tls as NonNullable<OpenSearchConnection['tls']>
    return connection
  }

  async function openSearchClientFor(
    store: VectorStoreConfig,
    id: string,
  ): Promise<OpenSearchClient> {
    return new OpenSearchClient(httpClient, await vectorStoreConnectionFor(store, id))
  }

  /** The read half of whichever backend the active store names. Never a writer. */
  async function vectorSearcherFor(store: VectorStoreConfig, id: string): Promise<VectorSearcher> {
    return createVectorSearcher(httpClient, store, await vectorStoreConnectionFor(store, id))
  }

  /**
   * The active connection for this session, or undefined when search is off.
   *
   * Search tools exist only when a connection is selected — §12 requires the tool set to be
   * stable within a session, so selection is the boundary at which it may change.
   */
  /**
   * @param storeId Which connection to use. Defaults to the active one; mail passes its own, so
   *   a team's code can go to a shared cluster while mail stays in a local Qdrant.
   */
  async function resolveSearch(
    config: LightCodeConfig,
    storeId?: string,
  ): Promise<
    | {
        /** Backend-neutral, for `search_codebase`. */
        searcher: VectorSearcher
        /**
         * Present only for an OpenSearch cluster, and that is the seam working as intended:
         * `search_docs` queries the organisation's *existing* indexes with raw DSL, which
         * Qdrant and Chroma have no counterpart for. When a future backend is active this is
         * undefined and the tool is simply not offered, rather than offered and broken.
         */
        opensearch?: OpenSearchClient
        store: VectorStoreConfig
        id: string
      }
    | undefined
  > {
    const id = storeId ?? config.activeVectorStoreId
    if (id === undefined) return undefined
    const store = config.vectorStores?.[id]
    if (store === undefined) return undefined
    try {
      return {
        searcher: await vectorSearcherFor(store, id),
        ...(store.kind === 'opensearch'
          ? { opensearch: await openSearchClientFor(store, id) }
          : {}),
        store,
        id,
      }
    } catch (error) {
      logger.warn('could not build the search client', String(error))
      return undefined
    }
  }

  /**
   * Front of every derived index name, overridable so a shared cluster can distinguish teams.
   * Changing it points at *new* collections — the old ones keep their data until deleted.
   */
  // Re-exported from `rag/indexNaming.ts`, which owns the derived name this prefixes.
  const DEFAULT_INDEX_PREFIX = DERIVED_INDEX_PREFIX

  /** The index Light Code writes this workspace into. User-set or derived; never model-supplied. */
  /**
   * Who this machine's indexed chunks are attributed to.
   *
   * Config first, then the operating system's user name. Resolved here rather than in core
   * because "who the user is" is a host concern (section 4) — and overridable because an OS
   * login is frequently not what a team calls each other.
   *
   * Undefined only if both are unavailable, in which case chunks are written unattributed and
   * read back as *unknown* rather than as anyone's.
   */
  function indexOwner(config?: LightCodeConfig): string | undefined {
    const configured = config?.identity?.owner?.trim()
    if (configured !== undefined && configured.length > 0) return configured
    try {
      const name = os.userInfo().username.trim()
      return name.length > 0 ? name : undefined
    } catch {
      // Some containers have no passwd entry for the running uid.
      return undefined
    }
  }

  /** The project's folder name, which is what distinguishes two checkouts in a hit list. */
  function indexProject(): string | undefined {
    return workspaceRoot === undefined ? undefined : path.basename(workspaceRoot)
  }

  /**
   * Joins an already-indexed workspace to the team alias, without re-embedding anything.
   *
   * The case this exists for: someone has been using Light Code with OpenSearch since before
   * aliases and attribution existed. Their index is complete and correct; it is simply not
   * pointed at by the shared name, and its chunks carry no owner. Re-indexing to fix a label
   * would mean paying the embedding cost for the whole repository again.
   *
   * So both are done in place — the alias is added, and documents *missing* an owner are
   * stamped with one. Never documents that already have a different owner, which is what makes
   * this safe to run against an index several people write to.
   */
  async function handleAttachTeamAlias(): Promise<void> {
    const config = await loadSettings()
    const aliases = codebaseAliases(config)
    if (aliases.length === 0) {
      post({
        type: 'teamAliasAttached',
        error: 'Set a team index alias in Settings → Search first — there is nothing to attach to.',
      })
      return
    }

    const index = codebaseIndexName(config)
    const search = await resolveSearch(config)
    if (index === undefined || search === undefined) {
      post({
        type: 'teamAliasAttached',
        error: 'Attaching an alias needs a search connection and an index name.',
      })
      return
    }

    try {
      const writer = createVectorIndexWriter(
        httpClient,
        search.store,
        await vectorStoreConnectionFor(search.store, search.id),
      )
      if (writer.ensureAlias === undefined) {
        post({
          type: 'teamAliasAttached',
          error:
            `${search.store.label} has no concept of an alias — only OpenSearch does. ` +
            'Team-wide search is unavailable on this backend.',
        })
        return
      }

      // Every configured name, so an index built before a second circle existed picks that one
      // up too. Idempotent, so the ones already attached cost a call and change nothing.
      for (const alias of aliases) await writer.ensureAlias(index, alias)

      // Attribution is a separate, optional step: without it a team search can find these
      // chunks but cannot say whose they are, which is most of the point.
      let attributed = 0
      const owner = indexOwner(config)
      if (owner !== undefined && writer.attributeUnowned !== undefined) {
        const project = indexProject()
        attributed = await writer.attributeUnowned(index, {
          owner,
          ...(project !== undefined ? { project } : {}),
        })
      }

      post({ type: 'teamAliasAttached', alias: aliases.join(', '), index, attributed })
    } catch (error) {
      post({
        type: 'teamAliasAttached',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Which collection indexed mail goes to, and which connection reaches it.
   *
   * Deliberately routed through `retrieval.stores.mail` rather than the active store: the case
   * this was built for is a team indexing code into a shared cluster while keeping their own
   * mail in a local Qdrant, and those cannot be one setting. Falls back to the active store when
   * nothing is named, so a simple install needs no extra configuration.
   */
  function mailCollectionName(config?: LightCodeConfig): string | undefined {
    const base = codebaseIndexName(config)
    return base === undefined ? undefined : `${base}-mail`
  }

  /** The connection mail is indexed into, which may differ from the codebase one. */
  async function resolveMailSearch(config: LightCodeConfig) {
    const wanted = storeIdFor('mail', config)
    return resolveSearch(config, wanted)
  }

  /**
   * Collects new mail once.
   *
   * Guarded by `mailBusy` rather than queued: two passes over one mailbox would fetch the same
   * messages twice and race on the same file, and the timer firing while a manual sync is still
   * running is the ordinary way that happens.
   */
  async function runMailSync(reason: string): Promise<void> {
    if (mailBusy) return
    const config = await loadSettings()
    if (config.mail?.enabled !== true || cachedOffice.outlook !== true || !officeAvailable()) return
    const chosen = config.mail.folders ?? []
    if (chosen.length === 0) return
    /*
     * Subfolders are expanded here, at sync time, rather than when they were ticked. A subfolder
     * created since then is picked up automatically, which is what "include subfolders" has to
     * mean if it is to keep being true.
     */
    const folders =
      config.mail.includeSubfolders === false ? chosen : await expandSubfolders(chosen)

    mailBusy = true
    const signal = beginIndexing('mail')
    reportIndexing('mail', 'Asking Outlook for new messages', {
      detail: `${String(folders.length)} folder(s)`,
    })
    // What Outlook could not open. The harvest is the only place that knows.
    const skipped = new Set<string>()
    try {
      const embedder = await resolveEmbedder(config)
      const search = await resolveMailSearch(config)
      const collection = mailCollectionName(config)

      const result = await syncMail({
        signal,
        onProgress: (done: number, total: number, phase: string) =>
          reportIndexing('mail', phase, { done, total }),
        store: mailStore,
        folders,
        /*
         * History is collected only as far back as retention keeps it.
         *
         * Without this the backfill walked to the beginning of the mailbox, embedding years of
         * mail that the next prune would delete - and then re-embedding it, because pruning moves
         * the oldest mark forward and the backfill resumes from there. A permanent loop paying to
         * embed the same messages.
         */
        retentionMonths: config.mail?.retentionMonths ?? 6,
        ...(config.mail.previewChars !== undefined
          ? { previewChars: config.mail.previewChars }
          : {}),
        harvest: async (requests, limits) => {
          const answer = await office().request<{
            messages: HarvestedMessage[]
            truncated: boolean
            skipped?: string[]
          }>({
            op: 'outlook.harvest',
            folders: requests,
            limit: limits.limit,
            previewChars: limits.previewChars,
          })
          for (const path of answer.skipped ?? []) skipped.add(path)
          return { messages: answer.messages, truncated: answer.truncated }
        },
        ...(embedder !== undefined && search !== undefined && collection !== undefined
          ? {
              semantic: {
                embedder,
                writer: createVectorIndexWriter(
                  httpClient,
                  search.store,
                  await vectorStoreConnectionFor(search.store, search.id),
                ),
                collection,
              },
            }
          : {}),
      })

      /*
       * Pruned on the sync, not only when somebody presses the button.
       *
       * Retention was a setting nobody applied: `pruneMail` ran from the button alone, so an
       * index left to itself grew for ever while the panel displayed a limit it was not keeping.
       * This does no work when there is nothing past the horizon - it rewrites the file only if
       * something is actually removed - so the ordinary case costs one comparison.
       */
      await pruneIfDue(config)

      mailLastResult =
        result.added === 0
          ? `No new mail (${reason}).`
          : `Indexed ${String(result.added)} new message(s)${result.more ? ' \u2014 more remain, syncing again shortly' : ''}.`
      /*
       * Folders Outlook could not open, named rather than swallowed.
       *
       * They were skipped in silence so that one renamed folder could not stop every other
       * folder indexing - right in itself, but it meant a folder that never resolved simply
       * never appeared, with nothing anywhere saying so. That is how a whole subtree went
       * missing and was found by somebody noticing rather than by being told.
       */
      if (skipped.size > 0) {
        mailLastResult += ` ${String(skipped.size)} folder(s) could not be opened and were not indexed: ${[...skipped].join(', ')}.`
        logger.warn(`mail sync skipped folders: ${[...skipped].join(', ')}`)
      }
      reportIndexing('mail', 'Finished', { detail: mailLastResult, running: false })
      logger.info(`mail sync: ${mailLastResult}`)
      /*
       * A truncated pass means the mailbox had more than one batch. Rather than loop here —
       * which would hold the mailbox for as long as it took — the next tick picks it up, so a
       * first run over years of mail makes steady progress without blocking anything.
       */
      await postMailStatus()
    } catch (error) {
      const stopped = signal.aborted
      mailLastResult = stopped ? 'Stopped.' : error instanceof Error ? error.message : String(error)
      if (!stopped) logger.warn(`mail sync failed: ${mailLastResult}`)
      reportIndexing('mail', stopped ? 'Stopped' : 'Failed', {
        detail: mailLastResult,
        running: false,
      })
      await postMailStatus()
    } finally {
      mailBusy = false
      endIndexing('mail')
    }
  }

  /** Starts, restarts or stops the timer to match the current configuration. */

  // ================================================================= custom datasets
  /*
   * A corpus the user collects with their own Python tool, kept current on a timer.
   *
   * One timer per dataset rather than one for all of them: they have different cadences — a
   * ticket queue every fifteen minutes, a wiki once a day — and a shared timer would run the
   * slow one at the fast one's rate or the reverse. Each is `unref`'d so a pending tick never
   * holds the Node host open.
   */
  const datasetTimers = new Map<string, ReturnType<typeof setInterval>>()
  const datasetBusy = new Set<string>()
  /*
   * The last outcome per dataset, and whether it was a failure.
   *
   * Kept apart from the text rather than inferred from it: "nothing new" and "the source is
   * unreachable" are both a sentence, and shown alike the broken one reads as the working one.
   * That is how a dataset stops updating without anybody noticing for a fortnight.
   */
  const datasetResults = new Map<string, { detail: string; failed: boolean; at: number }>()

  function datasetStoreFor(id: string): DatasetStore {
    return new DatasetStore(storageDir, id)
  }

  /** The collection datasets share. One per workspace, like the others, prefixed per record. */
  function datasetCollectionName(config?: LightCodeConfig): string | undefined {
    const base = codebaseIndexName(config)
    return base === undefined ? undefined : `${base}-data`
  }

  async function resolveDatasetSearch(config: LightCodeConfig, dataset?: DatasetConfig) {
    const wanted = dataset?.storeId ?? storeIdFor('data', config)
    return resolveSearch(config, wanted)
  }

  async function datasetSemantic(config: LightCodeConfig, dataset: DatasetConfig) {
    const collection = datasetCollectionName(config)
    const search = await resolveDatasetSearch(config, dataset)
    const embedder = await resolveEmbedder(config)
    if (collection === undefined || search === undefined || embedder === undefined) return undefined
    return {
      embedder,
      collection,
      writer: createVectorIndexWriter(
        httpClient,
        search.store,
        await vectorStoreConnectionFor(search.store, search.id),
      ),
      searcher: search.searcher,
    }
  }

  /**
   * Runs one dataset's collector and folds the result in.
   *
   * Guarded per dataset rather than globally: two datasets are independent corpora in independent
   * files, so one taking ten minutes must not stop the other from running at all. The guard stops
   * the *same* dataset overlapping itself, which is what a timer firing during a manual run does.
   */
  async function runDatasetSync(id: string, reason: string): Promise<void> {
    if (datasetBusy.has(id)) return
    const config = await loadSettings()
    const dataset = (config.datasets ?? []).find((entry) => entry.id === id)
    if (dataset === undefined) return

    datasetBusy.add(id)
    const signal = beginIndexing(`dataset:${id}`)
    reportIndexing('dataset', `Syncing ${dataset.name}`, { detail: `via ${dataset.toolName}` })
    try {
      const semantic = await datasetSemantic(config, dataset)
      const result = await syncDataset({
        datasetId: id,
        store: datasetStoreFor(id),
        signal,
        onProgress: (done, total, phase) => reportIndexing('dataset', phase, { done, total }),
        ...(dataset.retentionDays !== undefined ? { retentionDays: dataset.retentionDays } : {}),
        ...(semantic !== undefined
          ? {
              semantic: {
                embedder: semantic.embedder,
                writer: semantic.writer,
                collection: semantic.collection,
              },
            }
          : {}),
        /*
         * The collector runs through the ordinary Python tool path, so it is the same code that
         * validated it, the same worker, the same timeout. A second execution path would be a
         * second thing to keep in step with tool approval.
         */
        collect: async (since) => {
          /*
           * Any registered tool, not only a Python one.
           *
           * An MCP server is frequently *already* the integration somebody has - a Jira server,
           * a database server - and requiring a Python wrapper around it would ask them to
           * rebuild a connector they have running. The bare name is tried first so a namespaced
           * MCP tool (`jira__search_issues`) works as written, and `py__` second so a Python
           * tool can be named without its prefix.
           */
          const registry = currentToolRegistry()
          const tool = registry.get(dataset.toolName) ?? registry.get(`py__${dataset.toolName}`)
          if (tool === undefined) {
            throw new Error(
              `The collector tool "${dataset.toolName}" is not registered. A Python tool may have ` +
                'been deleted or Python switched off; an MCP tool may be from a server that is ' +
                'disconnected or disabled. Settings → Tools lists everything callable.',
            )
          }
          const args = { ...(dataset.arguments ?? {}), ...(since === undefined ? {} : { since }) }
          const output = await tool.execute(args as never, { signal } as never)
          if (output.isError === true) throw new Error(String(output.content))
          /*
           * A tool result is text. Parsed here rather than asking the tool to return an object,
           * because every other tool in the product returns text and making this one different
           * would be a second contract for a worker that already has one.
           */
          try {
            return JSON.parse(
              typeof output.content === 'string' ? output.content : JSON.stringify(output.content),
            )
          } catch {
            throw new Error(
              'The collector tool did not return JSON. It must return a list of records — see ' +
                'the guidance in Settings \u2192 Custom data.',
            )
          }
        },
      })

      const detail =
        result.updated === 0
          ? `No changes (${reason}). ${String(result.total)} record(s) held.`
          : `${String(result.updated)} record(s) updated, ${String(result.embedded)} embedded` +
            `${result.removed > 0 ? `, ${String(result.removed)} removed by retention` : ''}. ` +
            `${String(result.total)} held.`
      datasetResults.set(id, { detail, failed: false, at: Date.now() })
      reportIndexing('dataset', 'Finished', { detail, running: false })
    } catch (error) {
      const stopped = signal.aborted
      /*
       * Reported three ways, because a scheduled sync fails when nobody is looking.
       *
       * The panel shows it in the error colour with the time, the output channel keeps it for
       * afterwards, and the progress bar says Failed rather than merely disappearing — which is
       * what a silent `running: false` looks like from across the room.
       */
      const detail = stopped ? 'Stopped.' : error instanceof Error ? error.message : String(error)
      datasetResults.set(id, { detail, failed: !stopped, at: Date.now() })
      if (!stopped) logger.warn(`dataset "${dataset.name}" sync failed: ${detail}`)
      reportIndexing('dataset', stopped ? 'Stopped' : 'Failed', { detail, running: false })
    } finally {
      datasetBusy.delete(id)
      endIndexing(`dataset:${id}`)
      await postDatasetStatus()
    }
  }

  async function handleClearDataset(id: string, resync: boolean): Promise<void> {
    if (datasetBusy.has(id)) return
    const config = await loadSettings()
    const dataset = (config.datasets ?? []).find((entry) => entry.id === id)
    if (dataset === undefined) return

    datasetBusy.add(id)
    const signal = beginIndexing(`dataset:${id}`)
    reportIndexing('dataset', `Clearing ${dataset.name}`)
    try {
      const semantic = await datasetSemantic(config, dataset)
      const { removed } = await clearDataset({
        datasetId: id,
        store: datasetStoreFor(id),
        signal,
        onProgress: (done, total, phase) => reportIndexing('dataset', phase, { done, total }),
        ...(semantic !== undefined
          ? { semantic: { writer: semantic.writer, collection: semantic.collection } }
          : {}),
      })
      const detail = `Cleared ${String(removed)} record(s).`
      datasetResults.set(id, { detail, failed: false, at: Date.now() })
      reportIndexing('dataset', 'Finished', { detail, running: false })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      datasetResults.set(id, { detail, failed: true, at: Date.now() })
      logger.warn(`dataset clear failed: ${detail}`)
      reportIndexing('dataset', 'Failed', { detail, running: false })
    } finally {
      datasetBusy.delete(id)
      endIndexing(`dataset:${id}`)
      await postDatasetStatus()
    }
    // Released before the resync, which takes the guard itself.
    if (resync) await runDatasetSync(id, 'rebuild')
  }

  function reconcileDatasetTimers(config: LightCodeConfig): void {
    for (const timer of datasetTimers.values()) clearInterval(timer)
    datasetTimers.clear()

    for (const dataset of config.datasets ?? []) {
      // Zero minutes means "only when asked", which is a real choice for a slow or expensive
      // collector — not a misconfiguration to correct into a default.
      const minutes = dataset.syncMinutes ?? 0
      if (dataset.enabled === false || minutes <= 0) continue
      const timer = setInterval(
        () => void runDatasetSync(dataset.id, 'scheduled'),
        minutes * 60 * 1000,
      )
      timer.unref?.()
      datasetTimers.set(dataset.id, timer)
    }
  }

  async function postDatasetStatus(): Promise<void> {
    const config = (await configManager.load()).config
    const datasets = config.datasets ?? []
    const collection = datasetCollectionName(config)
    const embedder = await resolveEmbedder(config).catch(() => undefined)

    const entries = await Promise.all(
      datasets.map(async (dataset) => {
        const store = datasetStoreFor(dataset.id)
        const records = await store.load()
        const times = records
          .map((record) => record.timestamp)
          .filter((at): at is number => at !== undefined)
        const search = await resolveDatasetSearch(config, dataset).catch(() => undefined)
        return {
          ...dataset,
          records: records.length,
          sizeBytes: await store.sizeBytes(),
          ...(times.length > 0 ? { oldest: Math.min(...times), newest: Math.max(...times) } : {}),
          ...((await store.lastSyncedAt()) !== undefined
            ? { lastSyncedAt: (await store.lastSyncedAt()) as number }
            : {}),
          busy: datasetBusy.has(dataset.id),
          ...(datasetResults.get(dataset.id) !== undefined
            ? {
                lastResult: (datasetResults.get(dataset.id) as { detail: string }).detail,
                lastFailed: (datasetResults.get(dataset.id) as { failed: boolean }).failed,
                lastAttemptAt: (datasetResults.get(dataset.id) as { at: number }).at,
              }
            : {}),
          storeLabel: search?.store.label ?? 'none',
        }
      }),
    )

    post({
      type: 'datasetStatus',
      datasets: entries,
      // Said plainly, because a dataset with no embedder still syncs and still searches — on words
      // rather than meaning — and someone seeing results would otherwise assume it is semantic.
      semantic: collection !== undefined && embedder !== undefined,
      /*
       * Python tools and MCP tools, selected by what they *are* rather than by group.
       *
       * Filtering on `group` was wrong and showed only the built-ins: a Python tool is registered
       * as `command`, because it runs code, and an MCP tool as `mcp`. Those two groups also hold
       * `execute_command` and the tool-authoring tools, which are not data sources — so the test
       * is the `py__` prefix and the mcp group, not a permission category. Reported as the picker
       * listing only built-in tools.
       */
      stores: Object.entries(config.vectorStores ?? {}).map(([id, store]) => ({
        id,
        label: store.label,
      })),
      // Resolved here, where the fallback chain lives. See the note on the message.
      defaultStoreLabel:
        (await resolveDatasetSearch(config).catch(() => undefined))?.store.label ?? 'none',
      tools: currentToolRegistry()
        .list()
        .filter((tool) => tool.name.startsWith('py__') || tool.group === 'mcp')
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          // Grouped in the picker, because "which of these is mine?" is the first question with
          // forty MCP tools in the list.
          kind: tool.name.startsWith('py__') ? ('python' as const) : ('mcp' as const),
        })),
      guidance: COLLECTOR_TOOL_GUIDANCE,
    })
  }

  async function handleSaveDataset(dataset: DatasetConfig): Promise<void> {
    const { config } = await configManager.load()
    const existing = config.datasets ?? []
    const next = existing.some((entry) => entry.id === dataset.id)
      ? existing.map((entry) => (entry.id === dataset.id ? dataset : entry))
      : [...existing, dataset]
    await configManager.save('user', { datasets: next })
    reconcileDatasetTimers((await configManager.load()).config)
    await postDatasetStatus()
  }

  async function handleDeleteDataset(id: string): Promise<void> {
    const { config } = await configManager.load()
    /*
     * The vectors and the local file go too.
     *
     * Removing only the config entry would orphan every vector in the shared collection with
     * nothing left that knows their ids — they would keep being returned by searches of the other
     * datasets, attributed to a dataset that no longer exists.
     */
    await handleClearDataset(id, false)
    await configManager.save('user', {
      datasets: (config.datasets ?? []).filter((entry) => entry.id !== id),
    })
    datasetResults.delete(id)
    reconcileDatasetTimers((await configManager.load()).config)
    await postDatasetStatus()
  }

  function reconcileMailTimer(config: LightCodeConfig): void {
    if (mailTimer !== undefined) {
      clearInterval(mailTimer)
      mailTimer = undefined
    }
    if (config.mail?.enabled !== true || !officeAvailable() || config.office?.outlook !== true)
      return

    const minutes = config.mail.syncMinutes ?? 15
    mailTimer = setInterval(() => void runMailSync('scheduled'), minutes * 60 * 1000)
    // `unref` so a pending tick never keeps the process alive in the Node host.
    mailTimer.unref?.()
  }

  async function postMailStatus(): Promise<void> {
    const config = (await configManager.load()).config
    const records = await mailStore.load()
    const times = records.map((record) => record.receivedAt)
    const collection = mailCollectionName(config)
    const search = await resolveMailSearch(config).catch(() => undefined)
    const embedder = await resolveEmbedder(config).catch(() => undefined)

    post({
      type: 'mailStatus',
      enabled: config.mail?.enabled === true,
      available: officeAvailable() && config.office?.outlook === true,
      folders: config.mail?.folders ?? [],
      syncMinutes: config.mail?.syncMinutes ?? 15,
      retentionMonths: config.mail?.retentionMonths ?? 6,
      includeSubfolders: config.mail?.includeSubfolders !== false,
      indexed: records.length,
      ...(times.length > 0 ? { oldest: Math.min(...times), newest: Math.max(...times) } : {}),
      sizeBytes: await mailStore.sizeBytes(),
      semantic: collection !== undefined && search !== undefined && embedder !== undefined,
      ...(config.retrieval?.stores?.mail !== undefined
        ? { storeId: config.retrieval.stores.mail }
        : {}),
      /*
       * Every configured connection, so the tab can offer a choice rather than requiring the
       * config file to be edited by hand. The mail store was reachable only that way for one
       * release, which from the outside is the same as not existing.
       */
      stores: Object.entries(config.vectorStores ?? {}).map(([id, store]) => ({
        id,
        label: store.label,
      })),
      busy: mailBusy,
      ...(mailLastResult !== undefined ? { lastResult: mailLastResult } : {}),
    })
  }

  /** Drops indexed mail past the retention window, vectors first so nothing is orphaned. */
  /**
   * Checks a folder path against the live mailbox, for the settings box.
   *
   * Reads nothing but the folder tree, so it is safe to call on every click. The canonical path
   * is returned and stored in place of what was typed: a folder added as `inbox/alerts` is saved
   * as Outlook spells it, so anything that later compares two paths agrees with itself.
   */
  /** The mailbox folder tree, so folders can be ticked rather than typed. */
  /** Every folder at or beneath the chosen ones, as Outlook currently has them. */
  async function expandSubfolders(chosen: readonly string[]): Promise<string[]> {
    try {
      const result = await office().request<{ folders: { path: string }[] }>({
        op: 'outlook.folders',
        depth: 8,
      })
      const all = result.folders.map((entry) => entry.path)
      const wanted = new Set<string>(chosen)
      for (const path of all) {
        if (chosen.some((root) => path === root || path.startsWith(`${root}\\`))) wanted.add(path)
      }
      return [...wanted]
    } catch {
      // Listing failed; index exactly what was chosen rather than nothing.
      return [...chosen]
    }
  }

  /**
   * The mailbox folder tree, cached on disk.
   *
   * Walking a mailbox is a server round trip per folder on Exchange, and the tree changes rarely -
   * somebody adds a folder every few weeks. Rescanning on every visit spends that cost for an
   * answer that is almost always identical, so it is written to disk and served from there, with
   * Refresh for the times it has genuinely changed.
   *
   * The cache is served *first* even when a refresh follows, so the tab paints immediately and
   * updates underneath rather than showing an empty box while a mailbox is walked.
   */
  async function handleRequestOutlookFolders(depth?: number, force = false): Promise<void> {
    const cachePath = path.join(storageDir, 'outlook-folders.json')

    let served = false
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) as {
        scannedAt: number
        folders: { name: string; path: string; depth: number; unread?: number | null }[]
      }
      post({
        type: 'outlookFolders',
        folders: cached.folders,
        scannedAt: cached.scannedAt,
        cached: true,
      })
      served = true
      if (!force) return
    } catch {
      // No cache yet, or unreadable. Scan.
    }

    try {
      const result = await office().request<{
        folders: { name: string; path: string; depth: number; unread?: number | null }[]
      }>({ op: 'outlook.folders', depth: depth ?? 6 })
      const scannedAt = Date.now()
      post({ type: 'outlookFolders', folders: result.folders, scannedAt })
      try {
        await fs.mkdir(path.dirname(cachePath), { recursive: true })
        await fs.writeFile(
          cachePath,
          JSON.stringify({ scannedAt, folders: result.folders }),
          'utf8',
        )
      } catch {
        // A cache that will not write costs a rescan next time, never the answer.
      }
    } catch (error) {
      // Only if nothing was shown: replacing a usable cached tree with an error message would
      // take away the folders someone was about to tick.
      if (!served) {
        post({
          type: 'outlookFolders',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  async function handleValidateMailFolder(requested: string): Promise<void> {
    try {
      const result = await office().request<{
        ok: boolean
        canonical?: string
        how?: string
        items?: number
        error?: string
        suggestions?: string[]
      }>({ op: 'outlook.validateFolder', path: requested })

      post({
        type: 'mailFolderValidated',
        requested,
        ok: result.ok,
        ...(result.canonical !== undefined ? { canonical: result.canonical } : {}),
        ...(result.how !== undefined ? { how: result.how } : {}),
        ...(result.items !== undefined ? { items: result.items } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.suggestions !== undefined ? { suggestions: result.suggestions } : {}),
      })
    } catch (error) {
      post({
        type: 'mailFolderValidated',
        requested,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Throws the mail index away, and optionally starts again.
   *
   * **Vectors first, then the facts**, which is `pruneMail`'s ordering and for the same reason:
   * the sidecar is what names the vectors, so clearing it first would strand every one of them in
   * the collection with nothing left that knows their ids.
   *
   * Reindexing is clear-then-collect rather than a separate path. There is no way to re-embed
   * what is already held - the record keeps a preview, not the message - so "index it again"
   * genuinely does mean fetching it from Outlook again, and pretending otherwise would produce a
   * cheap-looking button that quietly did much less than it said.
   *
   * It is a full re-fetch of history, so on a large mailbox it runs over many passes exactly as
   * the first index did. The result line says so rather than leaving someone watching a bar that
   * finishes and then starts again.
   */
  async function handleClearMailIndex(resync: boolean): Promise<void> {
    if (mailBusy) return
    mailBusy = true
    const signal = beginIndexing('mail')
    reportIndexing('mail', 'Clearing the index')
    try {
      const config = await loadSettings()
      const collection = mailCollectionName(config)
      const search = await resolveMailSearch(config)
      const records = await mailStore.load()

      if (search !== undefined && collection !== undefined && records.length > 0) {
        const writer = createVectorIndexWriter(
          httpClient,
          search.store,
          await vectorStoreConnectionFor(search.store, search.id),
        )
        await deleteInBatches(
          writer,
          collection,
          records.map((record) => `mail:${record.id}`),
          (done, total) => reportIndexing('mail', 'Removing vectors', { done, total }),
          signal,
        )
      }

      await mailStore.clear()
      mailLastResult = `Cleared ${String(records.length)} message(s).`
      reportIndexing('mail', 'Finished', { detail: mailLastResult, running: false })
    } catch (error) {
      const stopped = signal.aborted
      mailLastResult = stopped ? 'Stopped.' : error instanceof Error ? error.message : String(error)
      reportIndexing('mail', stopped ? 'Stopped' : 'Failed', {
        detail: mailLastResult,
        running: false,
      })
      mailBusy = false
      endIndexing('mail')
      await postMailStatus()
      return
    }

    // Released before the resync, which takes the guard itself.
    mailBusy = false
    endIndexing('mail')
    await postMailStatus()

    if (resync) {
      mailLastResult = 'Cleared. Collecting again - a large mailbox fills in over several passes.'
      await postMailStatus()
      await runMailSync('reindex')
    }
  }

  /**
   * Re-reads a recent window and replaces what it finds.
   *
   * Everything the ordinary sync builds is shared - the same folder expansion, the same harvest,
   * the same embedding - because a repair that read the mailbox differently from the thing it is
   * repairing would be its own source of gaps.
   */
  async function handleRefreshMail(days: number): Promise<void> {
    /*
     * Every way out of here says something.
     *
     * Reported from real use: "nothing happened, no progress bar". Two of the three guards below
     * returned in silence, so a button the user had just pressed did nothing and explained
     * nothing - and the most likely one, `mailBusy`, fires precisely when the automatic timer
     * happens to be mid-sync, which is invisible from the tab. A control that answers nothing is
     * indistinguishable from a broken one, and it also robs the user of the one clue that would
     * let them diagnose the gaps they were chasing.
     */
    if (mailBusy) {
      mailLastResult = 'A mail sync is already running — wait for it to finish, then try again.'
      await postMailStatus()
      return
    }
    const config = await loadSettings()
    if (cachedOffice.outlook !== true) {
      mailLastResult = 'Outlook is switched off in Settings → Tools.'
      await postMailStatus()
      return
    }
    if (!officeAvailable()) {
      // Named rather than lumped in with the switch: this host cannot reach Outlook at all, which
      // is a different thing to fix from a setting the user can turn on.
      mailLastResult = 'Outlook is not available on this host.'
      await postMailStatus()
      return
    }
    const chosen = config.mail?.folders ?? []
    if (chosen.length === 0) {
      mailLastResult = 'No folders selected.'
      await postMailStatus()
      return
    }
    const folders =
      config.mail?.includeSubfolders === false ? chosen : await expandSubfolders(chosen)

    mailBusy = true
    const signal = beginIndexing('mail')
    reportIndexing('mail', `Re-reading the last ${String(days)} day(s)`, {
      detail: `${String(folders.length)} folder(s)`,
    })
    try {
      const embedder = await resolveEmbedder(config)
      const search = await resolveMailSearch(config)
      const collection = mailCollectionName(config)

      const result = await refreshMail({
        days,
        signal,
        onProgress: (done: number, total: number, phase: string) =>
          reportIndexing('mail', phase, { done, total }),
        store: mailStore,
        folders,
        ...(config.mail?.previewChars !== undefined
          ? { previewChars: config.mail.previewChars }
          : {}),
        harvest: async (requests, limits) =>
          office().request<{ messages: HarvestedMessage[]; truncated: boolean }>({
            op: 'outlook.harvest',
            folders: requests,
            limit: limits.limit,
            previewChars: limits.previewChars,
          }),
        ...(embedder !== undefined && search !== undefined && collection !== undefined
          ? {
              semantic: {
                embedder,
                writer: createVectorIndexWriter(
                  httpClient,
                  search.store,
                  await vectorStoreConnectionFor(search.store, search.id),
                ),
                collection,
              },
            }
          : {}),
      })

      mailLastResult =
        result.added === 0
          ? `Nothing found in the last ${String(days)} day(s).`
          : `Re-read ${String(result.added)} message(s) from the last ${String(days)} day(s)` +
            `${result.more ? ' — the window held more than one batch, so run it again' : ''}.`
      reportIndexing('mail', 'Finished', { detail: mailLastResult, running: false })
    } catch (error) {
      const stopped = signal.aborted
      mailLastResult = stopped ? 'Stopped.' : error instanceof Error ? error.message : String(error)
      reportIndexing('mail', stopped ? 'Stopped' : 'Failed', {
        detail: mailLastResult,
        running: false,
      })
    } finally {
      mailBusy = false
      endIndexing('mail')
      await postMailStatus()
    }
  }

  /** Applies retention, quietly, as part of an ordinary sync. */
  async function pruneIfDue(config: LightCodeConfig): Promise<void> {
    const months = config.mail?.retentionMonths
    if (months === undefined) return
    try {
      const collection = mailCollectionName(config)
      const search = await resolveMailSearch(config)
      const result = await pruneMail({
        store: mailStore,
        months,
        ...(search !== undefined && collection !== undefined
          ? {
              semantic: {
                writer: createVectorIndexWriter(
                  httpClient,
                  search.store,
                  await vectorStoreConnectionFor(search.store, search.id),
                ),
                collection,
              },
            }
          : {}),
      })
      if (result.removed > 0) {
        logger.info(
          `mail retention: removed ${String(result.removed)} message(s) older than ${String(months)} month(s)`,
        )
      }
    } catch (error) {
      // Never fails the sync: mail that arrived is worth more than mail that did not leave.
      logger.warn(
        `mail retention failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async function handlePruneMail(): Promise<void> {
    if (mailBusy) return
    mailBusy = true
    try {
      const config = await loadSettings()
      const months = config.mail?.retentionMonths ?? 6
      const collection = mailCollectionName(config)
      const search = await resolveMailSearch(config)

      const result = await pruneMail({
        store: mailStore,
        months,
        ...(search !== undefined && collection !== undefined
          ? {
              semantic: {
                writer: createVectorIndexWriter(
                  httpClient,
                  search.store,
                  await vectorStoreConnectionFor(search.store, search.id),
                ),
                collection,
              },
            }
          : {}),
      })
      mailLastResult =
        result.removed === 0
          ? `Nothing older than ${String(months)} month(s) to remove.`
          : `Removed ${String(result.removed)} message(s), kept ${String(result.kept)}.`
    } catch (error) {
      mailLastResult = error instanceof Error ? error.message : String(error)
    } finally {
      mailBusy = false
      await postMailStatus()
    }
  }

  async function handleSaveMailSettings(settings: {
    enabled: boolean
    folders: string[]
    includeSubfolders: boolean
    syncMinutes: number
    retentionMonths: number
    storeId?: string
  }): Promise<void> {
    try {
      const { config: current } = await configManager.load()
      /*
       * Merged rather than replaced. `retrieval` also carries the dispatcher and the docs index,
       * set from a different tab - writing the whole block from here would silently clear them,
       * which is the drift this project has paid for more than once.
       */
      const stores = { ...(current.retrieval?.stores ?? {}) }
      if (settings.storeId !== undefined && settings.storeId.length > 0)
        stores.mail = settings.storeId
      else delete stores.mail

      await configManager.save('user', {
        retrieval: { ...(current.retrieval ?? {}), stores },
        mail: {
          enabled: settings.enabled,
          folders: settings.folders.filter((folder) => folder.trim().length > 0),
          includeSubfolders: settings.includeSubfolders,
          syncMinutes: settings.syncMinutes,
          retentionMonths: settings.retentionMonths,
        },
      })
      const config = await loadSettings()
      reconcileMailTimer(config)
      reconcileDatasetTimers(config)
      await postMailStatus()
      // A first sync right away, so switching it on visibly does something rather than waiting
      // out an interval before the first sign of life.
      if (config.mail?.enabled === true) void runMailSync('just enabled')
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  function codebaseIndexName(config?: LightCodeConfig): string | undefined {
    const chosen = config?.embedder?.indexName?.trim()
    if (chosen !== undefined && chosen.length > 0) return chosen
    if (workspaceRoot === undefined) return undefined
    /*
     * Derived from the owner *and* the workspace path. `rag/indexNaming.ts` holds the derivation
     * and the reasoning — the short version is that the path alone is collision-free between
     * projects and not between people, and two colleagues who clone to the same place is a
     * standardised build rather than a strange one.
     */
    return deriveIndexName({
      ...(config?.embedder?.indexPrefix !== undefined
        ? { prefix: config.embedder.indexPrefix }
        : {}),
      ...(indexOwner(config) !== undefined ? { owner: indexOwner(config) } : {}),
      workspaceRoot,
    })
  }

  /**
   * Where the tool and skill documentation corpus lives.
   *
   * Derived from the codebase index name rather than configured separately, so enabling
   * retrieval does not require the user to invent and type a second collection name. It is a
   * *separate* collection because the two corpora have different lifetimes: code changes on
   * every edit, the tool catalogue only when a server or skill is added.
   */
  /**
   * Where the team's shared skills live.
   *
   * Separate from the documentation index on purpose — see `retrieval.skillsIndex` for why
   * pointing a team alias at the tool-documentation corpus would have one person's reindex
   * racing another's stale sweep.
   */
  /**
   * Sends this machine's skills to the collection the team shares.
   *
   * Each person writes to their **own** collection and the alias is what makes them searchable
   * together — exactly as codebase indexes work, and for the same reason: one shared collection
   * would mean everybody's republish racing everybody else's.
   *
   * Skills carry their whole body, unlike a codebase chunk. A colleague has no file on this
   * machine to open afterwards, so the index has to be the entire answer. Skills are a page of
   * prose each, which is what makes that affordable.
   */
  /**
   * Names the shared skills pool, or clears it.
   *
   * A merge rather than a replace of the embedder block: the alias is set from the Skills tab
   * while the model and width are set from Search, and writing the whole block from either
   * would have one tab silently erasing the other's fields.
   */
  /** The panel's whole view of S3. Secrets never appear - only whether one is stored. */
  async function postS3(): Promise<void> {
    const { config } = await configManager.load()
    const connections = await Promise.all(
      (config.s3?.connections ?? []).map(async (connection) => ({
        id: connection.id,
        label: connection.label,
        bucket: connection.bucket,
        region: connection.region,
        accessKeyId: connection.accessKeyId,
        /*
         * Asked of the secret store rather than inferred from config holding a reference.
         *
         * Config and the store are two stores that can diverge, and letting one assert what only
         * the other knows is what made a vanished API key keep reading as "Set" for three
         * releases (section 19).
         */
        hasSecret: (await secrets.get(connection.secretAccessKeyRef)) !== undefined,
        ...(connection.endpoint !== undefined ? { endpoint: connection.endpoint } : {}),
        ...(connection.pathStyle !== undefined ? { pathStyle: connection.pathStyle } : {}),
        ...(connection.prefix !== undefined ? { prefix: connection.prefix } : {}),
        ...(connection.readOnly !== undefined ? { readOnly: connection.readOnly } : {}),
      })),
    )

    post({
      type: 's3',
      connections,
      problems: cachedS3.problems,
      skills: config.s3?.skills ?? [],
      tools: config.s3?.tools ?? [],
      skillsFolders: mirroredSkillsDirs,
      toolsFolders: mirroredToolsDirs,
      ...(lastSync.skills !== undefined ? { lastSkillsSync: lastSync.skills } : {}),
      ...(lastSync.tools !== undefined ? { lastToolsSync: lastSync.tools } : {}),
    })
  }

  /** `s3:<id>:secret`, namespaced so deleting a connection reliably deletes its key (section 15). */
  const s3SecretRef = (id: string): string => `s3:${id}:secret`
  const s3TokenRef = (id: string): string => `s3:${id}:sessionToken`

  async function handleSaveS3Connection(
    input: {
      id?: string
      label: string
      bucket: string
      region: string
      accessKeyId: string
      endpoint?: string
      pathStyle?: boolean
      prefix?: string
      readOnly?: boolean
    },
    secret?: string,
    sessionToken?: string,
  ): Promise<void> {
    const { config } = await configManager.load()
    const id = input.id ?? `s3-${Date.now().toString(36)}`
    const existing = (config.s3?.connections ?? []).find((connection) => connection.id === id)

    /*
     * An empty secret means "leave the stored one alone", never "clear it".
     *
     * Invariant 7 makes the field write-only, so the form shows a blank box for a key that is
     * perfectly well set. Read the other way, every save about a region or a prefix would wipe
     * the key on the way past - the trap `python.env` documents in those words.
     */
    if (secret !== undefined && secret.trim().length > 0) {
      await secrets.set(s3SecretRef(id), secret.trim())
    }
    if (sessionToken !== undefined && sessionToken.trim().length > 0) {
      await secrets.set(s3TokenRef(id), sessionToken.trim())
    }

    const saved = {
      id,
      label: input.label.trim(),
      bucket: input.bucket.trim(),
      region: input.region.trim(),
      accessKeyId: input.accessKeyId.trim(),
      secretAccessKeyRef: s3SecretRef(id),
      ...(existing?.sessionTokenRef !== undefined || (sessionToken ?? '').trim().length > 0
        ? { sessionTokenRef: s3TokenRef(id) }
        : {}),
      ...(input.endpoint !== undefined && input.endpoint.trim().length > 0
        ? { endpoint: input.endpoint.trim() }
        : {}),
      ...(input.pathStyle === true ? { pathStyle: true } : {}),
      ...(input.prefix !== undefined && input.prefix.trim().length > 0
        ? { prefix: input.prefix.trim() }
        : {}),
      ...(input.readOnly === true ? { readOnly: true } : {}),
    }

    const others = (config.s3?.connections ?? []).filter((connection) => connection.id !== id)
    await configManager.save('user', {
      s3: { ...(config.s3 ?? {}), connections: [...others, saved] },
    } as never)
    await loadSettings()
    await postS3()
  }

  async function handleDeleteS3Connection(id: string): Promise<void> {
    const { config } = await configManager.load()
    // The secrets too, not just the entry: orphans accumulate invisibly otherwise (section 15).
    await secrets.delete(s3SecretRef(id)).catch(() => undefined)
    await secrets.delete(s3TokenRef(id)).catch(() => undefined)

    const s3 = { ...(config.s3 ?? {}) }
    s3.connections = (s3.connections ?? []).filter((connection) => connection.id !== id)
    /*
     * Folders pointing at a connection that is gone are dropped, not left behind.
     *
     * One kept would silently stop working — and worse, its already-synced files stay on disk and
     * keep being loaded, so the skills would still be there with nothing anywhere to say where
     * they came from or why they had stopped updating.
     */
    s3.skills = (s3.skills ?? []).filter((mirror) => mirror.connectionId !== id)
    s3.tools = (s3.tools ?? []).filter((mirror) => mirror.connectionId !== id)
    if (s3.skills.length === 0) delete s3.skills
    if (s3.tools.length === 0) delete s3.tools

    await configManager.save('user', { s3 } as never)
    await loadSettings()
    await postS3()
  }

  /**
   * Replaces the whole list of folders for one kind.
   *
   * The whole list rather than one entry, because the panel edits it as a list and sending a
   * single row back would need an index the two sides would have to agree about — which is one
   * more thing to drift. The list is short and the message is cheap.
   */
  async function handleSaveS3Mirrors(
    kind: 'skills' | 'tools',
    mirrors: {
      connectionId: string
      prefix?: string | undefined
      enabled?: boolean | undefined
      publish?: boolean | undefined
    }[],
  ): Promise<void> {
    const { config } = await configManager.load()
    const s3 = { ...(config.s3 ?? {}) }

    const cleaned = mirrors
      .filter((mirror) => mirror.connectionId.trim().length > 0)
      .map((mirror) => ({
        connectionId: mirror.connectionId.trim(),
        ...(mirror.prefix !== undefined && mirror.prefix.trim().length > 0
          ? { prefix: mirror.prefix.trim() }
          : {}),
        ...(mirror.enabled === true ? { enabled: true } : {}),
        ...(mirror.publish === true ? { publish: true } : {}),
      }))

    if (cleaned.length === 0) delete s3[kind]
    else s3[kind] = cleaned

    await configManager.save('user', { s3 } as never)
    await loadSettings()
    /*
     * Fetched straight away. Waiting for the next panel open to find out whether a folder works
     * is the sort of delay that reads as the setting having done nothing at all.
     */
    if (cleaned.some((mirror) => mirror.enabled === true)) await handleSyncS3(kind)
    else await postS3()
  }

  /**
   * Brings a bucket folder down now.
   *
   * Reports what happened as one line rather than throwing: a sync that half worked is the
   * ordinary case on a large folder, and "three updated, one failed" is more use than a failure.
   */
  async function handleSyncS3(kind: 'skills' | 'tools'): Promise<void> {
    const { config } = await configManager.load()
    const mirrors = (config.s3?.[kind] ?? []).filter((mirror) => mirror.enabled === true)
    if (mirrors.length === 0) {
      lastSync = { ...lastSync, [kind]: 'No bucket folder is configured.' }
      await postS3()
      return
    }

    /*
     * Every folder is attempted, and one that fails does not stop the rest.
     *
     * Somebody with two sources and one stale key should still get the other — the same rule
     * `resolveS3` follows for connections, for the same reason: a partial answer is useful and a
     * blanket failure is not.
     */
    const lines: string[] = []
    for (const mirror of mirrors) {
      const target = targetById(cachedS3, mirror.connectionId)
      const where = `${mirror.connectionId}/${mirror.prefix ?? ''}`
      if (target === undefined) {
        lines.push(`${where}: connection unusable - check its key above`)
        continue
      }

      const localDir = mirrorFolder({
        storageDir,
        connectionId: mirror.connectionId,
        kind,
        ...(mirror.prefix !== undefined ? { prefix: mirror.prefix } : {}),
      })

      try {
        const result = await syncFromS3({
          target,
          ...(mirror.prefix !== undefined ? { prefix: mirror.prefix } : {}),
          localDir,
          fs: new NodeFileSystem(),
          extensions: kind === 'skills' ? ['.md'] : ['.py'],
        })
        const parts = [
          `${String(result.written.length)} updated`,
          `${String(result.unchanged)} unchanged`,
        ]
        if (result.failed.length > 0) parts.push(`${String(result.failed.length)} failed`)
        lines.push(`${target.label}${mirror.prefix === undefined ? '' : `/${mirror.prefix}`}: ${parts.join(', ')}`)
        for (const failure of result.failed) {
          logger.warn(`s3 ${kind}: ${failure.key}`, failure.problem)
        }
      } catch (error) {
        lines.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    lastSync = { ...lastSync, [kind]: `${new Date().toLocaleTimeString()} - ${lines.join('; ')}` }

    // The folders are in the search path, so what was just written has to be picked up.
    if (kind === 'skills') {
      await refreshSkills()
      postSkills()
    }
    await postS3()
  }

  /**
   * One picture from a skill, as a `data:` URI.
   *
   * Both halves are checked against what is on disk rather than trusted: the skill name picks a
   * *known* skill, and the picture must be one the folder actually has. A name from a message is
   * model- or panel-supplied text, and joining it into a path unchecked is how a request for a
   * picture becomes a request for a private key.
   */
  async function handleSkillImage(skillName: string, image: string): Promise<void> {
    const skill = skills.find((entry) => entry.name === skillName)
    if (skill === undefined) {
      post({ type: 'skillImage', skill: skillName, image, problem: 'No skill of that name.' })
      return
    }

    try {
      const available = await listSkillImages(skill.filePath, {
        readdir: async (dir) => {
          const entries = await fs.readdir(dir, { withFileTypes: true })
          return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
        },
      })
      if (!available.includes(image)) {
        post({ type: 'skillImage', skill: skillName, image, problem: 'That skill has no such picture.' })
        return
      }

      const folder = skill.filePath.slice(0, skill.filePath.length - 'SKILL.md'.length)
      const bytes = await fs.readFile(path.join(folder, SKILL_IMAGE_DIR, image))
      const dataUri = skillImageDataUri(image, bytes)
      post({
        type: 'skillImage',
        skill: skillName,
        image,
        ...(dataUri !== undefined ? { dataUri } : { problem: 'Not a picture this can show.' }),
      })
    } catch (error) {
      post({
        type: 'skillImage',
        skill: skillName,
        image,
        problem: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function handleSaveSkillsAlias(aliases: string[]): Promise<void> {
    try {
      const { config } = await configManager.load()
      const embedder = { ...(config.embedder ?? {}) }
      /*
       * Split by the one function that also merges them back, so the two spellings cannot
       * disagree about what was saved. See `rag/aliases.ts`.
       */
      const { primary, rest } = aliasFields(aliases)
      if (primary !== undefined) embedder.skillsAlias = primary
      else delete embedder.skillsAlias
      if (rest !== undefined) embedder.skillsAliases = rest
      else delete embedder.skillsAliases
      await configManager.save('user', { embedder })
      const { config: next } = await configManager.load()
      await postEmbedder(next)
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Deletes in batches, with progress.
   *
   * One request carrying twenty thousand ids is a request no backend enjoys and none of them
   * documents a limit for. Batching also means the bar moves: clearing a large mail index is the
   * one destructive action here that takes long enough for silence to read as a hang.
   */
  async function deleteInBatches(
    writer: VectorIndexWriter,
    collection: string,
    paths: readonly string[],
    report: (done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const size = 500
    for (let start = 0; start < paths.length; start += size) {
      if (signal?.aborted === true) throw new Error('Stopped.')
      await writer.deleteByPaths(collection, paths.slice(start, start + size), signal)
      report(Math.min(start + size, paths.length), paths.length)
    }
  }

  async function handlePublishTeamSkills(): Promise<void> {
    const config = await loadSettings()
    const collection = skillsIndexName(config)
    const search = await resolveSearch(config)
    const embedder = await resolveEmbedder(config)

    if (collection === undefined || search === undefined || embedder === undefined) {
      post({
        type: 'teamSkillsPublished',
        error:
          'Publishing skills needs a search connection and an embedding model in Settings → Search.',
      })
      return
    }

    const signal = beginIndexing('teamSkills')
    reportIndexing('teamSkills', 'Reading skills', { detail: `${String(skills.length)} skill(s)` })
    try {
      const withBodies: { skill: Skill; body: string }[] = []
      for (const skill of skills) {
        let body = ''
        try {
          body = await fs.readFile(skill.filePath, 'utf8')
        } catch {
          // A skill whose file has gone is skipped rather than published empty: an empty body
          // in the shared corpus would look to a colleague like a skill that says nothing.
          continue
        }
        withBodies.push({ skill, body })
      }

      const owner = indexOwner(config)
      const project = indexProject()
      const count = await indexTeamSkills({
        writer: createVectorIndexWriter(
          httpClient,
          search.store,
          await vectorStoreConnectionFor(search.store, search.id),
        ),
        embedder,
        collection,
        aliases: skillAliases(config),
        skills: withBodies,
        signal,
        onProgress: (done: number, total: number) =>
          reportIndexing('teamSkills', 'Embedding and sending', { done, total }),
        attribution: {
          ...(owner !== undefined ? { owner } : {}),
          ...(project !== undefined ? { project } : {}),
        },
      })

      post({ type: 'teamSkillsPublished', count, collection })
      reportIndexing('teamSkills', 'Finished', {
        detail: `Sent ${String(count)} skill(s).`,
        running: false,
      })
    } catch (error) {
      const stopped = signal.aborted
      const detail = stopped ? 'Stopped.' : error instanceof Error ? error.message : String(error)
      post({ type: 'teamSkillsPublished', error: detail })
      reportIndexing('teamSkills', stopped ? 'Stopped' : 'Failed', { detail, running: false })
    } finally {
      endIndexing('teamSkills')
    }
  }

  /**
   * Takes back everything this machine published.
   *
   * **Scoped to your own collection, never to the alias**, and that is the whole safety argument:
   * everyone publishes to a collection of their own, so deleting by name here cannot reach a
   * colleague's copy even where two people have both written a skill called `deployment`. Issuing
   * the same delete against the alias would fan out across every teammate's index.
   *
   * The names come from `listPaths` rather than from the local skills folder, so a skill that was
   * published and has since been renamed or deleted here is still removed there. Deriving them
   * from what is on disk would leave exactly those behind - the ones nobody can see any more and
   * so nobody thinks to clean up.
   */
  async function handleClearTeamSkills(): Promise<void> {
    const config = await loadSettings()
    const collection = skillsIndexName(config)
    const search = await resolveSearch(config)

    if (collection === undefined || search === undefined) {
      post({ type: 'teamSkillsPublished', error: 'No search connection configured.' })
      return
    }

    const signal = beginIndexing('teamSkills')
    reportIndexing('teamSkills', 'Finding what was published')
    try {
      const writer = createVectorIndexWriter(
        httpClient,
        search.store,
        await vectorStoreConnectionFor(search.store, search.id),
      )
      const paths = await writer.listPaths(collection, { signal })
      await deleteInBatches(
        writer,
        collection,
        paths,
        (done, total) => reportIndexing('teamSkills', 'Removing', { done, total }),
        signal,
      )
      post({
        type: 'teamSkillsPublished',
        count: 0,
        cleared: paths.length,
        collection,
      })
      reportIndexing('teamSkills', 'Finished', {
        detail: `Removed ${String(paths.length)} published skill(s).`,
        running: false,
      })
    } catch (error) {
      const stopped = signal.aborted
      const detail = stopped ? 'Stopped.' : error instanceof Error ? error.message : String(error)
      post({ type: 'teamSkillsPublished', error: detail })
      reportIndexing('teamSkills', stopped ? 'Stopped' : 'Failed', { detail, running: false })
    } finally {
      endIndexing('teamSkills')
    }
  }

  function skillsIndexName(config?: LightCodeConfig): string | undefined {
    const chosen = config?.retrieval?.skillsIndex?.trim()
    if (chosen !== undefined && chosen.length > 0) return chosen
    const base = codebaseIndexName(config)
    return base === undefined ? undefined : `${base}-skills`
  }

  function docsIndexName(config?: LightCodeConfig): string | undefined {
    const chosen = config?.retrieval?.docsIndex?.trim()
    if (chosen !== undefined && chosen.length > 0) return chosen
    const base = codebaseIndexName(config)
    return base === undefined ? undefined : `${base}-docs`
  }

  /**
   * The embedder, built over an existing provider profile.
   *
   * A profile already carries a working base URL, auth strategy, client certificate and CA.
   * Duplicating that would mean two places to get mutual TLS right instead of one.
   */
  async function resolveEmbedder(config: LightCodeConfig): Promise<Embedder | undefined> {
    const settings = config.embedder
    if (
      settings?.profileId === undefined ||
      settings.model === undefined ||
      settings.dimensions === undefined
    ) {
      return undefined
    }
    const profile = config.profiles?.find((candidate) => candidate.id === settings.profileId)
    if (profile === undefined) {
      logger.warn(`embedder points at profile "${settings.profileId}", which no longer exists`)
      return undefined
    }
    return new Embedder(httpClient, {
      profile,
      auth: authStrategyFor(config, profile),
      model: settings.model,
      dimensions: settings.dimensions,
    })
  }

  /**
   * Files git would not ignore, as a lookup set.
   *
   * `rg --files` rather than a hand-written `.gitignore` parser: ripgrep is already here,
   * and gitignore semantics — negation, `**`, anchoring, nested ignore files — are much
   * easier to get subtly wrong than to delegate. Returning `undefined` means "no ignore
   * information", and the indexer then relies on its own skip list alone.
   */
  async function ignoredFilesPredicate(): Promise<((relative: string) => boolean) | undefined> {
    // Asked now rather than at startup: an extension update moves the binary out from
    // under a session that is still running. See `HostServices.ripgrepPath`.
    const ripgrepPath = services.ripgrepPath()
    if (workspaceRoot === undefined || ripgrepPath === undefined) return undefined
    try {
      const listed = await new Promise<string>((resolve, reject) => {
        const child = spawn(ripgrepPath, ['--files', '--hidden', '--glob', '!.git'], {
          cwd: workspaceRoot,
        })
        let out = ''
        child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
        child.on('error', reject)
        // ripgrep exits 1 when it lists nothing, which is not an error here.
        child.on('close', () => resolve(out))
      })
      const allowed = new Set(
        listed
          .split(/\r?\n/)
          .filter((line) => line.length > 0)
          .map((line) => line.split(/[\\/]/).join('/')),
      )
      if (allowed.size === 0) return undefined
      // Directories are never reported as ignored: pruning them here would need the same
      // gitignore semantics this delegation exists to avoid. The per-file check is enough.
      return (relative) => !relative.endsWith('/') && !allowed.has(relative)
    } catch (error) {
      logger.warn(
        'could not list files with ripgrep; indexing will use its own skip list only',
        String(error),
      )
      return undefined
    }
  }

  let indexingAbort: AbortController | undefined

  /**
   * Saves one field of the `retrieval` block without dropping the others.
   *
   * `ConfigManager.save` merges one level only, so `{ retrieval: { skills: true } }` replaces
   * the whole block rather than adding to it. With a single toggle that was invisible; with two
   * it means each one silently switches the other off, and it has always quietly discarded a
   * hand-set `docsIndex` — which nothing in the UI writes, so nobody would connect the loss to
   * having clicked a checkbox.
   *
   * Merging here rather than making `save` deep: an array or a keyed map is *meant* to be
   * replaced, and a deep merge would make removing an entry from `approvals` or `profiles`
   * impossible. The nesting is this block's problem, so the fix belongs to this block.
   *
   * Reading the merged config is correct because `retrieval` is user-scope only (invariant 5),
   * so the merged view and the user file agree by construction.
   */
  async function saveRetrieval(
    patch: Partial<NonNullable<LightCodeConfig['retrieval']>>,
  ): Promise<void> {
    const { config } = await configManager.load()
    await configManager.save('user', { retrieval: { ...config.retrieval, ...patch } })
  }

  /**
   * Reports the dispatcher's state to the UI, including how many tools it is actually hiding.
   *
   * The count is the useful part: the setting is only worth having when the catalogue is big
   * enough to crowd the prompt, and "hides 2 tools" tells the user to leave it off far better
   * than any explanatory paragraph.
   */
  async function postDispatcher(): Promise<void> {
    const { config } = await configManager.load()
    // The skill count is part of what this reports, and nothing else has necessarily loaded
    // it yet — the panel can be opened before a single turn has run.
    await refreshSkills()
    const enabled = dispatcherEnabled(config.retrieval)
    // Counted with the dispatcher forced on, so the number answers "how many *would* be
    // hidden" while it is still switched off.
    const hidden = currentToolRegistry(
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
    ).dispatchOnlyList().length
    const index = docsIndexName(config)
    post({
      type: 'dispatcher',
      enabled,
      hiddenTools: hidden,
      skills: skillRetrievalEnabled(config.retrieval),
      hiddenSkills: skills.length,
      ...(index !== undefined ? { docsIndex: index } : {}),
    })
  }

  /**
   * Indexes the tool and skill documentation so `search_docs` can match by meaning.
   *
   * Separate from `handleStartIndexing` despite the similarity, because the two corpora have
   * nothing in common but the machinery: this one walks no files, respects no gitignore, and
   * changes when a server or skill is added rather than when code is edited. Folding them
   * together would mean re-embedding the whole workspace to pick up one new MCP tool.
   *
   * Small enough to write in one pass — a few hundred documents at most — so there is no
   * manifest, no incremental diffing and no progress reporting. It simply replaces the
   * collection's contents.
   */
  /**
   * The fingerprint of the corpus that was last written, kept beside the codebase manifests.
   *
   * Auto-reindexing without this would re-embed the whole catalogue every time an MCP server
   * reconnected, which happens on every panel open. Hashing what *would* be written and
   * comparing is far cheaper than embedding it — and the embedder model is part of the hash,
   * because changing model makes every stored vector incomparable with new ones.
   */
  function docsFingerprintPath(index: string, storeId: string, kind?: DocEntryKind): string {
    // One file per kind, plus the combined one. Sharing a file would mean a tools-only run
    // recording "everything is current" and a later full run doing nothing.
    const suffix = kind === undefined ? 'docs' : `docs.${kind}`
    return path.join(storageDir, 'index-manifests', `${manifestKey(index, storeId)}.${suffix}.json`)
  }

  /**
   * The bookkeeping key for one index **in one store**.
   *
   * These files record "everything up to here is already written", and that is a claim about a
   * particular collection in a particular backend — not about a name. Keyed on the name alone,
   * switching from OpenSearch to Qdrant left a manifest asserting the new, empty collection was
   * already populated: the codebase indexer would skip every unchanged file and the docs
   * reindex would report `unchanged` and write nothing, so search returned no results with no
   * error anywhere. Silence is the worst shape that failure could take.
   *
   * Including the store id means switching backends starts from an honest blank slate, and
   * switching *back* finds the earlier manifest still valid — the data in that cluster never
   * went anywhere.
   */
  function manifestKey(index: string, storeId: string): string {
    return `${index}@${storeId}`
  }

  /** Where that manifest lives. Spelled out at four call sites before this. */
  function manifestPath(index: string, storeId: string): string {
    return path.join(storageDir, 'index-manifests', `${manifestKey(index, storeId)}.json`)
  }

  async function readDocsFingerprint(
    index: string,
    storeId: string,
    kind?: DocEntryKind,
  ): Promise<string | undefined> {
    try {
      const raw = JSON.parse(
        await fs.readFile(docsFingerprintPath(index, storeId, kind), 'utf8'),
      ) as {
        fingerprint?: unknown
      }
      return typeof raw.fingerprint === 'string' ? raw.fingerprint : undefined
    } catch {
      return undefined
    }
  }

  interface DocsIndexOutcome {
    indexed?: number
    index?: string
    error?: string
    /** True when the corpus was already up to date and nothing was embedded. */
    unchanged?: boolean
  }

  /**
   * Writes the tool and skill documentation corpus into its collection.
   *
   * `force` is what separates the button from the automatic path: pressing Index
   * documentation should visibly do something even when nothing has changed, whereas the
   * automatic trigger must cost nothing when the catalogue is the same as last time.
   */
  /**
   * Rebuilds the documentation index, optionally for one kind of entry only.
   *
   * `kind` exists because the two halves change for different reasons and at different moments:
   * you add an MCP server and want its tools findable, or you write a skill and want that one
   * findable. Being made to reindex both is not slow so much as *unclear* — it invites the
   * question of whether the other half was disturbed.
   *
   * The dangerous part is the stale sweep, which deletes anything in the store the freshly built
   * corpus does not contain. Left unscoped during a partial run it would cheerfully delete every
   * skill while reindexing tools, since none of them would be in the corpus it built. Hence the
   * id-prefix filter, and hence a partial run keeping its own fingerprint.
   */
  async function indexDocs(options: {
    force: boolean
    kind?: DocEntryKind
    report?: (phase: string, extra?: { done?: number; total?: number }) => void
    signal?: AbortSignal
  }): Promise<DocsIndexOutcome> {
    const { config } = await configManager.load()
    const index = docsIndexName(config)
    const search = await resolveSearch(config)
    const embedder = await resolveEmbedder(config)

    if (index === undefined)
      return { error: 'Open a folder first — the documentation index is named after it.' }
    if (search === undefined)
      return { error: 'Choose a search connection in Settings → Search first.' }
    if (embedder === undefined)
      return { error: 'Configure an embedding model in Settings → Search first.' }

    try {
      /*
       * Built with the dispatcher forced on, whatever the current setting. Otherwise nothing
       * would be dispatch-only at this moment and the corpus would come out empty — indexing
       * has to describe the catalogue as it will be *used*, not as it happens to be right now.
       */
      options.report?.('Reading the catalogue')
      const registry = currentToolRegistry(undefined, undefined, undefined, undefined, true)
      const all = buildDocCorpus({ dispatchOnlyTools: registry.dispatchOnlyList(), skills })
      const wanted = options.kind
      const entries = wanted === undefined ? all : all.filter((entry) => entry.kind === wanted)

      const fingerprint = createHash('sha256')
        // Keyed by kind, so a tools-only run cannot mark the whole corpus as current and leave a
        // later full run believing there is nothing left to do.
        .update(`${wanted ?? 'all'}:${embedder.model}:${String(embedder.dimensions)}`)
        .update(entries.map((entry) => `${entry.id}\u0000${entry.text}`).join('\u0001'))
        .digest('hex')

      if (!options.force && fingerprint === (await readDocsFingerprint(index, search.id, wanted))) {
        return { unchanged: true, index, indexed: entries.length }
      }

      if (entries.length === 0) return { indexed: 0, index }

      const writer = createVectorIndexWriter(
        httpClient,
        search.store,
        await vectorStoreConnectionFor(search.store, search.id),
      )
      await writer.ensureCollection(index, embedder.dimensions)

      /*
       * Indeterminate on purpose while this runs. `embedBatch` is one call and reports nothing
       * from inside it, so counting off entries here would be a bar that invents its own
       * progress - the phase name is the honest answer instead.
       */
      options.report?.('Embedding', { total: entries.length })
      const vectors = await embedder.embedBatch(entries.map((entry) => entry.text))
      if (options.signal?.aborted === true) throw new Error('Stopped.')
      const documents = entries.flatMap((entry, position) => {
        const vector = vectors[position]
        if (vector === undefined) return []
        // `path` carries the qualified id — see rag/toolDocs.ts for why that field is reused
        // rather than adding a second collection shape across every backend.
        return [
          { id: entry.id, text: entry.text, path: entry.id, startLine: 1, endLine: 1, vector },
        ]
      })

      /*
       * Entries that vanished — a server removed, a skill deleted — are deleted first.
       * Upserting alone would leave them matchable forever, and `search_docs` would keep
       * offering a tool the model cannot call.
       */
      const keep = new Set(documents.map((document) => document.id))
      const stale = (await writer.listPaths(index)).filter((existing) => {
        if (keep.has(existing)) return false
        // A partial run sweeps only its own kind. See the note on `kind` above: this one line is
        // the difference between reindexing tools and silently deleting every skill.
        if (wanted === undefined) return true
        return parseDocEntryId(existing)?.kind === wanted
      })
      if (stale.length > 0) {
        options.report?.('Removing entries that have gone', { done: 0, total: stale.length })
        await writer.deleteByPaths(index, stale)
      }
      options.report?.('Writing', { done: 0, total: documents.length })
      await writer.upsert(index, documents)

      /*
       * Written only after the store accepted everything. A fingerprint saved before the
       * write would make a failed run look successful, and nothing would retry it.
       */
      await fs.mkdir(path.dirname(docsFingerprintPath(index, search.id, wanted)), {
        recursive: true,
      })
      await fs.writeFile(
        docsFingerprintPath(index, search.id, wanted),
        JSON.stringify({ fingerprint, indexedAt: Date.now(), count: documents.length }),
        'utf8',
      )

      return { indexed: documents.length, index }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Runs a query by hand, through the same code path the model uses.
   *
   * Deliberately the *same* path rather than a simplified one. A panel that approximated the
   * real search would prove something, just not the thing being debugged — the whole reason
   * `runDocsSearch` was split out of the tool is so this cannot drift from it.
   */
  async function handleSearchProbe(query: string, target: ProbeTarget): Promise<void> {
    try {
      const { config } = await configManager.load()
      const search = await resolveSearch(config)
      const embedder = await resolveEmbedder(config)

      if (target === 'data') {
        // Runs the tool the model runs, for the reason the mail probe does: a second query path
        // could disagree with the real one and would be believed.
        const datasets = config.datasets ?? []
        const collection = datasetCollectionName(config)
        const dataSearch = await resolveDatasetSearch(config)
        const tool = createSearchDataTool({
          load: async () =>
            Promise.all(
              datasets.map(async (dataset) => ({
                id: dataset.id,
                name: dataset.name,
                records: await new DatasetStore(storageDir, dataset.id).load(),
              })),
            ),
          ...(collection !== undefined && dataSearch !== undefined && embedder !== undefined
            ? { semantic: { searcher: dataSearch.searcher, embedder, collection } }
            : {}),
        })
        const result = await tool.execute({ query, limit: 25 }, {} as ToolExecutionContext)
        post({
          type: 'searchProbe',
          target,
          query,
          text: result.content,
          ...(result.isError === true ? { error: 'The search failed.' } : {}),
        })
        return
      }

      if (target === 'mail') {
        /*
         * Runs the tool the model runs, not a re-implementation of it.
         *
         * The whole value of a hand-run search is that it shows what the assistant would get. A
         * second query path here - however similar - could disagree with the real one, and would
         * be believed.
         */
        const collection = mailCollectionName(config)
        const mailSearch = await resolveMailSearch(config)
        const tool = createSearchMailTool({
          loadRecords: () => mailStore.load(),
          loadBackfill: () => mailStore.loadBackfillState(),
          ...(collection !== undefined && mailSearch !== undefined && embedder !== undefined
            ? { semantic: { searcher: mailSearch.searcher, embedder, collection } }
            : {}),
        })
        const result = await tool.execute({ query, limit: 25 }, {} as ToolExecutionContext)
        post({
          type: 'searchProbe',
          target,
          query,
          text: result.content,
          ...(result.isError === true ? { error: 'The search failed.' } : {}),
        })
        return
      }

      if (target === 'codebase') {
        const index = codebaseIndexName(config)
        if (search === undefined || embedder === undefined || index === undefined) {
          post({
            type: 'searchProbe',
            target,
            query,
            text: '',
            error:
              'Searching the codebase needs a connection, an embedding model and an indexed workspace.',
          })
          return
        }
        const tool = createSearchCodebaseTool({
          searcher: search.searcher,
          embedder,
          index,
          connectionLabel: search.store.label,
          observer: searchLog,
        })
        const result = await tool.execute({ query }, {} as ToolExecutionContext)
        post({
          type: 'searchProbe',
          target,
          query,
          text: result.content,
          ...(result.isError === true ? { error: 'The search failed.' } : {}),
        })
        return
      }

      /*
       * Built with the dispatcher forced on, so the probe searches the catalogue as it would
       * be *used*. With it off nothing is dispatch-only and the probe would report an empty
       * corpus, which says nothing about whether the index works.
       */
      const registry = currentToolRegistry(undefined, undefined, undefined, undefined, true)
      const docsIndex = docsIndexName(config)
      const tool = createSearchDocsTool({
        listTools: () => registry.list(),
        listSkills: () => skills,
        ...(search !== undefined && embedder !== undefined && docsIndex !== undefined
          ? { retrieval: { searcher: search.searcher, embedder, index: docsIndex } }
          : {}),
        observer: searchLog,
      })
      const result = await tool.execute({ query }, {} as ToolExecutionContext)
      post({
        type: 'searchProbe',
        target,
        query,
        text: result.content,
        ...(result.isError === true ? { error: 'The search failed.' } : {}),
      })
    } catch (error) {
      post({
        type: 'searchProbe',
        target,
        query,
        text: '',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Empties the documentation index.
   *
   * Done with the writer's own `listPaths` + `deleteByPaths` rather than a new drop-collection
   * method: every backend already has to support both for stale-entry reconciliation, so this
   * needs nothing added to `VectorIndexWriter` and works the same on whatever is configured.
   * The collection is left in place — deleting it would take its mapping and vector width
   * with it, and the next index would have to guess them again.
   *
   * The fingerprint file goes too. Without that the automatic reindex would compare the corpus
   * against a hash that still matches, decide nothing had changed, and leave the index empty
   * indefinitely.
   */
  /**
   * Copies this workspace's index out of another store into the active one.
   *
   * Exists so switching backend does not mean paying to re-embed a whole repository. The
   * safety condition — that both sides were embedded by the same model, at the same width,
   * with the same chunking — is read from the *source's* manifest, which the indexer already
   * writes for its own diffing. Mixing embeddings would produce confident, plausible, wrong
   * neighbours with no error anywhere, which is why this refuses rather than warns.
   *
   * The manifest is copied across on success, so the destination inherits an accurate record
   * of what it now contains and the next incremental index does the right thing.
   */
  async function handleSyncVectorStore(fromId: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const target = await resolveSearch(config)
      const source = config.vectorStores?.[fromId]
      if (target === undefined || source === undefined) {
        post({ type: 'storeSync', running: false, error: 'Choose a search connection first.' })
        return
      }
      if (fromId === target.id) {
        post({
          type: 'storeSync',
          running: false,
          error: 'That is the store you are already using.',
        })
        return
      }

      const index = codebaseIndexName(config)
      const embedder = await resolveEmbedder(config)
      if (index === undefined || embedder === undefined) {
        post({
          type: 'storeSync',
          running: false,
          error: 'Configure an embedding model in Settings → Search first.',
        })
        return
      }

      post({ type: 'storeSync', running: true, fromLabel: source.label })

      const sourcePath = manifestPath(index, fromId)
      const manifest = await fs
        .readFile(sourcePath, 'utf8')
        .then((raw) => JSON.parse(raw) as IndexManifest)
        .catch(() => undefined)

      const result = await syncVectorStores({
        from: createVectorIndexWriter(
          httpClient,
          source,
          await vectorStoreConnectionFor(source, fromId),
        ),
        to: createVectorIndexWriter(
          httpClient,
          target.store,
          await vectorStoreConnectionFor(target.store, target.id),
        ),
        collection: index,
        manifest,
        current: { model: embedder.model, dimensions: embedder.dimensions },
        onProgress: (progress) =>
          post({
            type: 'storeSync',
            running: true,
            copied: progress.copied,
            fromLabel: source.label,
          }),
      })

      // The destination inherits the record of what it now holds, so the next incremental
      // index diffs against the truth rather than re-embedding everything.
      if (manifest !== undefined) {
        const targetPath = manifestPath(index, target.id)
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.writeFile(targetPath, JSON.stringify(manifest), 'utf8')
      }

      post({ type: 'storeSync', running: false, copied: result.copied, fromLabel: source.label })
    } catch (error) {
      post({
        type: 'storeSync',
        running: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Empties the codebase index and forgets what was written.
   *
   * **The manifest goes with the vectors, and that ordering is the whole point.** The indexer
   * decides what to embed by diffing the workspace against that manifest, so clearing the
   * collection while leaving it behind produces the worst state available: an empty index that
   * believes it is complete, and an Index button that reports "nothing changed" for ever. Keyed
   * by `index@storeId` for the reason recorded next to `manifestKey`.
   */
  async function handleClearCodebaseIndex(): Promise<void> {
    const { config } = await configManager.load()
    const index = codebaseIndexName(config)
    const search = await resolveSearch(config)

    if (index === undefined || search === undefined) {
      post({ type: 'indexResult', error: 'Choose a search connection in Settings → Search first.' })
      return
    }

    const signal = beginIndexing('codebase')
    reportIndexing('codebase', 'Finding what is indexed')
    try {
      const writer = createVectorIndexWriter(
        httpClient,
        search.store,
        await vectorStoreConnectionFor(search.store, search.id),
      )
      const paths = await writer.listPaths(index, { signal })
      await deleteInBatches(
        writer,
        index,
        paths,
        (done, total) => reportIndexing('codebase', 'Removing', { done, total }),
        signal,
      )
      await fs.rm(manifestPath(index, search.id), { force: true })
      post({
        type: 'indexResult',
        result: {
          filesIndexed: 0,
          filesSkipped: 0,
          filesRemoved: paths.length,
          chunksWritten: 0,
          skipReasons: {},
        },
      })
      reportIndexing('codebase', 'Finished', {
        detail: `Removed ${String(paths.length)} chunk(s).`,
        running: false,
      })
      logger.info(`cleared codebase index "${index}"`)
    } catch (error) {
      const stopped = signal.aborted
      const detail = stopped ? 'Stopped.' : error instanceof Error ? error.message : String(error)
      post({ type: 'indexResult', error: detail })
      reportIndexing('codebase', stopped ? 'Stopped' : 'Failed', { detail, running: false })
    } finally {
      endIndexing('codebase')
    }
  }

  async function handleClearDocsIndex(kind?: DocEntryKind): Promise<void> {
    const { config } = await configManager.load()
    const index = docsIndexName(config)
    const search = await resolveSearch(config)

    if (index === undefined || search === undefined) {
      post({ type: 'docsIndexed', error: 'Choose a search connection in Settings → Search first.' })
      return
    }

    try {
      const writer = createVectorIndexWriter(
        httpClient,
        search.store,
        await vectorStoreConnectionFor(search.store, search.id),
      )
      /*
       * Filtered by kind, exactly as the stale sweep in `indexDocs` is.
       *
       * Tools and skills share one collection, so a Clear button on the Tools tab that deleted
       * every entry would take every skill with it - the same defect `rag/partialIndex.test.ts`
       * exists to prevent, arriving through the other door.
       */
      const all = await writer.listPaths(index)
      const existing =
        kind === undefined ? all : all.filter((id) => parseDocEntryId(id)?.kind === kind)
      if (existing.length > 0) await writer.deleteByPaths(index, existing)
      /*
       * The full fingerprint always goes, plus this kind's own.
       *
       * A scoped clear leaves the *other* kind's fingerprint alone - it is still accurate - but
       * the unscoped one now describes a corpus that is only half present, so keeping it would
       * make a later full run decide there was nothing to do.
       */
      await Promise.all(
        [undefined, ...(kind === undefined ? (['tool', 'skill'] as const) : [kind])].map((each) =>
          fs.rm(docsFingerprintPath(index, search.id, each), { force: true }),
        ),
      )
      post({ type: 'docsIndexed', indexed: 0, index })
      logger.info(`cleared ${String(existing.length)} documentation entries from "${index}"`)
    } catch (error) {
      post({ type: 'docsIndexed', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The button in the Tools and Skills tabs.
   *
   * Reported under the kind that was asked for, so the bar appears on the tab the button was
   * pressed on. Before this it reported nothing at all: pressing Reindex changed a label to
   * "Indexing..." and then, some seconds later, back again - which on a slow embedding endpoint
   * is indistinguishable from a button that does not work.
   */
  async function handleIndexDocs(kind?: DocEntryKind): Promise<void> {
    const reportKind: IndexingKind = kind === 'skill' ? 'skills' : 'tools'
    const signal = beginIndexing(reportKind)
    reportIndexing(reportKind, 'Starting')
    const outcome = await indexDocs({
      force: true,
      signal,
      report: (phase, extra) => reportIndexing(reportKind, phase, extra ?? {}),
      ...(kind === undefined ? {} : { kind }),
    })
    reportIndexing(reportKind, outcome.error === undefined ? 'Finished' : 'Failed', {
      running: false,
      ...(outcome.error !== undefined
        ? { detail: outcome.error }
        : outcome.indexed !== undefined
          ? { detail: `${String(outcome.indexed)} entr(ies) indexed.` }
          : {}),
    })
    endIndexing(reportKind)
    post({
      type: 'docsIndexed',
      ...(kind === undefined ? {} : { kind }),
      ...(outcome.indexed !== undefined ? { indexed: outcome.indexed } : {}),
      ...(outcome.index !== undefined ? { index: outcome.index } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    })
  }

  let docsReindexTimer: ReturnType<typeof setTimeout> | undefined
  let docsReindexRunning = false

  /**
   * Reindexes the documentation after the catalogue changes, without being asked.
   *
   * **Debounced, because the triggers arrive in bursts.** Opening the panel connects every
   * MCP server and each one fires a state change; a skill written by the model fires another.
   * A few seconds of quiet coalesces those into a single run.
   *
   * Silent by design. This is background upkeep, and a notification every time a server
   * reconnected would be worse than the staleness it fixes — the fingerprint means the common
   * case does no work at all. Failures are logged rather than surfaced, and the next trigger
   * retries because the fingerprint is only written on success.
   */
  function scheduleDocsReindex(reason: string): void {
    if (docsReindexTimer !== undefined) clearTimeout(docsReindexTimer)
    docsReindexTimer = setTimeout(() => {
      docsReindexTimer = undefined
      if (docsReindexRunning) {
        // A run is already in flight. Queue behind it rather than embedding the same corpus
        // twice concurrently and racing over which result lands last.
        scheduleDocsReindex(reason)
        return
      }
      docsReindexRunning = true
      void (async () => {
        try {
          const { config } = await configManager.load()
          /*
           * Only worth doing when the schemas are actually hidden — with the dispatcher off
           * nothing consults this index, so indexing would be pure cost.
           *
           * Read through `dispatcherEnabled`, not `=== true`. This was written when the
           * dispatcher was off by default, and reading the key directly meant that once the
           * default flipped, every user who had never opened the setting had their tools hidden
           * and their documentation never indexed — findable only by the lexical fallback,
           * which is exactly the "it does not pick up my tools" report this came from.
           */
          if (!dispatcherEnabled(config.retrieval)) return
          const outcome = await indexDocs({ force: false })
          if (outcome.error !== undefined) {
            logger.warn(`documentation reindex failed (${reason}): ${outcome.error}`)
          } else if (outcome.unchanged !== true) {
            logger.info(
              `documentation reindexed (${reason}): ${String(outcome.indexed ?? 0)} entries`,
            )
            post({
              type: 'docsIndexed',
              ...(outcome.indexed !== undefined ? { indexed: outcome.indexed } : {}),
              ...(outcome.index !== undefined ? { index: outcome.index } : {}),
            })
          }
        } finally {
          docsReindexRunning = false
        }
      })()
    }, 3_000)
  }

  async function handleStartIndexing(): Promise<void> {
    if (indexingAbort !== undefined) {
      post({ type: 'error', message: 'Indexing is already running.' })
      return
    }
    const { config } = await configManager.load()
    const index = codebaseIndexName(config)
    const search = await resolveSearch(config)
    const embedder = await resolveEmbedder(config)

    if (index === undefined || workspaceRoot === undefined) {
      post({ type: 'error', message: 'Open a folder before indexing.' })
      return
    }
    const root = workspaceRoot
    if (search === undefined) {
      post({ type: 'error', message: 'Choose a search connection in Settings → Search first.' })
      return
    }
    if (embedder === undefined) {
      post({ type: 'error', message: 'Configure an embedding model in Settings → Search first.' })
      return
    }

    indexingAbort = new AbortController()
    const manifestFile = manifestPath(index, search.id)
    const owner = indexOwner(config)
    const project = indexProject()
    const aliases = codebaseAliases(config)
    try {
      const manifest = await loadIndexManifest(manifestFile, embedder)
      const isIgnored = await ignoredFilesPredicate()

      const result = await indexWorkspace({
        workspaceRoot: root,
        index,
        embedder,
        // The one place a writer is built. Not reachable from any tool — a user starts this
        // from Settings, which is what keeps the model unable to write to a cluster at all.
        writer: createVectorIndexWriter(
          httpClient,
          search.store,
          await vectorStoreConnectionFor(search.store, search.id),
        ),
        denylist,
        manifest,
        saveManifest: async (next) => {
          await fs.mkdir(path.dirname(manifestFile), { recursive: true })
          await fs.writeFile(manifestFile, JSON.stringify(next), 'utf8')
        },
        ...(isIgnored !== undefined ? { isIgnored } : {}),
        /*
         * Attribution and the shared alias.
         *
         * Each person still writes to their own index — that keeps re-indexing cheap and one
         * person's rebuild from disturbing anyone else. The alias is what makes them
         * searchable together, and the owner is what lets a hit say whose it is.
         */
        ...(owner !== undefined ? { owner } : {}),
        ...(project !== undefined ? { project } : {}),
        alias: aliases,
        onProgress: (progress: IndexProgress) => post({ type: 'indexProgress', progress }),
        signal: indexingAbort.signal,
      })
      post({ type: 'indexResult', result })
    } catch (error) {
      post({
        type: 'indexResult',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      indexingAbort = undefined
    }
  }

  async function loadIndexManifest(file: string, embedder: Embedder): Promise<IndexManifest> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as IndexManifest
    } catch {
      // Missing or unreadable both mean "index everything", which is correct and safe —
      // the worst case is re-embedding work that was already done.
      return {
        model: embedder.model,
        dimensions: embedder.dimensions,
        chunkSignature: chunkSignatureFor(undefined),
        files: {},
      }
    }
  }

  async function postPython(): Promise<void> {
    const saved =
      (await configManager.load().then(
        (loaded) => loaded.config.python,
        () => undefined,
      )) ?? {}
    post({
      type: 'python',
      status: python.status(),
      settings: {
        dynamicTools: saved.dynamicTools ?? 'off',
        ...(saved.uvPath !== undefined ? { uvPath: saved.uvPath } : {}),
        ...(saved.toolsDir !== undefined ? { toolsDir: saved.toolsDir } : {}),
        ...(saved.venvPath !== undefined ? { venvPath: saved.venvPath } : {}),
        ...(saved.interpreterPath !== undefined ? { interpreterPath: saved.interpreterPath } : {}),
        // Sent so nothing the form cannot edit is invisible *and* silently rewritten.
        ...(saved.extraIndexUrls !== undefined ? { extraIndexUrls: saved.extraIndexUrls } : {}),
        ...(saved.indexUrl !== undefined ? { indexUrl: saved.indexUrl } : {}),
        ...(saved.offline !== undefined ? { offline: saved.offline } : {}),
        ...(saved.timeoutSeconds !== undefined ? { timeoutSeconds: saved.timeoutSeconds } : {}),
        /*
         * Names and literals, plus whether a secret one actually has a value stored.
         *
         * The `hasValue` question needs the secret store, which is why it is answered here rather
         * than in the tab: a variable marked secret with nothing behind it looks identical in
         * config to one that is set, and that is exactly the state somebody lands in after
         * declaring the variable and not filling it in.
         */
        env: await Promise.all(
          pythonEnvEntries(saved.env).map(async (entry) => ({
            name: entry.name,
            ...(entry.secret ? {} : { value: entry.value ?? '' }),
            secret: entry.secret,
            ...(entry.secret
              ? { hasValue: (await secrets.get(pythonEnvSecretRef(entry.name))) !== undefined }
              : {}),
          })),
        ),
        // The fallback when Python has no limit of its own.
        ...(cachedToolTimeoutSeconds !== undefined
          ? { defaultTimeoutSeconds: cachedToolTimeoutSeconds }
          : {}),
      },
    })
    // Python tools are part of the corpus, and this fires whenever the registry reloads —
    // a tool created, updated, deleted, or the folder pointed somewhere else.
    scheduleDocsReindex('Python tools changed')
  }

  /**
   * Saves what the Python tab edited, and nothing else.
   *
   * **A merge, not a replace, and that distinction cost somebody their virtualenv.** `save`
   * replaces whichever top-level keys it is given, so writing the whole `python` object from a
   * form silently erased every key the form did not happen to send. `extraIndexUrls` had no field
   * and was being dropped on every save already; adding `interpreterPath` made a second one, and
   * the report — a configured venv gone after an update — is what that looks like from outside.
   *
   * Exactly the reasoning `handleSaveSkillsAlias` records for the embedder block, which is split
   * across two tabs for the same reason. Anything nested and edited from more than one place has
   * to be merged, and `python` is now such a block whether or not it looks like one.
   */
  /**
   * Writes the variables: the declaration to config, a secret value to secret storage.
   *
   * Three things have to be true at once and none of them is the obvious default.
   *
   * A secret's value is **kept** when the form sends none. The form was never given it
   * (invariant 7), so "no value" means "unchanged" — read as "clear it", every save from the
   * tab would wipe every token on the way past.
   *
   * A variable that disappears from the list has its secret **deleted**, not orphaned. §15 is
   * explicit that namespaced keys exist so removal is real; a secret nothing references is one
   * nobody will ever find to clear.
   *
   * And a variable that stops being secret gives up its stored value, because leaving it would
   * mean a later re-tick silently resurrecting a value the user believes they replaced.
   */
  async function persistPythonEnv(
    existing:
      | Record<string, string | { value?: string | undefined; secret?: boolean | undefined }>
      | undefined,
    incoming: { name: string; value?: string; secret: boolean }[],
  ): Promise<Record<string, string | { value?: string; secret?: boolean }>> {
    const kept = new Set<string>()
    const out: Record<string, string | { value?: string; secret?: boolean }> = {}

    for (const variable of incoming) {
      const name = variable.name.trim()
      if (!isValidEnvName(name)) continue
      kept.add(name)
      if (variable.secret) {
        if (variable.value !== undefined && variable.value.length > 0) {
          await secrets.set(pythonEnvSecretRef(name), variable.value)
        }
        out[name] = { secret: true }
      } else {
        // A secret demoted to a literal must not leave its old value behind.
        await secrets.delete(pythonEnvSecretRef(name))
        out[name] = variable.value ?? ''
      }
    }

    for (const entry of pythonEnvEntries(existing)) {
      if (!kept.has(entry.name) && entry.secret)
        await secrets.delete(pythonEnvSecretRef(entry.name))
    }

    return out
  }

  async function handleSetPython(
    input: Extract<UiToHostMessage, { type: 'setPython' }>,
  ): Promise<void> {
    try {
      const existing = (await configManager.load()).config.python ?? {}
      await configManager.save('user', {
        python: {
          ...existing,
          dynamicTools: input.dynamicTools,
          ...(input.uvPath !== undefined
            ? input.uvPath.length > 0
              ? { uvPath: input.uvPath }
              : { uvPath: undefined }
            : {}),
          // Absent rather than empty when cleared, so the manager falls back to
          // `.lightcode/tools` instead of resolving an empty string against the workspace.
          ...(input.toolsDir !== undefined
            ? input.toolsDir.trim().length > 0
              ? { toolsDir: input.toolsDir.trim() }
              : { toolsDir: undefined }
            : {}),
          /*
           * Cleared means cleared, which is why each of these deletes rather than omitting.
           *
           * With the spread of `existing` above, omitting a blank field would *keep* the old
           * value — so emptying the box would appear to do nothing. The three-way distinction
           * matters: a field the form did not send is kept, a field it sent empty is removed.
           */
          ...(input.venvPath !== undefined
            ? input.venvPath.trim().length > 0
              ? { venvPath: input.venvPath.trim() }
              : { venvPath: undefined }
            : {}),
          ...(input.interpreterPath !== undefined
            ? input.interpreterPath.trim().length > 0
              ? { interpreterPath: input.interpreterPath.trim() }
              : { interpreterPath: undefined }
            : {}),
          ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
          ...(input.indexUrl !== undefined
            ? input.indexUrl.length > 0
              ? { indexUrl: input.indexUrl }
              : { indexUrl: undefined }
            : {}),
          ...(input.offline !== undefined ? { offline: input.offline } : {}),
          ...(input.env !== undefined
            ? { env: await persistPythonEnv(existing.env, input.env) }
            : {}),
        },
      })
      const { config } = await configManager.load()
      // Applied immediately rather than at the next turn: switching it on should show the
      // environment coming up, not sit silent until the user happens to send a message.
      await python.configure({ ...(config.python ?? {}), extraToolDirs: mirroredToolsDirs })
      await postPython()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function postEmbedder(config: LightCodeConfig): Promise<void> {
    const index = codebaseIndexName(config)
    let indexedFiles = 0
    if (index !== undefined) {
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(storageDir, 'index-manifests', `${index}.json`), 'utf8'),
        ) as IndexManifest
        indexedFiles = Object.keys(manifest.files ?? {}).length
      } catch {
        // No manifest yet means nothing has been indexed, which is the honest zero.
      }
    }
    post({
      type: 'embedder',
      ...(config.embedder?.profileId !== undefined ? { profileId: config.embedder.profileId } : {}),
      ...(config.embedder?.model !== undefined ? { model: config.embedder.model } : {}),
      ...(config.embedder?.dimensions !== undefined
        ? { dimensions: config.embedder.dimensions }
        : {}),
      ...(index !== undefined ? { indexName: index } : {}),
      // The configured value, not the resolved one, so the field round-trips what was typed
      // rather than replacing a blank with the default and looking like it was set.
      ...(config.embedder?.indexPrefix !== undefined
        ? { indexPrefix: config.embedder.indexPrefix }
        : {}),
      ...(config.embedder?.indexAlias !== undefined
        ? { indexAlias: config.embedder.indexAlias }
        : {}),
      /*
       * Both spellings of both, because the panel shows the merged list and cannot merge what it
       * was never sent. The singular halves stay for older configs and older builds; the panel
       * runs them through `codebaseAliases`/`skillAliases`, which is the one place that knows how
       * the two fit together.
       */
      ...(config.embedder?.indexAliases !== undefined
        ? { indexAliases: config.embedder.indexAliases }
        : {}),
      ...(config.embedder?.skillsAliases !== undefined
        ? { skillsAliases: config.embedder.skillsAliases }
        : {}),
      ...(config.embedder?.skillsAlias !== undefined
        ? { skillsAlias: config.embedder.skillsAlias }
        : {}),
      defaultIndexPrefix: DEFAULT_INDEX_PREFIX,
      indexedFiles,
    })
  }

  async function handleSaveEmbedder(
    profileId: string,
    model: string,
    dimensions: number,
    indexName?: string,
    indexPrefix?: string,
    indexAliases?: string[],
  ): Promise<void> {
    try {
      /*
       * The block is carried forward, not rebuilt.
       *
       * `ConfigManager` merges a patch **shallowly**, so naming `embedder` replaces the whole
       * block and anything absent here is deleted. The block is written from two panels — this
       * one owns the model and the codebase aliases, the Skills tab owns the shared skills alias
       * — so rebuilding it from this panel's fields alone silently erased the other's.
       * `embedderSave.test.ts` pins both halves against a real ConfigManager.
       */
      const { config: current } = await configManager.load()
      const embedder: Record<string, unknown> = {
        ...(current.embedder ?? {}),
        profileId,
        model,
        dimensions,
      }

      /*
       * Three-valued, and all three have to be distinguishable.
       *
       * `undefined` is "this panel sent nothing about it" — a save from elsewhere in the block —
       * and must leave the stored value alone. An empty string is somebody clearing the box,
       * which deletes the key. Anything else is the new value.
       *
       * Spreading the existing block made that distinction load-bearing: before it, omitting a
       * field deleted it for free, and a conditional spread was enough. Now an omitted field
       * survives, so clearing has to say so.
       */
      const put = (key: string, value: string | undefined): void => {
        if (value === undefined) return
        if (value.trim().length > 0) embedder[key] = value.trim()
        else delete embedder[key]
      }

      put('indexName', indexName)
      // Absent rather than empty when cleared, so the default applies instead of a name
      // beginning with a stray dash.
      put('indexPrefix', indexPrefix)

      // Cleared means absent, which is what turns team scope back off. Split by the one
      // function that also merges them back — see `rag/aliases.ts`.
      if (indexAliases !== undefined) {
        const { primary, rest } = aliasFields(indexAliases)
        if (primary !== undefined) embedder['indexAlias'] = primary
        else delete embedder['indexAlias']
        if (rest !== undefined) embedder['indexAliases'] = rest
        else delete embedder['indexAliases']
      }

      await configManager.save('user', { embedder } as never)
      const { config } = await configManager.load()
      await postEmbedder(config)
      /*
       * A changed prefix means different collection names, so whatever is in the new ones is
       * unrelated to what was in the old. The documentation corpus is small enough to just
       * rebuild; the codebase index is not, and the user has to press Index for that.
       */
      scheduleDocsReindex('index prefix changed')
      // Confirmed explicitly. The form resyncs to the same values it just sent, so without
      // this a successful save is visually indistinguishable from nothing happening.
      post({ type: 'embedderSaved' })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Lists models for a saved profile, reusing its stored credentials and TLS. */
  async function handleRequestEmbedderModels(profileId: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const profile = config.profiles?.find((candidate) => candidate.id === profileId)
      if (profile === undefined) {
        post({ type: 'embedderModels', models: [], warning: 'That profile no longer exists.' })
        return
      }
      const result = await listModels(httpClient, profile, authStrategyFor(config, profile))
      post({
        type: 'embedderModels',
        models: result.ids,
        ...(result.warning !== undefined ? { warning: result.warning } : {}),
      })
    } catch (error) {
      // Never fatal: a gateway that publishes no catalogue is normal, and free-text entry
      // has to keep working regardless (§9).
      post({
        type: 'embedderModels',
        models: [],
        warning: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** One SecretStorage key for the global key passphrase — there is only ever one. */
  const GLOBAL_PASSPHRASE_REF = 'tls:global:passphrase'

  async function postNetwork(): Promise<void> {
    const { config } = await configManager.load()
    // `passphraseRef` is dropped rather than sent: it is a pointer at a secret, and the UI
    // only ever needs to know whether one exists (invariant 7).
    const tls = { ...(config.tls ?? {}) }
    delete tls.passphraseRef
    post({
      type: 'network',
      settings: {
        ...(config.certDir !== undefined ? { certDir: config.certDir } : {}),
        tls,
        // The store, not config, decides this: the two can diverge, and only one of them
        // actually holds the passphrase.
        hasPassphrase: (await secrets.get(GLOBAL_PASSPHRASE_REF)) !== undefined,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      },
    })
  }

  async function handleSaveNetwork(input: NetworkSettingsInput): Promise<void> {
    try {
      const certDir = input.certDir?.trim()
      if (certDir !== undefined && certDir.length > 0) {
        // Invariant 6, checked at save time so the error names the field rather than
        // surfacing later as a puzzling handshake failure.
        assertCertDirOutsideWorkspace(certDir, workspaceRoot)
      }

      if (input.passphrase !== undefined) {
        if (input.passphrase.length > 0) await secrets.set(GLOBAL_PASSPHRASE_REF, input.passphrase)
        else await secrets.delete(GLOBAL_PASSPHRASE_REF)
      }

      const tls = stripEmpty(input.tls) as NonNullable<LightCodeConfig['tls']>
      if ((await secrets.get(GLOBAL_PASSPHRASE_REF)) !== undefined)
        tls.passphraseRef = GLOBAL_PASSPHRASE_REF

      await configManager.save('user', {
        certDir: certDir !== undefined && certDir.length > 0 ? certDir : undefined,
        tls,
      })
      // Trust material changed, so the cached strategy — and the token it holds — is stale.
      cachedAuth = undefined
      await postNetwork()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function postSearch(): Promise<void> {
    const { config } = await configManager.load()
    const connections: SearchConnectionSummary[] = []
    for (const [id, store] of Object.entries(config.vectorStores ?? {})) {
      connections.push({
        id,
        label: store.label,
        kind: store.kind,
        url: store.url,
        ...(store.defaultIndex !== undefined ? { defaultIndex: store.defaultIndex } : {}),
        ...(store.caFile !== undefined ? { caFile: store.caFile } : {}),
        ...(store.rejectUnauthorized !== undefined
          ? { rejectUnauthorized: store.rejectUnauthorized }
          : {}),
        ...(store.limits !== undefined ? { limits: store.limits } : {}),
        // Booleans only — the values never cross the bridge (invariant 7).
        hasUsername: (await secrets.get(searchUserRefFor(id))) !== undefined,
        hasPassword: (await secrets.get(searchPasswordRefFor(id))) !== undefined,
      })
    }
    post({ type: 'search', connections, activeConnectionId: config.activeVectorStoreId })
    await postEmbedder(config)
  }

  /** Builds a client from unsaved form state, so Test and index listing work before saving. */
  async function clientFromInput(input: SearchConnectionInput): Promise<OpenSearchClient> {
    const id = input.id ?? '__unsaved__'
    if (input.username !== undefined && input.username.length > 0)
      await secrets.set(searchUserRefFor(id), input.username)
    if (input.password !== undefined && input.password.length > 0)
      await secrets.set(searchPasswordRefFor(id), input.password)

    const store: VectorStoreConfig = {
      kind: 'opensearch',
      label: input.label.length > 0 ? input.label : 'Untitled',
      url: input.url,
      ...((await secrets.get(searchUserRefFor(id))) !== undefined
        ? { usernameRef: searchUserRefFor(id) }
        : {}),
      ...((await secrets.get(searchPasswordRefFor(id))) !== undefined
        ? { passwordRef: searchPasswordRefFor(id) }
        : {}),
      ...(input.caFile !== undefined && input.caFile.length > 0 ? { caFile: input.caFile } : {}),
      ...(input.rejectUnauthorized !== undefined
        ? { rejectUnauthorized: input.rejectUnauthorized }
        : {}),
    }
    return openSearchClientFor(store, id)
  }

  async function handleSaveSearchConnection(input: SearchConnectionInput): Promise<void> {
    try {
      if (input.url.trim().length === 0) {
        post({ type: 'error', message: 'Enter the cluster URL.' })
        return
      }
      const { config } = await configManager.load()
      const id = input.id ?? randomUUID()

      if (input.username !== undefined && input.username.length > 0)
        await secrets.set(searchUserRefFor(id), input.username)
      if (input.password !== undefined && input.password.length > 0)
        await secrets.set(searchPasswordRefFor(id), input.password)

      const store: VectorStoreConfig = {
        kind: input.kind ?? 'opensearch',
        label: input.label.trim().length > 0 ? input.label.trim() : 'OpenSearch',
        url: input.url.trim(),
        ...((await secrets.get(searchUserRefFor(id))) !== undefined
          ? { usernameRef: searchUserRefFor(id) }
          : {}),
        ...((await secrets.get(searchPasswordRefFor(id))) !== undefined
          ? { passwordRef: searchPasswordRefFor(id) }
          : {}),
        ...(input.defaultIndex !== undefined && input.defaultIndex.trim().length > 0
          ? { defaultIndex: input.defaultIndex.trim() }
          : {}),
        ...(input.caFile !== undefined && input.caFile.trim().length > 0
          ? { caFile: input.caFile.trim() }
          : {}),
        ...(input.rejectUnauthorized !== undefined
          ? { rejectUnauthorized: input.rejectUnauthorized }
          : {}),
        ...(input.limits !== undefined ? { limits: input.limits } : {}),
      }

      await configManager.save('user', { vectorStores: { ...config.vectorStores, [id]: store } })
      await postSearch()
      // Only after the write succeeded: the form uses this to decide it can close.
      post({ type: 'searchConnectionSaved', id })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeleteSearchConnection(id: string): Promise<void> {
    const { config } = await configManager.load()
    const remaining = { ...config.vectorStores }
    delete remaining[id]
    await secrets.delete(searchUserRefFor(id))
    await secrets.delete(searchPasswordRefFor(id))
    await configManager.save('user', {
      vectorStores: remaining,
      ...(config.activeVectorStoreId === id ? { activeVectorStoreId: undefined } : {}),
    })
    await postSearch()
  }

  async function handleRequestSearchIndexes(input: SearchConnectionInput): Promise<void> {
    try {
      const indexes = await (await clientFromInput(input)).listIndexes()
      post({ type: 'searchIndexes', indexes })
    } catch (error) {
      // Never fatal: `_cat` is often denied to a low-privilege account while `_search`
      // is allowed, so free-text entry has to keep working (§9).
      post({
        type: 'searchIndexes',
        indexes: [],
        warning: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function handleTestSearchConnection(input: SearchConnectionInput): Promise<void> {
    try {
      const info = await (await clientFromInput(input)).ping()
      post({
        type: 'searchTestResult',
        ok: true,
        detail: `Connected to ${info.clusterName ?? 'the cluster'}${info.version !== undefined ? ` (OpenSearch ${info.version})` : ''}.`,
      })
    } catch (error) {
      post({
        type: 'searchTestResult',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Tells the composer whether to offer image attachment for the active model (§9). */
  async function postCapabilities(): Promise<void> {
    try {
      const { config } = await configManager.load()
      const profile = resolveActiveProfile(config)
      const capabilities = resolveModelCapabilities(profile.model, profile.modelCapabilities)
      post({
        type: 'capabilities',
        supportsVision: capabilities.supportsVision,
        supportsTools: capabilities.supportsTools,
        contextWindow: capabilities.contextWindow,
      })
    } catch {
      // No profile configured yet — the composer simply offers no attachment button.
      post({ type: 'capabilities', supportsVision: false, supportsTools: true, contextWindow: 0 })
    }
  }

  async function handleRequestModels(input: ProfileInput): Promise<void> {
    try {
      const built = await profileFromForm(input)
      if (built === undefined) return

      const { config } = await configManager.load()
      const strategy = authStrategyFor(config, built.profile)
      const result = await listModels(httpClient, built.profile, strategy)
      post({
        type: 'models',
        models: result.ids,
        ...(result.warning !== undefined ? { warning: result.warning } : {}),
      })
    } catch (error) {
      // listModels itself never throws; this catches config/secret failures above it.
      post({
        type: 'models',
        models: [],
        warning: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function handleTestConnection(input: ProfileInput): Promise<void> {
    try {
      const built = await profileFromForm(input)
      if (built === undefined) return

      const { config } = await configManager.load()
      const result = await testConnection(
        built.profile,
        buildAuthContext(config, built.profile),
        httpClient,
      )
      post({ type: 'testConnectionResult', ok: result.ok, steps: result.steps })
    } catch (error) {
      post({
        type: 'testConnectionResult',
        ok: false,
        steps: [
          {
            step: 'certificates',
            status: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      })
    }
  }

  /** What this machine has to offer, so the chooser shows counts rather than category names. */
  async function handleRequestShareSections(): Promise<void> {
    try {
      const { config } = await configManager.load()
      post({
        type: 'shareSections',
        direction: 'export',
        sections: describeSections(config),
        selected: defaultSelection(config),
      })
    } catch (error) {
      post({
        type: 'shareSections',
        direction: 'export',
        sections: [],
        selected: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Opens an import file and reports what is in it, changing nothing.
   *
   * Split out of `handleImportConfig` because the import used to read and save in one act — so the
   * first sight of what a colleague's file contained was your own settings already replaced. This
   * is the "show what is going to be imported" half, and it is also what makes the section
   * chooser possible on the way in as well as out.
   */
  async function handlePreviewImport(): Promise<void> {
    const fail = (message: string): void => {
      post({ type: 'shareSections', direction: 'import', sections: [], selected: [], error: message })
    }
    try {
      const source = await ui.showOpenDialog({ kind: 'file', extensions: ['json'] })
      if (source === undefined) return

      // Validated here, so a malformed file is reported before anything is ticked rather than
      // after it is approved. `parseConfig` throws with a readable, field-level message.
      const imported = parseConfig(await fs.readFile(source, 'utf8'))
      post({
        type: 'shareSections',
        direction: 'import',
        sections: describeSections(imported),
        /*
         * Only what the file actually has. `defaultSelection` also drops the off-by-default
         * sections, which is right on the way out and wrong here: somebody who deliberately
         * exported their schedules and sent them expects to see them offered.
         */
        selected: describeSections(imported)
          .filter((section) => section.present)
          .map((section) => section.id),
        path: source,
      })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Config export never includes secrets — the config file only ever holds `apiKeyRef` pointers,
   * never key values (§15). What `sections` controls is which *settings* travel, which is a
   * separate question: some of a config is about one machine, and some of it is nobody else's
   * business. See `config/share.ts`.
   */
  async function handleExportConfig(sections?: string[]): Promise<void> {
    try {
      const { config } = await configManager.load()
      const chosen =
        sections ?? SHARE_SECTIONS.map((section) => section.id)
      const exported = buildExport(config, chosen as ShareSectionId[])

      const target = await ui.showSaveDialog({
        defaultName: 'light-code-config.json',
        extensions: ['json'],
      })
      if (target === undefined) return
      await fs.writeFile(target, JSON.stringify(exported, null, 2), 'utf8')

      /*
       * Counted from what was actually written, not from what was ticked. A section can be
       * selected and contribute nothing, and telling somebody they exported eight things when the
       * file holds three is how a colleague ends up debugging an import that was never going to
       * carry what they expected.
       */
      const written = describeSections(exported).filter((section) => section.present)
      const needed = written.flatMap((section) => section.secretRefs)
      ui.showInfo(
        needed.length === 0
          ? `Exported ${String(written.length)} section(s) to ${target}.`
          : `Exported ${String(written.length)} section(s) to ${target}. Whoever imports it will need to enter: ${needed.join(', ')}.`,
      )
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleImportConfig(request: { path?: string; sections?: string[] }): Promise<void> {
    try {
      // Reuses the file the preview opened when there is one, so nobody is made to find it twice.
      const source = request.path ?? (await ui.showOpenDialog({ kind: 'file', extensions: ['json'] }))
      if (source === undefined) return

      const raw = await fs.readFile(source, 'utf8')
      const imported = parseConfig(raw) // throws ConfigValidationError with a readable message on bad input
      const chosen = (request.sections ?? SHARE_SECTIONS.map((section) => section.id)) as ShareSectionId[]

      const { config: existing } = await configManager.load()
      // Section by section, replacing rather than merging — see `applyImport` for why merging a
      // list has no honest answer.
      const merged = applyImport(existing, imported, chosen)

      // Exports deliberately carry no secrets, so an imported profile's `apiKeyRef`
      // points at a secret this machine may not have. Downgrade those to `none` rather
      // than leaving a dangling reference that fails later at request time, and name
      // the affected profiles so the user knows exactly which keys to re-enter.
      const needKeys: string[] = []
      const reconciled = await Promise.all(
        (merged.profiles ?? []).map(async (profile): Promise<ProviderProfile> => {
          if (profile.auth.type !== 'apiKey') return profile
          if ((await secrets.get(profile.auth.apiKeyRef)) !== undefined) return profile
          needKeys.push(profile.label)
          return { ...profile, auth: { type: 'none' } }
        }),
      )

      await configManager.save('user', {
        ...merged,
        ...(merged.profiles === undefined ? {} : { profiles: reconciled }),
      })
      await postProfiles()
      // The Agents tab lists these as the models a role can be given, so it goes stale the moment
      // the list changes — a provider added and then not offered reads as the tab being broken.
      await postAgents()
      /*
       * Everything else an import can have moved. Before this, importing anything but providers
       * left every other tab showing what was there a moment ago until the panel was reopened —
       * which reads exactly like the import having silently done nothing.
       */
      await postSkills()
      await postSettings()

      /*
       * Named individually rather than counted. "Re-enter 3 credentials" leaves somebody hunting
       * through tabs; naming them is the difference between a to-do and a puzzle.
       */
      const stillNeeded = describeSections(merged)
        .filter((section) => chosen.includes(section.id as ShareSectionId))
        .flatMap((section) => section.secretRefs)
        .filter((ref) => !needKeys.some((label) => ref.startsWith(`${label}:`)))

      const toEnter = [...needKeys.map((label) => `${label}: API key`), ...stillNeeded]
      ui.showInfo(
        toEnter.length > 0
          ? `Config imported. Credentials to enter: ${toEnter.join(', ')} (exports never include secrets).`
          : 'Config imported.',
      )
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleRollback(): Promise<void> {
    if (shadowGit === undefined || taskCheckpoint === undefined) {
      post({ type: 'error', message: 'There is no checkpoint to roll back to.' })
      return
    }
    try {
      await shadowGit.restore(taskCheckpoint)
      taskCheckpoint = undefined
      // The model's view of the files is now stale — say so rather than letting it keep
      // editing against content that no longer exists.
      conversation.addUserMessage('I rolled the workspace back to its state before your edits.')
      readFiles.clear()
      post({ type: 'rolledBack' })
      ui.showInfo('Workspace rolled back.')
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Writes Python tool source with a model chosen for code, when one is configured.
   *
   * Built here rather than in a host because building a provider means auth strategies, TLS
   * material and the wire adapter — the most security-sensitive construction in the product.
   * Duplicating that outside core to keep a feature host-only would be a far worse trade than the
   * one config key this adds, and the key is absent by default, so nothing changes for anyone who
   * does not set it.
   */
  /**
   * The expert, when this host consults a provider profile rather than the Claude CLI.
   *
   * Deliberately the same shape as `codeGeneratorFor` below, because it is the same act: one
   * request to a *different* configured profile, no tools offered, the text that comes back. The
   * differences from the CLI expert are all absences — no budget, no cost, no session — and they
   * are absences in this function rather than options set to zero somewhere.
   */
  /**
   * Sends one question to one specialist, whichever kind it is.
   *
   * The two paths differ only in *who* answers: the role's prompt, the briefing, the question and
   * the named files are assembled identically, so a reviewer behaves the same whether it is Claude
   * or a gateway. Folding that into one function is what keeps it true — two assemblies would
   * drift, and the symptom would be a role subtly better on one backend than the other.
   */
  async function consultAgent(
    agent: ResolvedAgent,
    request: { question: string; files?: string[] | undefined; signal?: AbortSignal | undefined },
  ): Promise<{ advice: string; label: string }> {
    const prompt = buildAgentPrompt({
      prompt: agent.prompt,
      question: request.question,
      // Decides the preamble as well as whether tools are offered below, so the two can never
      // disagree — a specialist told it can read, and then given nothing to read with, wastes a
      // step discovering that.
      usesTools: agent.usesTools,
      canWrite: agent.canWrite,
      ...(request.files !== undefined ? { files: request.files } : {}),
      /*
       * What exists in this workspace.
       *
       * Without it a specialist advises as though the assistant were a bare shell — proposing by
       * hand what a configured tool already does, or inventing a procedure an existing skill
       * documents. See `agents/briefing.ts` for why names are worth the tokens and schemas are not.
       */
      briefing: buildAgentBriefing({
        tools: agentBriefingTools?.() ?? [],
        skills,
        /*
         * Who else exists, so a plan cannot name a specialist nobody set up.
         *
         * Built here, above the `kind` branch, which is the point: the Claude CLI expert and a
         * provider-profile expert are given byte-identical briefings, so making a different model
         * the expert cannot change what it knows about the team. `briefing.test.ts` pins that,
         * because the two paths diverging is invisible until somebody switches expert and gets a
         * worse plan for no reason they could name.
         */
        team: cachedTeam,
        self: agent.role,
      }),
    })

    if (agent.kind === 'cli') {
      const cli = expertCli
      if (cli === undefined || !cli.available) throw new Error('The Claude CLI is not available.')

      /*
       * The bill does not care which role Claude is answering as.
       *
       * `recordConsultation` was wired only into `ask_expert` — the tool that predates roles — so
       * once Claude could be assigned to *any* role, a reviewer or a librarian backed by the CLI
       * spent real money that the meter never saw and the per-task budget never checked. Nothing
       * was visibly wrong: the spend panel simply under-reported, and a limit the user had set
       * quietly did not apply. That is §12b's own objection to the keep-alive timer — something
       * that spends money invisibly is the version nobody should trust — arriving through a
       * different door.
       *
       * Checked before the call and recorded after it, in the one place every CLI consultation
       * passes through, so a role added later is covered without anybody remembering.
       */
      if (cachedBudgetMatters) {
        const verdict = checkExpertBudget(expertSpend, effectiveExpertLimits())
        if (!verdict.allowed) throw new Error(verdict.message)
      }

      const answer = await consultExpert(cli, {
        question: prompt,
        /*
         * The workspace, so Claude's own Read/Grep resolve against the project rather than
         * wherever this process was started. Falls back to the process directory when no folder
         * is open — the consultation is still worth having without one.
         */
        cwd: workspaceRoot ?? process.cwd(),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      })
      // Recorded even when it failed: a consultation that errored partway can still have been
      // charged, and a meter that only counts successes drifts quietly downwards.
      recordConsultation({
        isError: answer.isError,
        ...(answer.costUsd !== undefined ? { costUsd: answer.costUsd } : {}),
      })

      if (answer.isError) throw new Error(answer.text)
      return { advice: answer.text, label: agent.label }
    }

    const { config } = await configManager.load()
    const profile = config.profiles?.find((candidate) => candidate.id === agent.profileId)
    if (profile === undefined) {
      throw new Error(`No profile "${agent.profileId ?? ''}" exists any more.`)
    }

    /*
     * The seat's thinking level, applied over the profile's.
     *
     * A copy rather than a mutation: the profile object is shared with everything else that uses
     * it this turn, and a seat changing how the *chat* model thinks would be a setting leaking
     * sideways out of the Agents tab.
     */
    const seatProfile =
      agent.thinking === undefined
        ? profile
        : {
            ...profile,
            thinking: { ...(profile.thinking ?? { level: agent.thinking }), level: agent.thinking },
          }

    const provider = createChatProvider(
      seatProfile,
      httpClient,
      authStrategyFor(config, profile),
      logger,
    )

    /*
     * A specialist can look things up for itself, read-only.
     *
     * It used to be a single request knowing only what was pasted into the question, which made a
     * reviewer guess at the code around a change and a librarian answer about skills it had never
     * read. The Claude CLI expert has had its own Read/Grep/Glob since §12b, and gathering its own
     * context is most of why its advice is better — this is that, for a provider.
     *
     * See `agents/consult.ts` for why the reads skip the approval gate and why the cap forces an
     * answer rather than an error.
     */
    /*
     * Nothing at all for a role the user has said does not need it.
     *
     * The programmer is handed a spec and asked to write; the tester reasons about the change
     * in front of it. Offering either a lookup budget buys a slower answer that is no better,
     * and the preamble above already told it so — these two decisions come from the same flag
     * so they cannot disagree.
     */
    /*
     * The librarian may write the skill itself, and the user still sees it first.
     *
     * Asked for directly. The objection was never that the librarian should not record what it
     * knows — it is the role that can see the gap — but that a consultation asks nobody, so a
     * skill written there would be prose injected into every later prompt that no human read.
     * `runConsultation` now routes anything in `ALWAYS_ASK_TOOLS` through the same gate the main
     * loop uses, which removes the objection rather than accepting it: the librarian calls
     * `write_skill`, and an ordinary approval shows the source before anything is recorded.
     *
     * Only the librarian, and only this tool. Every other specialist stays strictly read-only,
     * and `consultBoundary.test.ts` holds that line.
     */
    /*
     * What this specialist may do beyond reading, by name.
     *
     * The librarian records skills whatever else is set — that is the role's own job, and it was
     * the case that opened this door. `canWrite` adds the ordinary edit tools for a role the user
     * has switched it on for. Everything here is gated: `runConsultation` asks before any
     * non-read call, so this list widens *what can be proposed*, never what happens unasked.
     *
     * Deliberately a short list rather than the whole edit group. Creating a Python tool or
     * installing a macro is authorising a capability rather than making a change, and §13 wants a
     * human reading the source in a context less hurried than mid-consultation.
     */
    const extraTools = new Set<string>(agent.role === 'librarian' ? ['write_skill'] : [])
    if (agent.canWrite) {
      extraTools.add('write_to_file')
      extraTools.add('apply_diff')
      extraTools.add('write_skill')
    }

    const readOnly = agent.usesTools
      ? toolsForConsultation(agentBriefingTools?.() ?? [], extraTools)
      : []
    const context = consultationContext?.()
    const result = await runConsultation({
      provider,
      prompt,
      tools: readOnly,
      definitions: context === undefined ? [] : toToolDefinitions(readOnly),
      // With no context there is nothing to read *with*, so it answers from the question alone
      // rather than being offered tools that would fail.
      context: context ?? ({} as ToolExecutionContext),
      /*
       * The same gate the agent loop uses, so an approval raised by a specialist is
       * indistinguishable from one raised by the assistant — same prompt, same ground truth, same
       * always-ask rule. A second approval path would be a second place for the rule to be wrong.
       */
      approve: async (tool, args) => {
        const preview = await tool
          .preview?.(args as never, context ?? ({} as ToolExecutionContext))
          .catch(() => undefined)
        const decision = await approvalGate.requestApproval({
          id: `agent-${agent.role}-${String(Date.now())}-${tool.name}`,
          toolName: tool.name,
          group: tool.group,
          preview: preview ?? {
            kind: 'text',
            text: `The ${agent.role} wants to run ${tool.name}.`,
          },
        })
        return decision === 'approve'
      },
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      onStep: (name) => logger.info(`${agent.role} looked up ${name}`),
    })
    if (result.truncated) {
      logger.info(`${agent.role} reached its lookup limit and answered with what it had`)
    }
    return { advice: result.advice, label: agent.label }
  }

  function codeGeneratorFor(config: LightCodeConfig): CodeGenerator | undefined {
    /*
     * Off unless the host offers it. Checked here rather than only in the UI: the tool's
     * *parameters* change shape when a generator exists, so a hand-edited config would otherwise
     * make the extension ask for a specification instead of source with nothing in the panel to
     * explain why.
     */
    if (services.allowProgrammingProfile !== true) return undefined

    const id = config.programmingProfileId
    if (id === undefined || id.length === 0) return undefined

    const profile = config.profiles?.find((candidate) => candidate.id === id)
    /*
     * A named profile that no longer exists degrades to "the chat model writes it" rather than
     * failing the tool call. Quietly losing the split would be the bad outcome, so it is logged.
     */
    if (profile === undefined) {
      logger.warn(
        `programming provider "${id}" is configured but no such profile exists; the chat model will write tool source`,
      )
      return undefined
    }

    return async (request) => {
      const provider = createChatProvider(
        profile,
        httpClient,
        authStrategyFor(config, profile),
        logger,
      )
      let text = ''
      for await (const chunk of provider.streamChat(
        [{ role: 'user', content: buildCodeGenerationPrompt(request) }],
        {
          // No tools offered: it is being asked for a file, and offering tools invites it to use one.
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        },
      )) {
        if (chunk.type === 'text') text += chunk.text
      }
      return { source: text, producedBy: profile.label }
    }
  }

  /**
   * What this project has chosen for itself.
   *
   * Shown so a per-project setting is visible and reversible. A value that quietly differs here
   * from everywhere else, with nothing saying so, is worse than not being able to set one — the
   * user is left wondering why the same product behaves differently in two folders.
   */
  async function postProjectSettings(): Promise<void> {
    try {
      const { config } = await configManager.load()
      const stored = config.workspaces as Record<string, WorkspaceOverrides> | undefined
      post({
        type: 'projectSettings',
        workspaceOpen: workspaceRoot !== undefined,
        overridden: describeOverrides(overridesFor(stored, workspaceRoot)),
      })
    } catch (error) {
      logger.warn(`could not read this project's settings: ${String(error)}`)
    }
  }

  async function handleClearProjectSettings(): Promise<void> {
    try {
      // Cleared key by key, so the entry is removed rather than left as an empty object that
      // reads as "this project has settings" while having none.
      const cleared = Object.fromEntries(OVERRIDABLE_KEYS.map((key) => [key, undefined]))
      await configManager.saveForWorkspace(cleared as Partial<WorkspaceOverrides>)
      await postProjectSettings()
      await postSearch()
      await postSettings()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function postSettings(): Promise<void> {
    await loadSettings()
    announceConfigRecovery()
    post(settingsMessageFrom())
  }

  /** Approve now, and remember it for this workspace. */
  async function handleAlwaysAllow(
    id: string,
    scope: 'tool' | 'command' | 'folder',
  ): Promise<void> {
    const request = userGate.getRequest(id)
    const pathRequest = pendingPathApprovals.get(id)
    userGate.resolve(id, 'approve')

    /*
     * A path grant remembers the *containing folder*, not the file. "Always allow this one log
     * file" is almost never what someone means, and a folder is what the readRoots list is
     * made of — remembering a file would add an entry that matches nothing else in it.
     */
    if (pathRequest !== undefined) {
      const folder = path.dirname(pathRequest)
      sessionPathGrants.add(normalizeForComparison(pathRequest))
      if (scope === 'folder' && !cachedReadRoots.includes(folder)) {
        const { config } = await configManager.load()
        await configManager.save('user', {
          filesystem: { readRoots: [...(config.filesystem?.readRoots ?? []), folder] },
        })
        await postSettings()
      }
      return
    }

    if (request === undefined) return

    if (scope === 'command' && request.preview.kind === 'command') {
      // Remembers the exact string from ground truth, not from the model's arguments.
      await saveApprovals({
        ...cachedApprovals,
        allowedCommands: addToAllowlist(
          request.preview.command,
          cachedApprovals.allowedCommands ?? [],
        ),
      })
      return
    }
    await saveApprovals({
      ...cachedApprovals,
      allowedTools: addToAllowlist(request.toolName, cachedApprovals.allowedTools ?? []),
    })
  }

  async function handleSetAutoApprove(group: ApprovableGroup, enabled: boolean): Promise<void> {
    await saveApprovals({
      ...cachedApprovals,
      autoApprove: { ...cachedApprovals.autoApprove, [group]: enabled },
    })
  }

  async function handleSetMode(modeId: string): Promise<void> {
    await configManager.save('user', { modeId: findMode(modeId).id })
    await postSettings()
  }

  /** Reads the current server map, applies a change, persists, and re-syncs. */
  async function updateMcpServer(
    name: string,
    change: (entry: McpServersConfig[string]) => McpServersConfig[string],
  ): Promise<void> {
    const { config } = await configManager.load()
    const servers = config.mcpServers ?? {}
    const existing = servers[name]
    if (existing === undefined) return

    const next: McpServersConfig = { ...servers, [name]: change(existing) }
    await configManager.save('user', { mcpServers: next })
    setMcpServersState(next)
    await mcp.configure(next)
  }

  /**
   * Three-state per tool, composed from the two stores that already exist rather than a
   * third: `never` is the server's `disabledTools`, `always` is the workspace allow-list,
   * `ask` is neither. Switching to one state must clear the other, or a tool could be
   * simultaneously always-allowed and hidden.
   */
  /**
   * Sets one tool's limit, in whichever store belongs to it.
   *
   * An MCP tool's goes inside its server's entry, keyed by the bare name — that is where a config
   * pasted from another client puts it, and where it survives being exported and pasted again.
   * Everything else goes to `tools.timeouts`. The user sees one box either way; keeping one store
   * per kind is what stops the same fact living in two places.
   */
  async function handleSetToolTimeoutFor(name: string, seconds?: number): Promise<void> {
    try {
      const target = timeoutTargetFor(name, mcpConfigs)
      if (target.kind === 'mcp') {
        await updateMcpServer(target.server, (entry) => {
          const timeouts = { ...entry.toolTimeouts }
          if (seconds === undefined) delete timeouts[target.tool]
          else timeouts[target.tool] = seconds
          const remaining = Object.keys(timeouts).length
          return {
            ...entry,
            ...(remaining > 0 ? { toolTimeouts: timeouts } : { toolTimeouts: undefined }),
          }
        })
        postMcp()
      } else {
        const { config } = await configManager.load()
        const timeouts = { ...config.tools?.timeouts }
        // Deleted rather than stored as zero, so "no limit set" has one representation and the
        // config file does not accumulate entries meaning nothing.
        if (seconds === undefined) delete timeouts[target.name]
        else timeouts[target.name] = seconds
        await configManager.save('user', {
          tools: {
            ...config.tools,
            ...(Object.keys(timeouts).length > 0 ? { timeouts } : { timeouts: undefined }),
          },
        })
        await loadSettings()
      }
      await postTools()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleSetToolTimeout(
    server: string,
    tool: string,
    seconds?: number,
  ): Promise<void> {
    await updateMcpServer(server, (entry) => {
      const timeouts = { ...entry.toolTimeouts }
      // Deleted rather than stored as 0 or null, so "no override" has exactly one representation
      // and the config file does not accumulate entries meaning nothing.
      if (seconds === undefined) delete timeouts[tool]
      else timeouts[tool] = seconds
      const remaining = Object.keys(timeouts).length
      return {
        ...entry,
        ...(remaining > 0 ? { toolTimeouts: timeouts } : { toolTimeouts: undefined }),
      }
    })
    postMcp()
  }

  async function handleSetToolPermission(
    server: string,
    tool: string,
    permission: McpToolPermission,
  ): Promise<void> {
    const namespaced = namespacedToolName(server, tool)

    await updateMcpServer(server, (entry) => {
      const disabled = new Set(entry.disabledTools ?? [])
      if (permission === 'never') disabled.add(tool)
      else disabled.delete(tool)
      return { ...entry, disabledTools: [...disabled] }
    })

    const allowed = cachedApprovals.allowedTools ?? []
    const nextAllowed =
      permission === 'always'
        ? addToAllowlist(namespaced, allowed)
        : removeFromAllowlist(namespaced, allowed)
    if (nextAllowed.length !== allowed.length) {
      await saveApprovals({ ...cachedApprovals, allowedTools: nextAllowed })
    }
    postMcp()
  }

  async function handleRequestMcp(): Promise<void> {
    const { config } = await configManager.load()
    await syncMcpFromConfig(config)
    postMcp()
  }

  /**
   * Validated against the same schema the file loader uses, so a bad paste fails here
   * with a readable message rather than at spawn time (§15).
   */
  /**
   * Keys present in what the user wrote but absent from what the schema kept.
   *
   * Compared per server rather than deeply: a nested difference is almost always a value zod
   * coerced, and reporting those would bury the one case that matters — a whole field silently
   * discarded.
   */
  function droppedKeys(supplied: unknown, kept: Record<string, unknown>): string[] {
    if (typeof supplied !== 'object' || supplied === null) return []
    const missing: string[] = []
    for (const [server, rawEntry] of Object.entries(supplied as Record<string, unknown>)) {
      if (typeof rawEntry !== 'object' || rawEntry === null) continue
      const keptEntry = kept[server]
      if (typeof keptEntry !== 'object' || keptEntry === null) continue
      for (const key of Object.keys(rawEntry as Record<string, unknown>)) {
        if (!(key in (keptEntry as Record<string, unknown>))) missing.push(`${server}.${key}`)
      }
    }
    return missing
  }

  async function handleSaveMcpServers(json: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (error) {
      post({
        type: 'mcpSaveError',
        message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    // Accept either the whole `{ "mcpServers": {...} }` wrapper or just the inner map,
    // since both forms get pasted in practice.
    const candidate =
      typeof parsed === 'object' && parsed !== null && 'mcpServers' in parsed
        ? (parsed as { mcpServers: unknown }).mcpServers
        : parsed

    const result = mcpServersSchema.safeParse(candidate)
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      post({ type: 'mcpSaveError', message: detail })
      return
    }

    /*
     * Say what was thrown away.
     *
     * The schema strips keys it does not know, so a config pasted with a field this client does
     * not support saved "successfully" and did nothing — reported as "edit JSON save didn't
     * work". Silently discarding part of what someone typed is the worst of both: it neither
     * works nor complains. `timeout` in particular used to land here.
     */
    const dropped = droppedKeys(candidate, result.data)
    if (dropped.length > 0) {
      post({
        type: 'mcpSaveError',
        message: `Saved, but these were not recognised and have been dropped: ${dropped.join(', ')}.`,
      })
    }

    try {
      await configManager.save('user', { mcpServers: result.data })
      await mcp.configure(result.data)
      setMcpServersState(result.data)
      postMcp()
      // Verify immediately rather than leaving the user to discover a typo the next time
      // they happen to use the server. Lazy connect is about startup cost, not about
      // withholding feedback on something just configured.
      await mcp.ensureConnected()
    } catch (error) {
      post({
        type: 'mcpSaveError',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Saves one server from the form editor.
   *
   * Goes through the same `mcpServersSchema` the JSON editor and the file loader use, so a
   * form save and a hand-edit fail identically (§15's single-schema rule). The form does its
   * own field-level validation first; this is the backstop, not the only check.
   */
  async function handleSaveMcpServer(
    name: string,
    previousName: string | undefined,
    config: McpServerConfig,
  ): Promise<void> {
    try {
      const { config: loaded } = await configManager.load()
      const servers = { ...(loaded.mcpServers ?? {}) }
      // A rename is a delete plus an add. Done in this order so renaming to the same name
      // is a plain update rather than a delete of the entry being written.
      if (previousName !== undefined && previousName !== name) delete servers[previousName]
      servers[name] = config

      const result = mcpServersSchema.safeParse(servers)
      if (!result.success) {
        const detail = result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')
        post({ type: 'mcpSaveError', message: detail })
        return
      }

      await configManager.save('user', { mcpServers: result.data })
      setMcpServersState(result.data)
      await mcp.configure(result.data)
      postMcp()
      post({ type: 'mcpServerSaved', name })
      // Verify now rather than leaving a typo to surface the next time something happens
      // to need the server.
      await mcp.ensureConnected()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Finds the interpreter for a Python MCP server by looking on disk.
   *
   * Deriving the path from the platform is a guess; checking is an answer. The layout
   * follows whatever created the environment, not the machine reading it, so a venv built
   * under WSL or copied from a share can sit in `bin/` on Windows — and the symptom of
   * guessing wrong is ENOENT naming a path the user never typed.
   *
   * Falls back to looking for a conventional venv folder beside the script, which is where
   * it is in almost every project. Purely advisory: the form always lets the interpreter be
   * typed in, so a failure here narrows the work rather than blocking it.
   */
  async function handleProbePythonEnv(venvDir: string, script: string): Promise<void> {
    const exists = async (candidate: string): Promise<boolean> => {
      try {
        return (await fs.stat(candidate)).isFile()
      } catch {
        return false
      }
    }

    const search = async (dir: string): Promise<string | undefined> => {
      for (const candidate of venvPythonCandidates(dir)) {
        if (await exists(candidate)) return candidate
      }
      return undefined
    }

    try {
      const named = venvDir.trim()
      if (named.length > 0) {
        const found = await search(named)
        if (found !== undefined) {
          post({
            type: 'pythonEnvProbe',
            interpreter: found,
            venvDir: named,
            detail: `Found ${found}`,
          })
          return
        }
        post({
          type: 'pythonEnvProbe',
          detail: `No Python interpreter under "${named}". Check the path, or set the interpreter directly below.`,
        })
        return
      }

      const scriptPath = script.trim()
      if (scriptPath.length === 0) {
        post({
          type: 'pythonEnvProbe',
          detail: 'Enter a virtualenv folder or a script path first.',
        })
        return
      }

      // Walk up from the script: a venv sits beside the entry point, or one level up in a
      // src/ layout. Two levels is enough for both and stops well short of scanning the disk.
      let dir = path.dirname(path.resolve(scriptPath))
      for (let depth = 0; depth < 3; depth++) {
        for (const name of VENV_DIR_NAMES) {
          const candidate = path.join(dir, name)
          const found = await search(candidate)
          if (found !== undefined) {
            post({
              type: 'pythonEnvProbe',
              interpreter: found,
              venvDir: candidate,
              detail: `Found ${found}`,
            })
            return
          }
        }
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
      post({
        type: 'pythonEnvProbe',
        detail: `No ${VENV_DIR_NAMES.join(', ')} folder found near the script. Name the virtualenv folder, or set the interpreter directly.`,
      })
    } catch (error) {
      post({
        type: 'pythonEnvProbe',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * A native picker for any path field in settings.
   *
   * A webview cannot open one itself, and typing an absolute path from memory is both
   * tedious and the most common way to end up with a server that will not start. Cancelling
   * sends nothing, so a dismissed dialog leaves the field exactly as it was.
   */
  async function handleBrowseForPath(
    purpose: string,
    kind: 'file' | 'folder',
    extensions?: string[],
  ): Promise<void> {
    const picked = await ui.showOpenDialog({
      kind,
      // Opens where the user is already working rather than at some unrelated default.
      ...(workspaceRoot !== undefined ? { defaultPath: workspaceRoot } : {}),
      ...(extensions !== undefined && extensions.length > 0 ? { extensions } : {}),
    })
    // A host without a native dialog returns undefined, same as a cancel. The field stays
    // typeable either way, so there is nothing to report.
    if (picked === undefined) return
    post({ type: 'pathPicked', purpose, path: picked })
  }

  /**
   * A unique variant of `base`, given the names already taken.
   *
   * Shared by every clone so they behave the same way. "copy", then "copy 2" — a numeric suffix
   * from the start reads as a version rather than a duplicate.
   */
  function uniqueName(base: string, taken: readonly string[]): string {
    if (!taken.includes(base)) return base
    for (let index = 2; index < 1000; index++) {
      const candidate = `${base} ${String(index)}`
      if (!taken.includes(candidate)) return candidate
    }
    return `${base} ${String(Date.now())}`
  }

  /**
   * Copies a server entry, disabled.
   *
   * Secrets are `${secret:NAME}` *references* inside the config (§15), so a copy points at the
   * same credentials without either duplicating a value or losing one — unlike profile
   * duplication, which has to copy the stored secret because its key is namespaced per profile.
   *
   * Disabled, because the point of a clone is to change something before it runs, and a second
   * identical stdio server spawning immediately is a process nobody asked for.
   */
  async function handleDuplicateMcpServer(name: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const servers = { ...(config.mcpServers ?? {}) }
      const source = servers[name]
      if (source === undefined) return

      const copy = uniqueName(`${name} copy`, Object.keys(servers))
      servers[copy] = { ...source, disabled: true }
      await configManager.save('user', { mcpServers: servers })
      setMcpServersState(servers)
      await mcp.configure(servers)
      postMcp()
      post({ type: 'mcpServerSaved', name: copy })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async function handleDeleteMcpServer(name: string): Promise<void> {
    try {
      const { config } = await configManager.load()
      const servers = { ...(config.mcpServers ?? {}) }
      if (servers[name] === undefined) return
      delete servers[name]

      await configManager.save('user', { mcpServers: servers })
      setMcpServersState(servers)
      // Closes the child process: a removed stdio server left running would keep its tools
      // alive for the rest of the session.
      await mcp.configure(servers)
      postMcp()
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Runs a handler and **says so when it fails**, instead of dropping the failure on the floor.
   *
   * ## The reported failure
   *
   * A Node host with no light/dark control, an empty provider list, Save appearing to do nothing
   * and Test Connection stuck on "Testing…" — with nothing in the terminal. Every one of those is
   * a reply the panel was waiting for and never got.
   *
   * The dispatcher was ninety-odd `void handleX()` statements. `void` on a promise discards its
   * rejection: if `postSettings` threw — and it reads config, which throws on a file that fails
   * validation — the panel simply never heard back. Nothing was logged, nothing was shown, and
   * from the outside it is indistinguishable from a build that never had the feature. That is how
   * "the UI looks outdated" happens to a UI that is perfectly current.
   *
   * This is the same defect as the client's `fetch(...).catch(...)` in §14, on the other side of
   * the wire: **a rejected reply must be reported.** Both halves of the round trip now do.
   *
   * The message names the operation, because "something failed" sends somebody looking
   * everywhere, and the log line carries the same thing for a terminal nobody is watching live.
   */
  function reportFailure(operation: string, work: Promise<unknown>): void {
    work.catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`${operation} failed`, reason)
      post({ type: 'error', message: `${operation} failed: ${reason}` })
    })
  }

  const unsubscribe = transport.onMessage((raw) => {
    const message = raw as UiToHostMessage
    if (message.type === 'sendMessage') {
      if (activeAbortController !== undefined) {
        // The composer is supposed to prevent this — a guard against UI/host desync
        // corrupting the shared conversation and streaming buffer with interleaved turns.
        logger.warn('Ignoring sendMessage: a turn is already in progress.')
        return
      }
      void (async () => {
        /*
         * Wait rather than refuse. A scheduled run holds the conversation for a few seconds;
         * rejecting the user's message for that window would look like the composer had
         * swallowed it, and interleaving the two would corrupt both transcripts.
         */
        if (scheduledRunInFlight !== undefined) {
          logger.info('holding the message until the scheduled run finishes')
          await scheduledRunInFlight
        }
        userTurnRunning = true
        try {
          await handleSendMessage(message.text, message.images)
        } finally {
          userTurnRunning = false
        }
      })()
    } else if (message.type === 'requestMentionCandidates') {
      reportFailure('handleMentionCandidates', handleMentionCandidates(message.query))
    } else if (message.type === 'queueMessage') {
      queuedMessages.push({
        text: message.text,
        ...(message.images !== undefined && message.images.length > 0
          ? { images: message.images }
          : {}),
      })
      postQueued()
    } else if (message.type === 'unqueueMessage') {
      queuedMessages.splice(message.index, 1)
      postQueued()
    } else if (message.type === 'cancel') {
      // A cancelled turn discards the queue too: those messages were written for work that
      // is no longer happening, and replaying them into a fresh turn would surprise.
      queuedMessages = []
      postQueued()
      activeAbortController?.abort()
      userGate.denyAll()
      settleAllForms()
    } else if (message.type === 'approvalResponse') {
      userGate.resolve(message.id, message.decision)
    } else if (message.type === 'formResponse') {
      const resolve = pendingForms.get(message.id)
      // A response for a form nobody is waiting on is normal, not an error: the turn may have
      // been cancelled between the user pressing the button and the message arriving.
      if (resolve !== undefined) {
        pendingForms.delete(message.id)
        resolve(
          message.submitted
            ? answerFromResponse(pendingFormFields.get(message.id) ?? [], message.values)
            : { submitted: false, values: {} },
        )
        pendingFormFields.delete(message.id)
      }
    } else if (message.type === 'approvalResponseAlways') {
      reportFailure('handleAlwaysAllow', handleAlwaysAllow(message.id, message.scope))
    } else if (message.type === 'rollback') {
      reportFailure('handleRollback', handleRollback())
    } else if (message.type === 'requestSettings') {
      reportFailure('postSettings', postSettings())
    } else if (message.type === 'requestTasks') {
      reportFailure('postTasks', postTasks())
    } else if (message.type === 'openTask') {
      reportFailure('openTask', openTask(message.id))
    } else if (message.type === 'deleteTask') {
      reportFailure('deleteTask', deleteTask(message.id))
    } else if (message.type === 'newTask') {
      reportFailure('startNewTask', startNewTask())
    } else if (message.type === 'setMode') {
      reportFailure('handleSetMode', handleSetMode(message.modeId))
    } else if (message.type === 'setMaxIterations') {
      void configManager
        .save('user', { maxIterations: message.value })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setProgrammingProfile') {
      /*
       * An empty id clears it, which is how "the model I am chatting with" is expressed. Saving an
       * empty string instead would leave a key naming a profile that does not exist, and the
       * generator would log a warning on every settings load.
       */
      void configManager
        .load()
        .then(async ({ config }) => {
          const next = { ...config }
          if (message.id.length === 0) delete next.programmingProfileId
          else next.programmingProfileId = message.id
          await configManager.save('user', next)
          await postSettings()
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setReadRoots') {
      void configManager
        .save('user', {
          filesystem: {
            readRoots: message.roots.map((root) => root.trim()).filter((root) => root.length > 0),
          },
        })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setAccentColor') {
      /*
       * Saved to user scope, not workspace: an accent is a preference about the person's
       * editor, and someone who picks teal wants teal in every repository they open.
       */
      void configManager
        // Both written together: `save` merges at the top level, so writing `ui` with only
        // one key would drop the other.
        .save('user', {
          ui: {
            accentColor: message.value,
            expertColor: cachedExpertColor,
            ...(cachedTheme === undefined ? {} : { theme: cachedTheme }),
          },
        })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setToolTimeoutFor') {
      reportFailure('handleSetToolTimeoutFor', handleSetToolTimeoutFor(message.name, message.seconds))
    } else if (message.type === 'setToolTimeout') {
      void configManager
        .save('user', {
          tools: message.seconds === undefined ? {} : { timeoutSeconds: message.seconds },
        })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setTheme') {
      void configManager
        // The whole `ui` block, for the same reason as the colours: `save` merges at the top
        // level, so writing one key would drop the others.
        .save('user', {
          ui: {
            accentColor: cachedAccentColor,
            expertColor: cachedExpertColor,
            theme: message.theme,
          },
        })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setExpertColor') {
      void configManager
        .save('user', {
          ui: {
            accentColor: cachedAccentColor,
            expertColor: message.value,
            ...(cachedTheme === undefined ? {} : { theme: cachedTheme }),
          },
        })
        .then(() => postSettings())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'setAutoApprove') {
      reportFailure('handleSetAutoApprove', handleSetAutoApprove(message.group, message.enabled))
    } else if (message.type === 'revokeAllowedTool') {
      reportFailure('saveApprovals', saveApprovals({
        ...cachedApprovals,
        allowedTools: removeFromAllowlist(message.toolName, cachedApprovals.allowedTools ?? []),
      }))
    } else if (message.type === 'revokeAllowedCommand') {
      reportFailure('saveApprovals', saveApprovals({
        ...cachedApprovals,
        allowedCommands: removeFromAllowlist(
          message.command,
          cachedApprovals.allowedCommands ?? [],
        ),
      }))
    } else if (message.type === 'requestMcp') {
      reportFailure('handleRequestMcp', handleRequestMcp())
    } else if (message.type === 'saveMcpServers') {
      reportFailure('handleSaveMcpServers', handleSaveMcpServers(message.json))
    } else if (message.type === 'saveMcpServer') {
      reportFailure('handleSaveMcpServer', handleSaveMcpServer(message.name, message.previousName, message.config))
    } else if (message.type === 'duplicateMcpServer') {
      reportFailure('handleDuplicateMcpServer', handleDuplicateMcpServer(message.name))
    } else if (message.type === 'deleteMcpServer') {
      reportFailure('handleDeleteMcpServer', handleDeleteMcpServer(message.name))
    } else if (message.type === 'browseForPath') {
      reportFailure('handleBrowseForPath', handleBrowseForPath(message.purpose, message.kind, message.extensions))
    } else if (message.type === 'probePythonEnv') {
      reportFailure('handleProbePythonEnv', handleProbePythonEnv(message.venvDir, message.script))
    } else if (message.type === 'connectMcpServer') {
      void mcp.connectServer(message.name)
    } else if (message.type === 'restartMcpServer') {
      void mcp.restart(message.name)
    } else if (message.type === 'setMcpServerEnabled') {
      reportFailure(
        'updateMcpServer',
        updateMcpServer(message.name, (entry) => ({
          ...entry,
          disabled: !message.enabled,
        })).then(() => postMcp()),
      )
    } else if (message.type === 'setMcpToolTimeout') {
      reportFailure('handleSetToolTimeout', handleSetToolTimeout(message.server, message.tool, message.seconds))
    } else if (message.type === 'setMcpToolPermission') {
      reportFailure('handleSetToolPermission', handleSetToolPermission(message.server, message.tool, message.permission))
    } else if (message.type === 'requestSearch') {
      reportFailure('postSearch', postSearch())
      // The dispatcher and the query log live on the Search tab, so they ship with the same
      // request rather than needing three round trips to populate one panel.
      reportFailure('postDispatcher', postDispatcher())
      post({ type: 'searchLog', entries: [...searchLog.list()] })
    } else if (message.type === 'saveSearchConnection') {
      reportFailure('handleSaveSearchConnection', handleSaveSearchConnection(message.connection))
    } else if (message.type === 'deleteSearchConnection') {
      reportFailure('handleDeleteSearchConnection', handleDeleteSearchConnection(message.id))
    } else if (message.type === 'setActiveSearchConnection') {
      void (
        message.forProject === true
          ? configManager.saveForWorkspace({ activeVectorStoreId: message.id })
          : configManager.save('user', { activeVectorStoreId: message.id })
      )
        .then(async () => {
          await postSearch()
          await postProjectSettings()
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'requestProjectSettings') {
      reportFailure('postProjectSettings', postProjectSettings())
    } else if (message.type === 'clearProjectSettings') {
      reportFailure('handleClearProjectSettings', handleClearProjectSettings())
    } else if (message.type === 'requestSearchIndexes') {
      reportFailure('handleRequestSearchIndexes', handleRequestSearchIndexes(message.connection))
    } else if (message.type === 'testSearchConnection') {
      reportFailure('handleTestSearchConnection', handleTestSearchConnection(message.connection))
    } else if (message.type === 'syncVectorStore') {
      reportFailure('handleSyncVectorStore', handleSyncVectorStore(message.fromId))
    } else if (message.type === 'clearDocsIndex') {
      reportFailure('handleClearDocsIndex', handleClearDocsIndex(message.kind))
    } else if (message.type === 'clearCodebaseIndex') {
      reportFailure('handleClearCodebaseIndex', handleClearCodebaseIndex())
    } else if (message.type === 'openStandingSkill') {
      reportFailure('handleOpenStandingSkill', handleOpenStandingSkill())
    } else if (message.type === 'setOffice') {
      void configManager
        .load()
        .then(async () => {
          await configManager.save('user', {
            office: { excel: message.excel, outlook: message.outlook },
          })
          await loadSettings()
          await postTools()
          /*
           * Shut down when both are switched off. A helper process holding a COM reference to
           * the user's Excel after they revoked the permission is exactly the kind of thing that
           * makes a permission feel untrue.
           */
          if (!message.excel && !message.outlook) {
            await officeBridge?.dispose()
            officeBridge = undefined
          }
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'indexDocs') {
      reportFailure('handleIndexDocs', handleIndexDocs(message.kind))
    } else if (message.type === 'runSearchProbe') {
      reportFailure('handleSearchProbe', handleSearchProbe(message.query, message.target))
    } else if (message.type === 'clearSearchLog') {
      searchLog.clear()
    } else if (message.type === 'setDispatcher') {
      reportFailure(
        'saveRetrieval',
        saveRetrieval({ dispatcher: message.enabled }).then(() => {
          reportFailure('postDispatcher', postDispatcher())
          // Switching it on is the moment the index starts being consulted, and it may never
          // have been built. Off needs nothing — the index simply stops being read.
          if (message.enabled) scheduleDocsReindex('dispatcher enabled')
        }),
      )
    } else if (message.type === 'setSkillRetrieval') {
      reportFailure(
        'saveRetrieval',
        saveRetrieval({ skills: message.enabled }).then(() => {
          reportFailure('postDispatcher', postDispatcher())
          // Same reason as the dispatcher: switching it on is when the index starts being
          // consulted for skills, and it may never have been built.
          if (message.enabled) scheduleDocsReindex('skill retrieval enabled')
        }),
      )
    } else if (message.type === 'startIndexing') {
      reportFailure('handleStartIndexing', handleStartIndexing())
    } else if (message.type === 'attachTeamAlias') {
      reportFailure('handleAttachTeamAlias', handleAttachTeamAlias())
    } else if (message.type === 'publishTeamSkills') {
      reportFailure('handlePublishTeamSkills', handlePublishTeamSkills())
    } else if (message.type === 'syncMail') {
      reportFailure('runMailSync', runMailSync('requested'))
    } else if (message.type === 'pruneMail') {
      reportFailure('handlePruneMail', handlePruneMail())
    } else if (message.type === 'requestOutlookFolders') {
      reportFailure('handleRequestOutlookFolders', handleRequestOutlookFolders(message.depth, message.force === true))
    } else if (message.type === 'validateMailFolder') {
      reportFailure('handleValidateMailFolder', handleValidateMailFolder(message.path))
    } else if (message.type === 'requestMailStatus') {
      /*
       * Also where the timer is reconciled. The panel opening is the first moment the bridge is
       * reliably alive with settings loaded, and it is the same signal MCP already uses to
       * connect - so nothing is spawned at editor startup (§11).
       */
      reportFailure(
        'loadSettings',
        loadSettings().then((config) => {
          reconcileMailTimer(config)
          reconcileDatasetTimers(config)
          return postMailStatus()
        }),
      )
    } else if (message.type === 'saveMailSettings') {
      reportFailure('handleSaveMailSettings', handleSaveMailSettings({
        enabled: message.enabled,
        folders: message.folders,
        includeSubfolders: message.includeSubfolders,
        syncMinutes: message.syncMinutes,
        retentionMonths: message.retentionMonths,
        ...(message.storeId !== undefined ? { storeId: message.storeId } : {}),
      }))
    } else if (message.type === 'clearTeamSkills') {
      reportFailure('handleClearTeamSkills', handleClearTeamSkills())
    } else if (message.type === 'refreshMail') {
      reportFailure('handleRefreshMail', handleRefreshMail(message.days))
    } else if (message.type === 'requestDatasetStatus') {
      reportFailure('postDatasetStatus', postDatasetStatus())
    } else if (message.type === 'saveDataset') {
      reportFailure('handleSaveDataset', handleSaveDataset(message.dataset))
    } else if (message.type === 'deleteDataset') {
      reportFailure('handleDeleteDataset', handleDeleteDataset(message.id))
    } else if (message.type === 'syncDataset') {
      reportFailure('runDatasetSync', runDatasetSync(message.id, 'manual'))
    } else if (message.type === 'clearDataset') {
      reportFailure('handleClearDataset', handleClearDataset(message.id, message.resync === true))
    } else if (message.type === 'clearMailIndex') {
      reportFailure('handleClearMailIndex', handleClearMailIndex(message.resync === true))
    } else if (message.type === 'requestSkillImage') {
      reportFailure('handleSkillImage', handleSkillImage(message.skill, message.image))
    } else if (message.type === 'requestS3') {
      reportFailure('postS3', postS3())
    } else if (message.type === 'saveS3Connection') {
      reportFailure(
        'handleSaveS3Connection',
        handleSaveS3Connection(message.connection, message.secret, message.sessionToken),
      )
    } else if (message.type === 'deleteS3Connection') {
      reportFailure('handleDeleteS3Connection', handleDeleteS3Connection(message.id))
    } else if (message.type === 'saveS3Mirrors') {
      reportFailure('handleSaveS3Mirrors', handleSaveS3Mirrors(message.kind, message.mirrors))
    } else if (message.type === 'syncS3') {
      reportFailure('handleSyncS3', handleSyncS3(message.kind))
    } else if (message.type === 'saveSkillsAlias') {
      reportFailure('handleSaveSkillsAlias', handleSaveSkillsAlias(message.aliases))
    } else if (message.type === 'cancelIndexing') {
      // No kind means "whatever is running", which is what a user pressing Stop means.
      if (message.kind === undefined) {
        indexingAbort?.abort()
        for (const controller of indexingAborts.values()) controller.abort()
      } else if (message.kind === 'codebase') {
        indexingAbort?.abort()
      } else {
        indexingAborts.get(message.kind)?.abort()
      }
    } else if (message.type === 'saveEmbedder') {
      reportFailure('handleSaveEmbedder', handleSaveEmbedder(
        message.profileId,
        message.model,
        message.dimensions,
        message.indexName,
        message.indexPrefix,
        message.indexAliases,
      ))
    } else if (message.type === 'requestEmbedderModels') {
      reportFailure('handleRequestEmbedderModels', handleRequestEmbedderModels(message.profileId))
    } else if (message.type === 'openWalkthrough') {
      void ui.openWalkthrough?.()
    } else if (message.type === 'requestTools') {
      reportFailure('postTools', postTools())
    } else if (message.type === 'requestSchedules') {
      reportFailure('postSchedules', postSchedules())
    } else if (message.type === 'saveSchedule') {
      reportFailure('handleSaveSchedule', handleSaveSchedule(message.schedule))
    } else if (message.type === 'duplicateSchedule') {
      reportFailure('handleDuplicateSchedule', handleDuplicateSchedule(message.id))
    } else if (message.type === 'deleteSchedule') {
      reportFailure('handleDeleteSchedule', handleDeleteSchedule(message.id))
    } else if (message.type === 'setScheduleEnabled') {
      reportFailure('handleSetScheduleEnabled', handleSetScheduleEnabled(message.id, message.enabled))
    } else if (message.type === 'setTaskExpertLimits') {
      const next =
        message.maxSpendUsd === undefined && message.maxConsultations === undefined
          ? undefined
          : {
              ...(message.maxSpendUsd !== undefined ? { maxSpendUsd: message.maxSpendUsd } : {}),
              ...(message.maxConsultations !== undefined
                ? { maxConsultations: message.maxConsultations }
                : {}),
            }
      taskExpertLimits = next
      postExpertSpend()

      /*
       * Also saved as the standing default.
       *
       * The per-chat ceiling was designed to expire with the chat, on the reasoning that one hard
       * task deserving a bigger budget should not silently raise the limit for ever. In practice
       * that read as the setting being forgotten: someone raises the budget, opens the next
       * conversation, and finds their number gone with nothing having told them it would be.
       *
       * Persisting it keeps the override *and* keeps it visible — the number is in the Expert
       * tab, where changing it is one click, rather than in a chat that no longer exists.
       */
      if (next !== undefined) {
        void configManager
          .load()
          .then(async ({ config }) => {
            await configManager.save('user', {
              ...config,
              expert: {
                ...config.expert,
                ...(next.maxSpendUsd !== undefined ? { maxSpendUsd: next.maxSpendUsd } : {}),
                ...(next.maxConsultations !== undefined
                  ? { maxConsultations: next.maxConsultations }
                  : {}),
              },
            })
            await postExpert({ redetect: false })
          })
          .catch((error: unknown) => post({ type: 'error', message: String(error) }))
      }
    } else if (message.type === 'setExpertKeepAlive') {
      void configManager
        .load()
        .then(async ({ config }) => {
          await configManager.save('user', {
            ...config,
            expert: { ...config.expert, keepAlive: message.enabled },
          })
          await postExpert({ redetect: false })
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'measureExpertCost') {
      reportFailure('handleMeasureExpertCost', handleMeasureExpertCost())
    } else if (message.type === 'clearExpertPricing') {
      void configManager
        .load()
        .then(async ({ config }) => {
          const expert = { ...config.expert }
          delete expert.pricing
          delete expert.reportsCost
          await configManager.save('user', { ...config, expert })
          await postExpert({ redetect: false })
        })
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'assessJunior') {
      reportFailure('handleAssessJunior', handleAssessJunior(message.profileId))
    } else if (message.type === 'clearAssessment') {
      reportFailure('handleClearAssessment', handleClearAssessment(message.model, message.profileLabel))
    } else if (message.type === 'restartScheduler') {
      restartScheduleTimer()
      logger.info('schedule timer restarted by the user')
      reportFailure('postSchedules', postSchedules())
    } else if (message.type === 'deleteScheduleRun') {
      reportFailure('handleDeleteScheduleRun', handleDeleteScheduleRun(message.id, message.at))
    } else if (message.type === 'clearScheduleRuns') {
      reportFailure('handleClearScheduleRuns', handleClearScheduleRuns(message.id))
    } else if (message.type === 'openScheduleRun') {
      reportFailure('openRunTranscript', openRunTranscript(message.taskId, message.title))
    } else if (message.type === 'runScheduleNow') {
      reportFailure('runSchedule', runSchedule(message.id, 'manual'))
    } else if (message.type === 'requestSkills') {
      reportFailure('postSkills', postSkills())
    } else if (message.type === 'saveSkillDirs') {
      void configManager
        .save('user', {
          skills: {
            ...(message.dir.trim().length > 0 ? { dir: message.dir.trim() } : {}),
            paths: message.paths.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
          },
        })
        .then(() => postSkills())
        .catch((error: unknown) => post({ type: 'error', message: String(error) }))
    } else if (message.type === 'openManagedFile') {
      reportFailure('handleOpenManagedFile', handleOpenManagedFile(message.path))
    } else if (message.type === 'deletePythonTool') {
      reportFailure('handleDeletePythonTool', handleDeletePythonTool(message.name))
    } else if (message.type === 'approvePythonTool') {
      reportFailure('handleApprovePythonTool', handleApprovePythonTool(message.name))
    } else if (message.type === 'deleteSkillFile') {
      reportFailure('handleDeleteSkillFile', handleDeleteSkillFile(message.name))
    } else if (message.type === 'requestPython') {
      reportFailure('postPython', postPython())
    } else if (message.type === 'setPython') {
      reportFailure('handleSetPython', handleSetPython(message))
    } else if (message.type === 'requestNetwork') {
      reportFailure('postNetwork', postNetwork())
    } else if (message.type === 'saveNetwork') {
      reportFailure('handleSaveNetwork', handleSaveNetwork(message.settings))
    } else if (message.type === 'requestExpert') {
      reportFailure('postExpert', postExpert())
    } else if (message.type === 'setPlan') {
      // Through `applyPlan` rather than inline, so the user's editor and an approved
      // `update_plan` cannot end up doing different things — pruning in particular.
      reportFailure('applyPlan', applyPlan(message.plan))
    } else if (message.type === 'requestPlan') {
      post({ type: 'plan', plan: activePlan ?? '' })
      postPlanProgress()
    } else if (message.type === 'requestPlanProgress') {
      postPlanProgress()
    } else if (message.type === 'requestAgents') {
      reportFailure('postAgents', postAgents())
    } else if (message.type === 'setAgentRole') {
      const assignment = message.assignment
      const role = message.role
      /*
       * Refused rather than written, for a role this build does not have.
       *
       * The role crosses as a string — the protocol cannot carry a union that core owns without
       * the UI importing it — so this is where it becomes one. Writing it anyway would put a key
       * in config that nothing ever reads and nothing ever cleans up.
       */
      if (!isAgentRole(role, cachedAgentDefinitions)) {
        post({ type: 'error', message: `There is no "${role}" role.` })
        return
      }
      reportFailure('saveAgents', saveAgents((current) => {
        const roles = { ...(current.roles ?? {}) }
        /*
         * Unassigning deletes the entry rather than storing an empty one, so "nobody" and "somebody
         * with nothing set" cannot both exist and mean different things to different readers.
         *
         * The edited prompt is kept: somebody switching a reviewer from one model to another has
         * not stopped wanting their reviewer to behave the way they wrote.
         */
        if (assignment === undefined) delete roles[role]
        else {
          roles[role] = {
            kind: assignment.kind,
            ...(assignment.profileId !== undefined ? { profileId: assignment.profileId } : {}),
            ...(roles[role]?.prompt !== undefined ? { prompt: roles[role].prompt } : {}),
          }
        }
        return { ...current, roles }
      }))
    } else if (message.type === 'setAgentPrompt') {
      const role = message.role
      const prompt = message.prompt
      if (!isAgentRole(role, cachedAgentDefinitions)) {
        post({ type: 'error', message: `There is no "${role}" role.` })
        return
      }
      reportFailure('saveAgents', saveAgents((current) => {
        const roles = { ...(current.roles ?? {}) }
        const existing = roles[role]
        // Only stored when it differs, so an improved default still reaches somebody who has
        // looked at the prompt and left it alone.
        if (prompt === undefined || prompt === defaultPromptFor(role)) {
          if (existing !== undefined) {
            const rest = { ...existing }
            delete rest.prompt
            roles[role] = rest
          }
        } else {
          roles[role] = { ...(existing ?? { kind: 'profile' as const }), prompt }
        }
        return { ...current, roles }
      }))
    } else if (message.type === 'setAgentBudget') {
      const matters = message.matters
      reportFailure('saveAgents', saveAgents((current) => ({ ...current, budgetMatters: matters })))
    } else if (message.type === 'setTeamGuidance') {
      const guidance = message.guidance
      reportFailure('saveAgents', saveAgents((current) => {
        if (
          guidance === undefined ||
          guidance.trim().length === 0 ||
          guidance === DEFAULT_TEAM_GUIDANCE
        ) {
          // Removed rather than stored as the default text: storing it would pin the user to
          // whatever it said today, and later improvements would reach everyone except the
          // people who had once opened the box.
          const rest = { ...current }
          delete rest.teamGuidance
          return rest
        }
        return { ...current, teamGuidance: guidance }
      }))
    } else if (message.type === 'saveCustomRole') {
      reportFailure('handleSaveCustomRole', handleSaveCustomRole(message))
    } else if (message.type === 'deleteCustomRole') {
      reportFailure('handleDeleteCustomRole', handleDeleteCustomRole(message.id))
    } else if (message.type === 'setRoleThinking') {
      const role = message.role
      if (!isAgentRole(role, cachedAgentDefinitions)) {
        post({ type: 'error', message: `There is no "${role}" role.` })
        return
      }
      reportFailure('saveAgents', saveAgents((current) => {
        const roles = { ...(current.roles ?? {}) }
        const existing = roles[role] ?? { kind: 'profile' as const }
        if (message.level === undefined) {
          // Cleared rather than stored as a value, so "the profile decides" and "somebody chose
          // off" stay distinguishable — they behave differently and read the same otherwise.
          const rest = { ...existing }
          delete rest.thinking
          roles[role] = rest
        } else {
          roles[role] = { ...existing, thinking: message.level }
        }
        return { ...current, roles }
      }))
    } else if (message.type === 'setRoleEnabled') {
      const role = message.role
      if (!isAgentRole(role, cachedAgentDefinitions)) {
        post({ type: 'error', message: `There is no "${role}" role.` })
        return
      }
      reportFailure('saveAgents', saveAgents((current) => {
        const roles = { ...(current.roles ?? {}) }
        roles[role] = {
          ...(roles[role] ?? { kind: 'profile' as const }),
          enabled: message.enabled,
        }
        return { ...current, roles }
      }))
    } else if (message.type === 'setRoleWrite') {
      const role = message.role
      if (!isAgentRole(role, cachedAgentDefinitions)) {
        post({ type: 'error', message: `There is no "${role}" role.` })
        return
      }
      reportFailure('saveAgents', saveAgents((current) => {
        const roles = { ...(current.roles ?? {}) }
        roles[role] = { ...(roles[role] ?? { kind: 'profile' as const }), write: message.canWrite }
        return { ...current, roles }
      }))
    } else if (message.type === 'setRoleTools') {
      const role = message.role
      if (!isAgentRole(role, cachedAgentDefinitions)) {
        post({ type: 'error', message: `There is no "${role}" role.` })
        return
      }
      reportFailure('saveAgents', saveAgents((current) => {
        const roles = { ...(current.roles ?? {}) }
        roles[role] = { ...(roles[role] ?? { kind: 'profile' as const }), tools: message.usesTools }
        return { ...current, roles }
      }))
    } else if (message.type === 'setAgentColor') {
      const role = message.role
      const color = message.color
      /*
       * Colourable, not assignable - and only here.
       *
       * The other guards on this function ask whether a model can be put in a seat, and must
       * keep refusing `claude`: it is an answerer, not a seat, and a "claude" role would be
       * assignable and mean nothing. Colour is the one question with a different answer,
       * because it marks authorship - so anything that can author a reply may have one.
       */
      if (!isColourableAgent(role, cachedAgentDefinitions)) {
        post({ type: 'error', message: `There is no "${role}" role.` })
        return
      }
      reportFailure('saveAgents', saveAgents((current) => ({
        ...current,
        colors: { ...(current.colors ?? {}), [role]: color },
      })))
    } else if (message.type === 'setExpert') {
      reportFailure('handleSetExpert', handleSetExpert(message.enabled, message.path, message.model, {
        ...(message.maxSpendUsd !== undefined ? { maxSpendUsd: message.maxSpendUsd } : {}),
        ...(message.maxConsultations !== undefined
          ? { maxConsultations: message.maxConsultations }
          : {}),
        ...(message.profileId !== undefined ? { profileId: message.profileId } : {}),
      }))
    } else if (message.type === 'requestProfiles') {
      reportFailure('postProfiles', postProfiles())
      // Capabilities travel with the profile list: switching profiles can change whether
      // the composer offers attachment at all.
      reportFailure('postCapabilities', postCapabilities())
    } else if (message.type === 'saveProfile') {
      reportFailure('handleSaveProfile', handleSaveProfile(message.profile))
    } else if (message.type === 'requestModels') {
      reportFailure('handleRequestModels', handleRequestModels(message.profile))
    } else if (message.type === 'testConnection') {
      reportFailure('handleTestConnection', handleTestConnection(message.profile))
    } else if (message.type === 'duplicateProfile') {
      reportFailure('handleDuplicateProfile', handleDuplicateProfile(message.id))
    } else if (message.type === 'deleteProfile') {
      reportFailure('handleDeleteProfile', handleDeleteProfile(message.id))
    } else if (message.type === 'setActiveProfile') {
      reportFailure('handleSetActiveProfile', handleSetActiveProfile(message.id, message.forProject))
    } else if (message.type === 'declinePythonTools') {
      reportFailure('handleDeclinePythonTools', handleDeclinePythonTools(message.names))
    } else if (message.type === 'restorePythonTool') {
      reportFailure('handleRestorePythonTool', handleRestorePythonTool(message.name))
    } else if (message.type === 'approvePythonTools') {
      reportFailure('handleApprovePythonTools', handleApprovePythonTools(message.names))
    } else if (message.type === 'requestPythonToolSource') {
      reportFailure('handleRequestPythonToolSource', handleRequestPythonToolSource(message.name))
    } else if (message.type === 'previewBucketSkillDelete') {
      reportFailure(
        'handlePreviewBucketSkillDelete',
        handlePreviewBucketSkillDelete(message.name, message.sourceDir),
      )
    } else if (message.type === 'deleteSkillFromBucket') {
      reportFailure(
        'handleDeleteSkillFromBucket',
        handleDeleteSkillFromBucket(message.name, message.sourceDir, message.keys),
      )
    } else if (message.type === 'requestShareSections') {
      reportFailure('handleRequestShareSections', handleRequestShareSections())
    } else if (message.type === 'previewImport') {
      reportFailure('handlePreviewImport', handlePreviewImport())
    } else if (message.type === 'exportConfig') {
      reportFailure('handleExportConfig', handleExportConfig(message.sections))
    } else if (message.type === 'importConfig') {
      reportFailure('handleImportConfig', handleImportConfig(message))
    }
  })

  // Start enabled servers as soon as the panel opens. The extension activates on
  // `onView:lightCode.chatView` (auto-generated from the `views` contribution), so this
  // runs when the user opens Light Code — not at VS Code startup. Doing it here means
  // tools are ready before the first message and health is visible immediately, rather
  // than a mistyped command sitting undetected until something happens to use it.
  // Deliberately not awaited: a slow server must not delay the panel rendering.
  void (async () => {
    try {
      const { config } = await configManager.load()
      await syncMcpFromConfig(config)
      await mcp.ensureConnected()
    } catch (error) {
      logger.warn(
        `Could not start MCP servers: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })()

  // Restore the conversation that was in progress. The webview is rebuilt whenever the
  // view is hidden and on every window reload, so without this a reload silently discards
  // the transcript — which is the whole reason this phase exists.
  void (async () => {
    try {
      await restoreActiveTaskOnLoad()
      await postTasks()
    } catch (error) {
      logger.warn(
        `Could not restore the previous task: ${error instanceof Error ? error.message : String(error)}`,
      )
      post({ type: 'taskRestored', taskId: undefined, entries: [] })
    }
  })()

  /**
   * Notifies, and opens the run's transcript if the user takes the action.
   *
   * The panel is revealed first. A notification can arrive with the view closed, and `openTask`
   * posts to a webview that is not there — the click would silently do nothing, which is worse
   * than not offering it.
   */
  async function openFromNotification(
    message: string,
    level: 'info' | 'warning',
    taskId: string,
  ): Promise<void> {
    const open = await ui.showActionMessage(message, 'Open', level)
    if (!open) return
    await ui.revealPanel()
    await openTask(taskId)
  }

  /**
   * Opens a stored task as a document, so a run can be read where files are read.
   *
   * Rendered from the same `toTranscript` the chat uses, so what appears in the editor is the
   * conversation that happened rather than a second, differently-derived view of it — two
   * renderings of one transcript would drift, which is §15's single-schema rule again.
   */
  async function openRunTranscript(taskId: string, title: string): Promise<void> {
    const task = await taskStore.load(taskId)
    if (task === undefined) {
      ui.showWarning(
        "That run's transcript is no longer stored — task history may have been cleared.",
      )
      return
    }

    const lines: string[] = []
    for (const entry of toTranscript(task.messages)) {
      if (entry.kind === 'text') {
        lines.push(
          entry.role === 'user' ? `## Prompt\n\n${entry.content}` : `## Reply\n\n${entry.content}`,
        )
      } else if (entry.kind === 'reasoning') {
        lines.push(`## Thinking\n\n${entry.content}`)
      } else if (entry.kind === 'chart') {
        /*
         * A chart becomes a table in a written report.
         *
         * The report is markdown somebody reads in the morning, so a picture is not available —
         * and the numbers were always the substance. Rendering the figures is the honest
         * translation; saying "a chart was shown" would lose the whole finding.
         */
        const chart = entry.chart
        const header = ['', ...chart.series.map((series) => series.name)]
        lines.push(
          [
            `## ${chart.title ?? 'Chart'}`,
            '',
            `| ${header.join(' | ')} |`,
            `| ${header.map(() => '---').join(' | ')} |`,
            ...chart.categories.map(
              (category, index) =>
                `| ${category} | ${chart.series.map((series) => String(series.values[index] ?? '')).join(' | ')} |`,
            ),
            ...(chart.note === undefined ? [] : ['', chart.note]),
          ].join('\n'),
        )
      } else if (entry.kind === 'chartError') {
        lines.push(`## Chart\n\nCould not be drawn: ${entry.message}`)
      } else if (entry.kind === 'diagramError') {
        lines.push(`## Diagram\n\nCould not be drawn: ${entry.message}`)
      } else if (entry.kind === 'diagram') {
        /*
         * A diagram becomes its edges, for the same reason a chart becomes a table.
         *
         * The report is markdown read in the morning with no picture available, and what the
         * diagram was *saying* is the connections — so they are written out. "A diagram was
         * shown" would lose the whole content.
         */
        const diagram = entry.diagram
        const labels = new Map(diagram.nodes.map((node) => [node.id, node.label]))
        lines.push(
          [
            `## ${diagram.title ?? 'Diagram'}`,
            '',
            ...diagram.edges.map((edge) => {
              const via = edge.label === undefined ? '' : ` — ${edge.label}`
              return `- ${labels.get(edge.from) ?? edge.from} → ${labels.get(edge.to) ?? edge.to}${via}`
            }),
            ...(diagram.note === undefined ? [] : ['', diagram.note]),
          ].join('\n'),
        )
      } else {
        const call = entry.toolCall
        lines.push(
          [
            `## Tool: ${call.name}${call.isError === true ? ' (failed)' : ''}`,
            '',
            '### Arguments',
            '```json',
            call.arguments,
            '```',
            ...(call.result !== undefined ? ['', '### Result', '```', call.result, '```'] : []),
          ].join('\n'),
        )
      }
    }

    await ui.openDocument({
      title,
      content: lines.length > 0 ? lines.join('\n\n') : '_This run produced no messages._',
    })
  }

  // ------------------------------------------------------------------ schedules (§9b)

  /**
   * The schedule currently running, so two cannot overlap.
   *
   * A run that overruns its next fire time must not start a second concurrent one: they would
   * share the conversation and the task store and interleave into nonsense. The later fire is
   * skipped rather than queued — a missed reminder is better than two tangled ones.
   */
  let runningScheduleId: string | undefined
  /**
   * The report the current run wrote, so the run log can point at it.
   *
   * Cleared when a run starts rather than when it ends: a run that writes no report must not
   * inherit the previous one's, which would be a link to the wrong night's findings — the kind
   * of wrong that is only discovered after acting on it.
   */
  let lastReportPath: string | undefined

  /**
   * Writes a report where it can still be read tomorrow.
   *
   * ## Why a file rather than the in-memory document
   *
   * The whole point of a scheduled run is that nobody is watching. The toast is gone by morning
   * and an untitled document dies with the window, so a report that lived only in a closure was
   * one the user could not read — and reading it is the reason the run exists.
   *
   * ## Naming
   *
   * Timestamped first so the folder sorts chronologically, then a slug of the title so a folder
   * of them is scannable without opening each one.
   */
  async function saveReport(title: string, contents: string): Promise<string | undefined> {
    try {
      const directory = path.join(storageDir, 'reports')
      await fs.mkdir(directory, { recursive: true })

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
      const target = path.join(directory, `${stamp}${slug.length > 0 ? `-${slug}` : ''}.md`)

      await fs.writeFile(
        target,
        `# ${title}

${contents}
`,
        'utf8',
      )
      await pruneReports(directory)
      return target
    } catch (error) {
      // A report that could not be written must not take the run down with it: the work is done
      // either way, and the notification still carries the summary.
      logger.warn(`could not save the report: ${String(error)}`)
      return undefined
    }
  }

  /** Keeps the folder from growing without limit. Oldest go first; the newest are what get read. */
  async function pruneReports(directory: string): Promise<void> {
    const keep = 100
    const entries = (await fs.readdir(directory)).filter((name) => name.endsWith('.md')).sort()
    for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
      await fs.rm(path.join(directory, name), { force: true })
    }
  }

  let scheduleTimer: ReturnType<typeof setInterval> | undefined
  /** When the timer last ran, so a stopped scheduler is visible rather than guessed at. */
  let lastScheduleTickAt: number | undefined
  /** When the in-flight run started, so a wedged one can be released rather than blocking forever. */
  let runStartedAt: number | undefined

  /** Every tool that exists, for the picker. Built with everything on so nothing is hidden. */
  function allToolsForPicker(): { name: string; description: string; group: string }[] {
    return (
      currentToolRegistry(undefined, undefined, undefined, undefined, false)
        .list()
        /*
         * The ones a schedule can never be granted are not offered. A picker that lists a tool
         * the run will refuse teaches the wrong thing twice — once when it is ticked, and again
         * when the run reports it as unavailable.
         */
        .filter((tool) => !NEVER_AVAILABLE_TO_SCHEDULES.includes(tool.name))
        .map((tool) => ({ name: tool.name, description: tool.description, group: tool.group }))
        .sort((a, b) => a.name.localeCompare(b.name))
    )
  }

  /**
   * Everything that exists right now, for the read-only Tools view.
   *
   * Built with the dispatcher *as configured* rather than forced either way, unlike the
   * documentation corpus — the point of this view is to show what the model can currently see,
   * so a truthful `advertised` matters more than a complete corpus.
   */
  async function postTools(): Promise<void> {
    /*
     * Refreshed first. `currentToolRegistry` reads cached settings rather than a config it
     * cannot await, so a `postTools` arriving before the first `loadSettings` would build the
     * registry from empty defaults and report the Office tools missing while they were enabled.
     * One fact, one place it is read from.
     */
    const config = await loadSettings()
    // Same trap as the reindex above: reading the key directly made this view report the
    // dispatcher off — and compute `advertised` as though it were — for anyone running the
    // default. A read-only view of what the model can see is worth nothing if it is wrong.
    const dispatcher = dispatcherEnabled(config.retrieval)
    const registry = currentToolRegistry(undefined, undefined, undefined, undefined, dispatcher)
    const advertised = new Set(registry.promptList().map((tool) => tool.name))
    const pythonNames = new Set(python.tools().map((tool) => tool.name))
    const mcpNames = new Set(mcp.enabledTools().map((tool) => tool.name))

    post({
      type: 'tools',
      dispatcher,
      office: {
        supported: officeAvailable(),
        excel: cachedOffice.excel === true,
        outlook: cachedOffice.outlook === true,
      },
      tools: registry
        .list()
        .map((tool) => {
          // Source is taken from the registries that produced them rather than guessed from
          // the name: a built-in could one day contain `__`, and a server could be called
          // `py`. Asking the thing that owns the tool cannot be wrong in either case.
          const server = mcpNames.has(tool.name)
            ? parseNamespacedToolName(tool.name)?.serverName
            : undefined
          const source = pythonNames.has(tool.name)
            ? 'python'
            : mcpNames.has(tool.name)
              ? 'mcp'
              : 'built-in'
          return {
            name: tool.name,
            description: tool.description,
            group: tool.group,
            source,
            ...(server !== undefined ? { server } : {}),
            advertised: advertised.has(tool.name),
            // The number that will actually apply, not the raw setting: the row should not
            // leave the user to work out which of three limits wins.
            ...(() => {
              const seconds = toolTimeout(tool.name)
              return seconds === undefined ? {} : { timeoutSeconds: seconds }
            })(),
            ...(ownTimeout(tool.name) ? { timeoutIsOwn: true } : {}),
          } satisfies ToolCatalogueEntry
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    })
  }

  async function loadSchedules(): Promise<Record<string, Schedule>> {
    const { config } = await configManager.load()
    return config.schedules ?? {}
  }

  async function postSchedules(): Promise<void> {
    // The picker lists real skills, so it has to reflect what is on disk now rather than
    // whatever the last turn happened to load.
    await refreshSkills()
    const schedules = await loadSchedules()
    post({
      type: 'schedules',
      schedules: Object.values(schedules).sort((a, b) => a.name.localeCompare(b.name)),
      tools: allToolsForPicker(),
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
      ...(runningScheduleId !== undefined ? { runningId: runningScheduleId } : {}),
      scheduler: {
        running: scheduleTimer !== undefined,
        ...(lastScheduleTickAt === undefined ? {} : { lastTickAt: lastScheduleTickAt }),
      },
    })
  }

  async function saveSchedules(next: Record<string, Schedule>): Promise<void> {
    await configManager.save('user', { schedules: next })
    await postSchedules()
  }

  async function handleSaveSchedule(schedule: Schedule): Promise<void> {
    try {
      const schedules = await loadSchedules()
      // A blank id means "new". Generated here rather than in the UI so two panels cannot
      // mint the same one.
      const id =
        schedule.id.length > 0
          ? schedule.id
          : createHash('sha256')
              .update(`${schedule.name}:${String(Date.now())}`)
              .digest('hex')
              .slice(0, 12)
      /*
       * Re-armed on every save. An edited trigger must take effect now rather than after the
       * next run, and a schedule created without this would have no `nextRunAt` and never fire.
       */
      const armed: Schedule = { ...schedule, id, nextRunAt: nextFireTime(schedule, Date.now()) }
      await saveSchedules({ ...schedules, [id]: armed })
    } catch (error) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Writes a schedule the user approved in the chat.
   *
   * Bound to this workspace, which is the whole of §12d's fix: a schedule without one fires in
   * whichever project happens to be open, running its prompt and its granted tools against
   * somebody else's files. A job created *from* a project plainly belongs to it.
   *
   * Armed here for the same reason `handleSaveSchedule` arms one: a schedule with no `nextRunAt`
   * never fires, and that failed silently for weeks once already.
   */
  async function createScheduleFromProposal(proposal: {
    name: string
    prompt: string
    trigger: ScheduleTrigger
    allowedTools: string[]
  }): Promise<{ id: string; nextRunAt?: number }> {
    const schedules = await loadSchedules()
    const id = createHash('sha256')
      .update(`${proposal.name}:${String(Date.now())}`)
      .digest('hex')
      .slice(0, 12)

    const schedule: Schedule = {
      id,
      name: proposal.name,
      prompt: proposal.prompt,
      trigger: proposal.trigger,
      enabled: true,
      allowedTools: proposal.allowedTools,
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    }
    const armed: Schedule = { ...schedule, nextRunAt: nextFireTime(schedule, Date.now()) }
    await saveSchedules({ ...schedules, [id]: armed })
    await postSchedules()
    return { id, ...(armed.nextRunAt !== undefined ? { nextRunAt: armed.nextRunAt } : {}) }
  }

  async function handleDeleteSchedule(id: string): Promise<void> {
    const schedules = await loadSchedules()
    const next = { ...schedules }
    delete next[id]
    await saveSchedules(next)
  }

  async function handleSetScheduleEnabled(id: string, enabled: boolean): Promise<void> {
    const schedules = await loadSchedules()
    const existing = schedules[id]
    if (existing === undefined) return
    /*
     * Re-enabling re-arms from now. Otherwise a schedule paused for a week is instantly overdue
     * the moment it comes back, which is never what pausing meant. Pausing drops the target
     * entirely so nothing can read a stale one as due.
     */
    const next: Schedule = enabled
      ? { ...existing, enabled, nextRunAt: nextFireTime(existing, Date.now()) }
      : { ...existing, enabled, nextRunAt: undefined }
    await saveSchedules({ ...schedules, [id]: next })
  }

  /**
   * Runs one schedule in its own task.
   *
   * A fresh task per run, so each is separately reviewable in history and no run inherits the
   * context of the last — a scheduled job accumulating a month of its own transcripts would
   * cost more every day and eventually stop fitting.
   */
  /**
   * Publishes the in-flight run so a user message can wait on it instead of interleaving.
   *
   * A separate wrapper because the body has early returns, and a promise recorded only on the
   * paths that actually run would leave a window where a send saw nothing to wait for.
   */
  /**
   * Stops the same schedule running twice when several windows are open.
   *
   * Two VS Code windows on one project each have their own bridge, their own timer, and their own
   * view of a schedule being due - so both would run it, at the same moment, against the same
   * files. Binding a schedule to its project fixes windows on *different* projects and does
   * nothing for this.
   *
   * The claim is a file created with `wx`, which fails if it already exists. That is one atomic
   * filesystem operation, so two windows racing cannot both win it - no shared lock service, and
   * nothing to keep running.
   *
   * **Stale claims are taken over**, because the alternative is worse: a window that crashed
   * mid-run would otherwise block that schedule for ever, silently, and the user would have no
   * idea why their nightly job stopped. An hour is far longer than any run should take and short
   * enough that a crash costs one cycle.
   */
  const CLAIM_STALE_MS = 60 * 60 * 1000

  async function claimSchedule(id: string): Promise<boolean> {
    const claimPath = path.join(storageDir, 'schedule-claims', `${id}.json`)
    const mine = JSON.stringify({ pid: process.pid, at: Date.now() })
    try {
      await fs.mkdir(path.dirname(claimPath), { recursive: true })
      await fs.writeFile(claimPath, mine, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Could not even attempt the claim. Running is the better failure: a schedule that
        // silently stops is worse than one that occasionally runs twice.
        logger.warn(`could not claim schedule ${id}: ${String(error)}`)
        return true
      }
    }

    try {
      const held = JSON.parse(await fs.readFile(claimPath, 'utf8')) as { at?: unknown }
      const at = typeof held.at === 'number' ? held.at : 0
      if (Date.now() - at < CLAIM_STALE_MS) {
        logger.info(`schedule ${id} is already running in another window`)
        return false
      }
      logger.warn(`taking over a stale claim on schedule ${id}`)
      await fs.writeFile(claimPath, mine, 'utf8')
      return true
    } catch {
      // An unreadable claim is not evidence that anything is running.
      await fs.writeFile(claimPath, mine, 'utf8').catch(() => undefined)
      return true
    }
  }

  async function releaseSchedule(id: string): Promise<void> {
    await fs
      .rm(path.join(storageDir, 'schedule-claims', `${id}.json`), { force: true })
      .catch(() => undefined)
  }

  async function runSchedule(id: string, reason: 'due' | 'manual'): Promise<void> {
    /*
     * Only for a run that fired on its own. A person pressing Run has decided to run it here, and
     * refusing because another window happens to hold a claim would be obeying a lock they cannot
     * see against an instruction they just gave.
     */
    if (reason === 'due' && !(await claimSchedule(id))) return

    const run = runScheduleInner(id, reason)
    scheduledRunInFlight = run
    try {
      await run
    } finally {
      scheduledRunInFlight = undefined
      if (reason === 'due') await releaseSchedule(id)
    }
  }

  async function runScheduleInner(id: string, reason: 'due' | 'manual'): Promise<void> {
    if (runningScheduleId !== undefined) {
      logger.warn(`schedule ${id} skipped: "${runningScheduleId}" is still running`)
      return
    }
    if (userTurnRunning) {
      // Deferred, not dropped: it stays due and the next tick picks it up. Interrupting
      // someone mid-conversation to run a background job is never the right trade.
      logger.info(`schedule ${id} deferred: the user is mid-turn`)
      return
    }

    const schedules = await loadSchedules()
    const schedule = schedules[id]
    if (schedule === undefined) return

    runningScheduleId = id
    // Cleared at the start, not the end: a run that writes no report must not inherit the
    // previous one's, which would link the wrong night's findings from this night's entry.
    lastReportPath = undefined
    runStartedAt = Date.now()
    void postSchedules()

    /*
     * The user's conversation is put aside for the duration and handed back afterwards.
     *
     * A scheduled run used to call `startNewTask()`, which resets the one shared conversation
     * — so a job firing while someone was chatting wiped their transcript out from under
     * them. Snapshotting is enough because `Conversation` is restorable by value, and it
     * keeps the run on the ordinary turn path rather than forking a second implementation
     * that would drift (the same reasoning as threading `schedule` through in the first place).
     */
    const saved = {
      messages: conversation.toArray(),
      taskId: activeTaskId,
      createdAt: activeTaskCreatedAt,
      handles: truncationStore.spilledHandles(),
      readFiles: [...readFiles],
      checkpoint: taskCheckpoint,
    }
    backgroundRun = true

    const startedAt = Date.now()
    let result: 'ok' | 'error' = 'ok'
    let summary = ''

    try {
      await startNewTask()
      logger.info(`running schedule "${schedule.name}" (${reason})`)
      await handleSendMessage(schedule.prompt, undefined, schedule)
      summary = lastAssistantSummary()
    } catch (error) {
      result = 'error'
      summary = error instanceof Error ? error.message : String(error)
      /*
       * Surfaced, not swallowed. An unattended failure nobody sees is the worst outcome here —
       * the schedule looks like it is working right up until someone needs its output.
       */
      const failedTask = activeTaskId
      if (failedTask !== undefined) {
        void openFromNotification(
          `Scheduled run "${schedule.name}" failed: ${summary}`,
          'warning',
          failedTask,
        )
      } else {
        ui.showWarning(`Scheduled run "${schedule.name}" failed: ${summary}`)
      }
    } finally {
      const ranAsTask = activeTaskId

      /*
       * Restored before anything else awaits, so a user message arriving the instant the run
       * ends finds their own conversation rather than the job's.
       */
      conversation.restore(saved.messages)
      activeTaskCreatedAt = saved.createdAt
      truncationStore.startTask(saved.handles)
      readFiles.clear()
      for (const file of saved.readFiles) readFiles.add(file)
      taskCheckpoint = saved.checkpoint
      backgroundRun = false
      await setActiveTaskId(saved.taskId)

      runningScheduleId = undefined
      runStartedAt = undefined
      const latest = await loadSchedules()
      const current = latest[id]
      if (current !== undefined) {
        await saveSchedules({
          ...latest,
          [id]: {
            ...current,
            // Armed from completion, not from the start: a run slower than its own interval
            // would otherwise be due again the instant it finished and never rest.
            nextRunAt: nextFireTime(current, Date.now()),
            lastRunAt: startedAt,
            lastResult: result,
            ...(summary.length > 0 ? { lastSummary: summary.slice(0, 300) } : {}),
            ...(ranAsTask !== undefined ? { lastTaskId: ranAsTask } : {}),
            // Newest first, and capped — this lives in the config file, so an unbounded log
            // would grow forever and be rewritten on every run.
            runs: [
              {
                at: startedAt,
                result,
                durationMs: Date.now() - startedAt,
                ...(summary.length > 0 ? { summary: summary.slice(0, 300) } : {}),
                ...(ranAsTask !== undefined ? { taskId: ranAsTask } : {}),
                ...(lastReportPath === undefined ? {} : { reportPath: lastReportPath }),
              },
              ...(current.runs ?? []),
            ].slice(0, MAX_REMEMBERED_RUNS),
          },
        })
      } else {
        await postSchedules()
      }
    }
  }

  /**
   * Forgets remembered runs.
   *
   * `lastResult`/`lastSummary` go with them: leaving a summary behind after clearing the log
   * it came from would show a result with nothing to open, which reads as a bug rather than
   * as an empty list.
   */
  async function handleClearScheduleRuns(id: string | undefined): Promise<void> {
    const schedules = await loadSchedules()
    const next: Record<string, Schedule> = {}
    for (const [key, schedule] of Object.entries(schedules)) {
      if (id !== undefined && key !== id) {
        next[key] = schedule
        continue
      }
      const cleared = { ...schedule }
      delete cleared.runs
      delete cleared.lastResult
      delete cleared.lastSummary
      delete cleared.lastTaskId
      next[key] = cleared
    }
    await saveSchedules(next)
  }

  /**
   * Removes one run from the log.
   *
   * Keyed on `at` rather than an index: the list is re-sorted and capped as runs accumulate, so
   * an index the UI computed a moment ago can point at a different run by the time it arrives.
   * The start time is the one thing about a run that does not move.
   */
  /**
   * Copies a schedule, disabled and with no history.
   *
   * **Disabled on purpose.** Cloning is how someone makes a variant of a job that already
   * works, and a copy that started firing the moment it was created — on the original's
   * schedule, with the original's tools — would run something nobody had finished writing.
   * The run log is not copied either: those runs belong to the schedule that did them.
   */
  async function handleDuplicateSchedule(id: string): Promise<void> {
    const schedules = await loadSchedules()
    const source = schedules[id]
    if (source === undefined) return

    const newId = `${String(Date.now().toString(36))}${String(Math.random()).slice(2, 6)}`
    const copy: Schedule = {
      ...source,
      id: newId,
      name: uniqueName(
        `${source.name} copy`,
        Object.values(schedules).map((entry) => entry.name),
      ),
      enabled: false,
    }
    delete copy.runs
    delete copy.lastRunAt
    delete copy.lastResult
    delete copy.lastSummary
    delete copy.lastTaskId
    delete copy.nextRunAt

    await saveSchedules({ ...schedules, [newId]: copy })
  }

  async function handleDeleteScheduleRun(id: string, at: number): Promise<void> {
    const schedules = await loadSchedules()
    const schedule = schedules[id]
    if (schedule === undefined) return

    const remaining = (schedule.runs ?? []).filter((run) => run.at !== at)
    const next: Schedule = { ...schedule, runs: remaining }

    /*
     * The summary shown on the row belongs to the newest run. Deleting that run has to move it
     * on, or the list would keep reporting a result whose log is gone — and the "Log" button
     * beside it would open nothing.
     */
    const newest = remaining[0]
    if (newest === undefined) {
      delete next.runs
      delete next.lastResult
      delete next.lastSummary
      delete next.lastTaskId
    } else if (schedule.lastRunAt === at) {
      next.lastRunAt = newest.at
      next.lastResult = newest.result
      if (newest.summary === undefined) delete next.lastSummary
      else next.lastSummary = newest.summary
      if (newest.taskId === undefined) delete next.lastTaskId
      else next.lastTaskId = newest.taskId
    }

    await saveSchedules({ ...schedules, [id]: next })
  }

  /** The final assistant message, for the schedule list and any notification. */
  function lastAssistantSummary(): string {
    const messages = conversation.toArray()
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (
        message?.role === 'assistant' &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0
      ) {
        return message.content.trim()
      }
    }
    return ''
  }

  /**
   * Checks once a minute rather than setting a timer per schedule.
   *
   * One timer cannot drift out of sync with the config, cannot leak when a schedule is
   * deleted, and does not need rebuilding on every edit. A minute is also the finest interval
   * the schema allows, so nothing is lost.
   */
  /** Stops and starts, unconditionally. The manual button and the watchdog share this. */
  function restartScheduleTimer(): void {
    if (scheduleTimer !== undefined) {
      clearInterval(scheduleTimer)
      scheduleTimer = undefined
    }
    startScheduleTimer()
  }

  function startScheduleTimer(): void {
    if (scheduleTimer !== undefined) return
    /*
     * Every 15 seconds, not every minute.
     *
     * A tick only reads a small JSON file, and at a one-minute poll a one-minute schedule
     * spends most of its life visibly overdue — it fires roughly every two minutes, which
     * reads as a broken scheduler even when it is working. Fifteen seconds bounds the lateness
     * at a quarter of the shortest interval anyone can ask for.
     */
    scheduleTimer = setInterval(() => {
      void runScheduleTick().catch((error: unknown) => {
        /*
         * An unhandled rejection here would be reported nowhere and the interval would keep
         * firing blind. Logged so a failing tick is diagnosable from the output channel
         * rather than inferred from schedules that never run.
         */
        logger.warn(
          `schedule tick failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }, SCHEDULE_TICK_MS)
    // Immediately, too: a schedule that came due while the timer was down should not wait out
    // a full interval before anyone notices.
    void runScheduleTick().catch(() => undefined)
  }

  async function runScheduleTick(): Promise<void> {
    await (async () => {
      // Recorded before the early return so the UI can tell a busy scheduler from a dead
      // one — both look identical from the outside otherwise.
      lastScheduleTickAt = Date.now()
      if (runningScheduleId !== undefined) {
        /*
         * A run that never finishes would stop the scheduler for good, since every later tick
         * returns here. That is one of the shapes the "it just stopped" report can take, so it
         * is bounded rather than trusted: past the cap the flag is cleared and it is reported.
         * Worst case a slow run overlaps with the next one, which is far better than a
         * scheduler that is silently dead.
         */
        if (runStartedAt !== undefined && Date.now() - runStartedAt > STUCK_RUN_MS) {
          logger.warn(
            `schedule "${runningScheduleId}" has been running for too long — releasing the scheduler`,
          )
          runningScheduleId = undefined
          runStartedAt = undefined
          void postSchedules()
        }
        return
      }
      const now = Date.now()
      const schedules = await loadSchedules()

      /*
       * Arm anything enabled that has no target — a schedule written before this field
       * existed, or one whose config was hand-edited. Without it such a schedule is
       * permanently not-due and silently never runs, which is the failure this whole
       * mechanism replaced.
       */
      const unarmed = Object.values(schedules).filter(
        (schedule) => schedule.enabled && schedule.nextRunAt === undefined,
      )
      if (unarmed.length > 0) {
        const armed = { ...schedules }
        for (const schedule of unarmed) {
          armed[schedule.id] = { ...schedule, nextRunAt: nextFireTime(schedule, now) }
        }
        await saveSchedules(armed)
        return
      }

      for (const schedule of Object.values(schedules)) {
        // A schedule written against another project must not fire here. Its prompt and its
        // granted tools were chosen for that codebase, not this one.
        if (!scheduleAppliesHere(schedule, workspaceRoot)) continue
        if (isDue(schedule, now)) {
          await runSchedule(schedule.id, 'due')
          // One per tick: a second would have to wait for the first anyway, and it will be
          // due again on the next pass.
          return
        }
      }
    })()
  }

  /*
   * Started once, at construction. Schedules only fire while VS Code is open — there is no
   * background service — and the Schedules tab says so rather than letting someone believe a
   * nightly job runs on a closed laptop.
   */
  startScheduleTimer()

  return {
    /**
     * Re-sends what a freshly created view cannot know.
     *
     * Everything else the UI needs it asks for on mount, but the transcript is pushed rather
     * than pulled — so without this, reopening the panel would show an empty chat while the
     * conversation was still very much alive in the bridge.
     */
    schedulerHealth: () => ({
      running: scheduleTimer !== undefined,
      ...(lastScheduleTickAt === undefined ? {} : { lastTickAt: lastScheduleTickAt }),
      ...(runningScheduleId === undefined ? {} : { runningScheduleId }),
    }),
    restartScheduler: () => {
      restartScheduleTimer()
    },
    resync: () => {
      void (async () => {
        try {
          /*
           * A live conversation is posted as it stands rather than reloaded from disk: the
           * store is only written at the end of a turn, so reloading mid-turn — during a
           * scheduled run, say — would replace what is happening with what happened last.
           */
          const live = conversation.toArray()
          if (live.length > 0) {
            post({ type: 'taskRestored', taskId: activeTaskId, entries: toTranscript(live) })
          } else {
            await restoreActiveTaskOnLoad()
          }
          await postTasks()
          await postSettings()
          /*
           * The provider list, because the chat header cannot render without it.
           *
           * Reported as "it takes about five minutes for the saved providers to appear" on the
           * Node host and never in the extension. Same cause as the missing light/dark control:
           * `requestProfiles` is sent once at startup, and one lost while the stream was dropping
           * is never repeated — so the list arrived only when something else happened to ask.
           * A view that has just attached needs this as much as it needs the settings.
           */
          await postProfiles()
          await postS3()
          await postSchedules()
        } catch (error) {
          logger.warn(
            `Could not resync the view: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })()
    },
    dispose: () => {
      // Disposing while a turn awaits approval would otherwise leak a pending promise.
      userGate.denyAll()
      settleAllForms()
      // stdio servers are child processes — not closing them leaks one per panel open.
      void mcp.closeAll()
      // Same reasoning for the Python interpreter, and it kills the whole tree so a tool
      // that spawned a subprocess does not outlive the session (§16).
      void python.dispose()
      // Leaves no PowerShell holding a COM reference to the user's Excel.
      void officeBridge?.dispose()
      // A pending reindex would otherwise fire after teardown and post to a dead webview.
      if (docsReindexTimer !== undefined) clearTimeout(docsReindexTimer)
      if (scheduleTimer !== undefined) clearInterval(scheduleTimer)
      // A mail sync reads the user's mailbox. Nothing that does that may outlive the bridge.
      if (mailTimer !== undefined) clearInterval(mailTimer)
      // Nothing may outlive the bridge, least of all something that spends money.
      stopKeepAlive()
      unsubscribe()
    },
  }
}

/**
 * What a new standing-instructions file starts as.
 *
 * Written as a working example rather than an empty file with a heading: the flag that makes it
 * work is one line of frontmatter, getting it wrong silently does nothing, and nobody should have
 * to find that out. The warning about length is here because the body is paid for on every
 * request, and this is the only place someone will read it.
 */
const STANDING_SKILL_TEMPLATE = `---
name: standing-instructions
description: How this team works. Included in every session.
always: true
---

# Standing instructions

Everything in this file goes into every conversation, in full. Keep it short - it is paid for on
every request, so a page of prose here is a page of prose on every message you send.

Good things to put here:

- conventions nobody writes down, like which internal library to use for what
- how to run the tests, and what "done" means on this project
- the mistakes people new to this codebase reliably make

Delete these examples and write your own. Remove \`always: true\` from the frontmatter above and
this becomes an ordinary skill: listed by name, read only when it looks relevant.
`
