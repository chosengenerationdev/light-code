import type { DatasetStatus } from './settings/CustomDataTab.js'
import { CUSTOM_ROLE_LIMIT } from '@light-code/core/browser'
import type { CheckpointView, ProbeTarget } from '@light-code/core/browser'
import {
  DEFAULT_MODE_ID,
  type ApprovalDecision,
  type HostToUiMessage,
  type ProfileInput,
  type ProfileSummary,
  type ApprovableGroup,
  type ContextUsage,
  type ImageAttachmentInput,
  type IndexProgress,
  type IndexResult,
  type TaskListEntry,
  type SearchConnectionInput,
  type SearchConnectionSummary,
  type SearchLogEntry,
  type Schedule,
  type ScheduleToolInfo,
  type McpPlatform,
  type McpServerConfig,
  type McpServerState,
  type NetworkSettingsSummary,
  type PythonSettings,
  type ToolCatalogueEntry,
  type PythonStatus,
  type McpToolPermission,
  type TestConnectionStep,
  type Transport,
  type UiToHostMessage,
  type WorkspaceApprovals,
  type ResolvedVariable,
  type SessionVariable,
} from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { Chat } from './Chat.js'
import { ExpertBudget } from './ExpertBudget.js'
import type { PendingApproval } from './approval/ApprovalPrompt.js'
import type { PendingForm } from './FormPrompt.js'
import type { DisplayMessage } from './MessageList.js'
import { describeDocsResult } from './settings/SettingsPanel.js'
import type { MailFolderNode } from './settings/FolderTree.js'
import type { IndexingProgressState } from './settings/IndexingProgress.js'
import type { MailStatusState } from './settings/OutlookTab.js'
import { ModeSelector } from './ModeSelector.js'
import { Guide } from './guide/Guide.js'
import type { ReviewItem } from './settings/ReviewsTab.js'
import { SettingsPanel } from './settings/SettingsPanel.js'
import type { ExpertState } from './settings/ExpertTab.js'
import type { SearchIndex } from './settings/SearchTab.js'
import type { EmbedderState } from './settings/IndexingSection.js'
import { HistoryList } from './history/HistoryList.js'
import { BackIcon, HelpIcon, HistoryIcon, NewTaskIcon, SettingsIcon } from './icons.js'
import {
  applyAccent,
  applyAgentColor,
  applyAgentColors,
  applyExpert,
  DEFAULT_ACCENT,
  DEFAULT_EXPERT,
} from './styles.js'
import { colors, fontFamily, iconButtonStyle, primaryButtonStyle } from './theme.js'

export interface AppProps {
  transport: Transport
}

type View = 'chat' | 'settings' | 'history' | 'guide'

/** What the host reports about session variables. Absent where the host has no such concept. */
interface VariablesState {
  user: SessionVariable[]
  admin: SessionVariable[]
  resolved: ResolvedVariable[]
  adminIds: string[]
  canEditAdmin: boolean
}

/** If the last message is still streaming, finalize it (drop the `pending` flag) in place. */
function finalizePendingMessage(messages: DisplayMessage[]): DisplayMessage[] {
  // Reasoning can still be pending anywhere in the list, not only at the end, because the
  // answer for the same step is appended after it.
  const settled = messages.map((message) =>
    message.kind === 'reasoning' && message.pending === true
      ? ({ kind: 'reasoning', content: message.content } satisfies DisplayMessage)
      : message,
  )
  const last = settled[settled.length - 1]
  if (last === undefined || last.kind !== 'text' || !last.pending) return settled
  return [
    ...settled.slice(0, -1),
    {
      kind: 'text',
      role: last.role,
      content: last.content,
      ...(last.expertInformed === true ? { expertInformed: true } : {}),
      // Carried with the flag rather than left behind: a live reply would otherwise be neutral
      // until a reload, which is the shape of bug the chart rendering already taught once.
      ...(last.informedBy !== undefined ? { informedBy: last.informedBy } : {}),
    },
  ]
}

/** What the Agents tab renders, straight off the `agents` message. */
type AgentsState = Extract<HostToUiMessage, { type: 'agents' }>

export function App(props: AppProps): ReactElement {
  const [view, setView] = useState<View>('chat')
  const [requestedTab, setRequestedTab] = useState<{ tab: string; nonce: number }>()
  /*
   * What the guide button does, answered by the host rather than assumed. VS Code opens its
   * own Get Started page; a browser has none, so the UI shows the tour itself.
   */
  const [guide, setGuide] = useState<{ native: boolean; mediaBase?: string }>({ native: true })
  /*
   * Undefined until a host answers `requestVariables`. The VS Code bridge does not handle that
   * message, so the tab never appears there — the capability announces itself rather than being
   * declared in two places that can disagree.
   */
  const [variables, setVariables] = useState<VariablesState>()
  /** Undefined until a host answers `requestReviews`, so the extension never shows the tab. */
  const [reviews, setReviews] = useState<{ items: ReviewItem[]; canDecide: boolean }>()
  /** Which profile writes Python tool source. Undefined means the chat model does. */
  const [programmingProfileId, setProgrammingProfileId] = useState<string>()
  const [allowProgrammingProfile, setAllowProgrammingProfile] = useState(false)
  /** What this session is, according to the host. Absent in the extension, which has one user. */
  const [session, setSession] = useState<{
    role: 'admin' | 'user'
    shared: boolean
    displayName: string
    sharedProfileIds: string[]
  }>()
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>(undefined)
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | undefined>(undefined)
  const [pendingForm, setPendingForm] = useState<PendingForm | undefined>(undefined)
  const [canRollback, setCanRollback] = useState(false)
  const [modeId, setModeId] = useState<string>(DEFAULT_MODE_ID)
  const [approvals, setApprovals] = useState<WorkspaceApprovals>({})
  const [maxIterations, setMaxIterations] = useState(25)
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT)
  const [readRoots, setReadRoots] = useState<string[]>([])
  const [expertColor, setExpertColor] = useState(DEFAULT_EXPERT)
  /**
   * The team, as the host resolved it.
   *
   * Undefined until the first `agents` message, which is why the panel renders an empty roster
   * rather than nothing: a tab that appears blank while a reply is in flight reads as broken.
   */
  const [agents, setAgents] = useState<AgentsState>({
    type: 'agents',
    roles: [],
    profiles: [],
    cliAvailable: false,
    budgetMatters: false,
    claudeSeated: false,
    teamGuidance: '',
    defaultTeamGuidance: '',
    teamGuidanceIsDefault: true,
    colors: {},
  })
  const [expertSpend, setExpertSpend] = useState<{
    usd: number
    consultations: number
    unpriced: number
    usage?: number
    exhausted?: boolean
    maxSpendUsd: number
    maxConsultations: number
    overridden: boolean
    estimate?: { consultations?: number; usd?: number }
  }>({
    usd: 0,
    consultations: 0,
    unpriced: 0,
    maxSpendUsd: 0,
    maxConsultations: 0,
    overridden: false,
  })
  const [dispatcher, setDispatcher] = useState<{
    enabled: boolean
    hiddenTools: number
    skills: boolean
    hiddenSkills: number
    docsIndex?: string
  }>({
    // Matches the shipped default, so the checkbox does not flick off and back on while the
    // host's first `dispatcher` message is in flight.
    enabled: true,
    hiddenTools: 0,
    skills: true,
    hiddenSkills: 0,
  })
  const [docsIndexing, setDocsIndexing] = useState(false)
  const [searchLog, setSearchLog] = useState<SearchLogEntry[]>([])
  /*
   * Keyed by target, because one shared value was rendered by three panels.
   *
   * A mail search run from the Outlook tab showed its output under Skills and under Tools too.
   * That is worse than untidy: a result under the wrong heading reads as an answer about that
   * index. The message carries its own target now, so each panel takes only what is its own.
   */
  const [searchProbes, setSearchProbes] = useState<
    Partial<Record<ProbeTarget, { query: string; text: string; error?: string }>>
  >({})
  const [probeRunning, setProbeRunning] = useState<Partial<Record<ProbeTarget, boolean>>>({})

  /*
   * Deletes the key rather than setting it to undefined.
   *
   * `exactOptionalPropertyTypes` draws a real distinction between "absent" and "present and
   * undefined", and only the first is what a cleared result is.
   */
  const clearProbe = (target: ProbeTarget): void =>
    setSearchProbes((current) => {
      const next = { ...current }
      delete next[target]
      return next
    })
  const [docsResult, setDocsResult] = useState<
    { indexed?: number; index?: string; error?: string } | undefined
  >(undefined)
  const [mcpServers, setMcpServers] = useState<McpServerState[]>([])
  const [mcpJson, setMcpJson] = useState('{\n  "mcpServers": {}\n}')
  const [mcpWarnings, setMcpWarnings] = useState<Record<string, string[]>>({})
  const [mcpSaveError, setMcpSaveError] = useState<string | undefined>(undefined)
  const [mcpConfigs, setMcpConfigs] = useState<Record<string, McpServerConfig>>({})
  const [mcpPlatform, setMcpPlatform] = useState<McpPlatform>('posix')
  const [mcpSavedTick, setMcpSavedTick] = useState(0)
  const [pickedPath, setPickedPath] = useState<{ purpose: string; path: string } | undefined>(
    undefined,
  )
  const [pythonProbe, setPythonProbe] = useState<
    { interpreter?: string; venvDir?: string; detail: string } | undefined
  >(undefined)
  const [models, setModels] = useState<string[]>([])
  const [modelsWarning, setModelsWarning] = useState<string | undefined>(undefined)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [testRunning, setTestRunning] = useState(false)
  const [testResult, setTestResult] = useState<
    { ok: boolean; steps: TestConnectionStep[] } | undefined
  >(undefined)
  const [tasks, setTasks] = useState<TaskListEntry[]>([])
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(undefined)
  const [usage, setUsage] = useState<ContextUsage | undefined>(undefined)
  const [supportsVision, setSupportsVision] = useState(false)
  const [expertEnabled, setExpertEnabled] = useState(false)
  const [expert, setExpert] = useState<ExpertState | undefined>(undefined)
  const [network, setNetwork] = useState<NetworkSettingsSummary | undefined>(undefined)
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([])
  const [queued, setQueued] = useState<string[]>([])
  const [searchConnections, setSearchConnections] = useState<SearchConnectionSummary[]>([])
  const [activeSearchId, setActiveSearchId] = useState<string | undefined>(undefined)
  const [searchIndexes, setSearchIndexes] = useState<SearchIndex[]>([])
  const [searchIndexesWarning, setSearchIndexesWarning] = useState<string | undefined>(undefined)
  const [searchTestResult, setSearchTestResult] = useState<
    { ok: boolean; detail: string } | undefined
  >(undefined)
  const [searchSavedTick, setSearchSavedTick] = useState(0)
  const [storeSync, setStoreSync] = useState<
    { running: boolean; copied?: number; error?: string; fromLabel?: string } | undefined
  >(undefined)
  const [embedder, setEmbedder] = useState<EmbedderState | undefined>(undefined)
  const [indexProgress, setIndexProgress] = useState<IndexProgress | undefined>(undefined)
  const [indexResult, setIndexResult] = useState<
    { result?: IndexResult; error?: string } | undefined
  >(undefined)
  /** The outcome of joining an existing index to the team alias. */
  const [aliasResult, setAliasResult] = useState<
    { alias?: string; index?: string; attributed?: number; error?: string } | undefined
  >(undefined)
  /** State of mail indexing, refreshed whenever the host reports it. */
  const [mailStatus, setMailStatus] = useState<MailStatusState | undefined>(undefined)
  const [datasets, setDatasets] = useState<{
    datasets: DatasetStatus[]
    tools: { name: string; description: string; kind: 'python' | 'mcp' }[]
    stores: { id: string; label: string }[]
    defaultStoreLabel: string
    semantic: boolean
    guidance: string
  }>({
    datasets: [],
    tools: [],
    stores: [],
    defaultStoreLabel: 'none',
    semantic: false,
    guidance: '',
  })
  /** The mailbox tree, so folders are ticked rather than typed. */
  const [mailTree, setMailTree] = useState<{
    folders: MailFolderNode[]
    error?: string
    loading: boolean
  }>({
    folders: [],
    loading: false,
  })
  /** What a long-running index is doing. One slot: only one runs at a time in practice. */
  const [indexingProgress, setIndexingProgress] = useState<IndexingProgressState | undefined>(
    undefined,
  )
  /** The outcome of publishing this machine's skills to the team collection. */
  const [teamSkillsResult, setTeamSkillsResult] = useState<
    { count?: number; collection?: string; error?: string } | undefined
  >(undefined)
  const [embedderModels, setEmbedderModels] = useState<string[]>([])
  const [embedderModelsWarning, setEmbedderModelsWarning] = useState<string | undefined>(undefined)
  const [embedderModelsLoading, setEmbedderModelsLoading] = useState(false)
  const [embedderSavedTick, setEmbedderSavedTick] = useState(0)
  const [pythonStatus, setPythonStatus] = useState<PythonStatus | undefined>(undefined)
  const [pythonSettings, setPythonSettings] = useState<PythonSettings | undefined>(undefined)
  const [skills, setSkills] = useState<{ name: string; description: string; filePath: string }[]>(
    [],
  )
  const [skillIssues, setSkillIssues] = useState<{ filePath: string; detail: string }[]>([])
  const [skillsDir, setSkillsDir] = useState<string | undefined>(undefined)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [scheduleTools, setScheduleTools] = useState<ScheduleToolInfo[]>([])
  const [scheduleSkills, setScheduleSkills] = useState<{ name: string; description: string }[]>([])
  /** What the open project has chosen for itself. Nothing until the host says otherwise. */
  /** Whether this host lets the user pick a theme, and which one they picked. */
  const [themeChoice, setThemeChoice] = useState<{
    choosesTheme: boolean
    theme?: 'system' | 'light' | 'dark'
  }>({ choosesTheme: false })
  /**
   * Whether this host offers Excel, Outlook and the mail index.
   *
   * Defaults to true so nothing disappears while the first `settings` message is in flight — a
   * tab that appears a moment after the panel opens is less alarming than one that vanishes.
   */
  /**
   * The plan for the open conversation, as the host holds it.
   *
   * Held here rather than in the composer so it survives the composer being re-rendered, and so a
   * task switch can replace it — the host posts `plan` whenever the conversation changes.
   */
  const [plan, setPlan] = useState('')
  /*
   * The plan's steps with their progress, exactly as the host resolved them.
   *
   * Held whole rather than unpacked field by field. `App.tsx` rebuilding a host message piece by
   * piece is the bug shape this file has produced more than once — most recently dropping
   * `informedBy` from four places — and a list assigned wholesale cannot lose a field.
   */
  const [planCheckpoints, setPlanCheckpoints] = useState<CheckpointView[]>([])
  const [offersOffice, setOffersOffice] = useState(true)
  /** The global tool timeout, when one is set. Undefined leaves each tool at its own default. */
  const [toolTimeoutSeconds, setToolTimeoutSeconds] = useState<number | undefined>(undefined)
  const [projectSettings, setProjectSettings] = useState<{
    workspaceOpen: boolean
    overridden: string[]
  }>({
    workspaceOpen: false,
    overridden: [],
  })
  const [toolCatalogue, setToolCatalogue] = useState<{
    tools: ToolCatalogueEntry[]
    dispatcher: boolean
    office: { supported: boolean; excel: boolean; outlook: boolean }
  }>({
    tools: [],
    dispatcher: false,
    // Assumed unsupported until the host says otherwise, so the toggles never appear enabled
    // on a machine that cannot honour them.
    office: { supported: false, excel: false, outlook: false },
  })
  const [schedulerState, setSchedulerState] = useState<
    { running: boolean; lastTickAt?: number } | undefined
  >(undefined)
  const [runningScheduleId, setRunningScheduleId] = useState<string | undefined>(undefined)
  const [skillExtraDirs, setSkillExtraDirs] = useState<string[]>([])
  // What the user typed, not the resolved absolute path — the field must round-trip a
  // relative entry as the relative entry, or saving would silently rewrite it.
  const [skillConfiguredDir, setSkillConfiguredDir] = useState('')

  useEffect(() => {
    const unsubscribe = props.transport.onMessage((raw) => {
      const message = raw as HostToUiMessage
      if (message.type === 'textChunk') {
        // `message.text` is the full accumulated response so far, not a delta — see
        // protocol.ts. The in-progress assistant message lives directly in `messages`
        // (updated in place via its `pending` flag) rather than in separate state, so
        // there's no hand-off moment between "streaming" and "final" for a bug to hide in.
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          const updated: DisplayMessage = {
            kind: 'text',
            role: 'assistant',
            content: message.text,
            pending: true,
            ...(message.expertInformed === true ? { expertInformed: true } : {}),
            // The role travels with the flag. Copying one and not the other is how this file
            // dropped every field added to the expert message once before (CLAUDE.md), and it is
            // what made every reply read "informed by expert" whoever had answered.
            ...(message.informedBy !== undefined ? { informedBy: message.informedBy } : {}),
          }
          if (last?.kind === 'text' && last.role === 'assistant' && last.pending) {
            return [...prev.slice(0, -1), updated]
          }
          return [...prev, updated]
        })
      } else if (message.type === 'reasoningChunk') {
        // Cumulative like textChunk, and updated in place so a long trace does not append
        // a new block per delta. Reasoning precedes the answer for this step, so it lands
        // before any pending assistant text rather than after it.
        setMessages((prev) => {
          const index = prev.findIndex((m) => m.kind === 'reasoning' && m.pending === true)
          const updated: DisplayMessage = {
            kind: 'reasoning',
            content: message.text,
            pending: true,
          }
          if (index === -1) return [...prev, updated]
          return [...prev.slice(0, index), updated, ...prev.slice(index + 1)]
        })
      } else if (message.type === 'toolCall') {
        setMessages((prev) => [
          ...finalizePendingMessage(prev),
          {
            kind: 'tool',
            toolCall: message.toolCall,
            ...(message.expertInformed === true ? { expertInformed: true } : {}),
            // The role travels with the flag. Copying one and not the other is how this file
            // dropped every field added to the expert message once before (CLAUDE.md), and it is
            // what made every reply read "informed by expert" whoever had answered.
            ...(message.informedBy !== undefined ? { informedBy: message.informedBy } : {}),
          },
        ])
      } else if (message.type === 'toolResult') {
        // Replace the pending entry for this call rather than appending a second one.
        setMessages((prev) => {
          const entry: DisplayMessage = {
            kind: 'tool',
            toolCall: message.toolCall,
            ...(message.expertInformed === true ? { expertInformed: true } : {}),
            // The role travels with the flag. Copying one and not the other is how this file
            // dropped every field added to the expert message once before (CLAUDE.md), and it is
            // what made every reply read "informed by expert" whoever had answered.
            ...(message.informedBy !== undefined ? { informedBy: message.informedBy } : {}),
          }
          const index = prev.findIndex(
            (m) => m.kind === 'tool' && m.toolCall.id === message.toolCall.id,
          )
          if (index === -1) return [...prev, entry]
          return [...prev.slice(0, index), entry, ...prev.slice(index + 1)]
        })
      } else if (message.type === 'formRequest') {
        setMessages(finalizePendingMessage)
        // Assigned whole. Copying field by field is how every field added later gets silently
        // dropped on the last hop — it has happened here before.
        setPendingForm(message)
      } else if (message.type === 'approvalRequest') {
        setMessages(finalizePendingMessage)
        setPendingApproval({
          id: message.id,
          toolName: message.toolName,
          group: message.group,
          preview: message.preview,
          ...(message.alwaysScope === undefined ? {} : { alwaysScope: message.alwaysScope }),
        })
      } else if (message.type === 'openSettings') {
        /*
         * The walkthrough asking to be shown a tab. It arrives as a normal host message so
         * the same path serves any future caller — nothing about it is walkthrough-specific.
         */
        props.transport.post({ type: 'requestProfiles' } satisfies UiToHostMessage)
        setRequestedTab({ tab: message.tab, nonce: Date.now() })
        setView('settings')
      } else if (message.type === 'hostRole') {
        /*
         * Sent once at the top of the event stream by the Node host. It was added when the two
         * URLs were, and nothing read it until now — which is worth noticing: a message nobody
         * consumes is indistinguishable from one nobody sends.
         */
        setSession({
          role: message.role,
          shared: message.shared,
          displayName: message.displayName,
          sharedProfileIds: message.sharedProfileIds,
        })
      } else if (message.type === 'reviews') {
        setReviews({ items: message.items, canDecide: message.canDecide })
      } else if (message.type === 'variables') {
        setVariables({
          user: message.user,
          admin: message.admin,
          resolved: message.resolved,
          adminIds: message.adminIds,
          canEditAdmin: message.canEditAdmin,
        })
      } else if (message.type === 'settings') {
        setModeId(message.modeId)
        setProgrammingProfileId(message.programmingProfileId)
        setAllowProgrammingProfile(message.allowProgrammingProfile)
        setOffersOffice(message.offersOffice !== false)
        setThemeChoice({
          choosesTheme: message.choosesTheme === true,
          ...(message.theme === undefined ? {} : { theme: message.theme }),
        })
        setToolTimeoutSeconds(message.toolTimeoutSeconds)
        setGuide({
          native: message.nativeGuide,
          ...(message.guideMediaBase !== undefined ? { mediaBase: message.guideMediaBase } : {}),
        })
        setApprovals(message.approvals)
        setMaxIterations(message.maxIterations)
        setAccentColor(message.accentColor)
        setReadRoots(message.readRoots)
        setExpertColor(message.expertColor)
        // Applied straight to the document root rather than threaded through props: the
        // stylesheet reads the CSS variables, and it cannot read React state.
        applyAccent(message.accentColor)
        applyExpert(message.expertColor)
      } else if (message.type === 'mcp') {
        setMcpServers(message.servers)
        setMcpJson(message.json)
        setMcpWarnings(message.warnings)
        setMcpConfigs(message.configs)
        setMcpPlatform(message.platform)
        setMcpSaveError(undefined)
      } else if (message.type === 'mcpSaveError') {
        setMcpSaveError(message.message)
      } else if (message.type === 'checkpointAvailable') {
        setCanRollback(true)
      } else if (message.type === 'rolledBack') {
        setCanRollback(false)
      } else if (message.type === 'done') {
        setMessages(finalizePendingMessage)
        setPendingApproval(undefined)
        setIsStreaming(false)
      } else if (message.type === 'error') {
        // A late error must not erase text that already streamed in successfully —
        // finalize whatever arrived, and show the error alongside it, not instead of it.
        setMessages(finalizePendingMessage)
        setPendingApproval(undefined)
        setError(message.message)
        setIsStreaming(false)
      } else if (message.type === 'profiles') {
        setProfiles(message.profiles)
        setActiveProfileId(message.activeProfileId)
        setProfilesLoaded(true)
      } else if (message.type === 'profileSaved') {
        setView('chat')
      } else if (message.type === 'models') {
        setModels(message.models)
        setModelsWarning(message.warning)
        setModelsLoading(false)
      } else if (message.type === 'testConnectionResult') {
        setTestResult({ ok: message.ok, steps: message.steps })
        setTestRunning(false)
      } else if (message.type === 'contextUsage') {
        setUsage(message.usage)
      } else if (message.type === 'compacted') {
        // Say so rather than letting detail vanish silently mid-session.
        setMessages((prev) => [
          ...prev,
          {
            kind: 'text',
            role: 'assistant',
            content: `[${message.summarisedCount} earlier messages were summarised to stay within the context window. The full transcript is still saved.]`,
          },
        ])
      } else if (message.type === 'search') {
        setSearchConnections(message.connections)
        setActiveSearchId(message.activeConnectionId)
      } else if (message.type === 'searchIndexes') {
        setSearchIndexes(message.indexes)
        setSearchIndexesWarning(message.warning)
      } else if (message.type === 'searchTestResult') {
        setSearchTestResult({ ok: message.ok, detail: message.detail })
      } else if (message.type === 'queued') {
        setQueued(message.messages)
      } else if (message.type === 'queuedMessageConsumed') {
        // Enters the transcript as an ordinary user turn — which is what it became in the
        // conversation, so a reopened task renders it identically.
        setMessages((prev) => [
          ...finalizePendingMessage(prev),
          { kind: 'text', role: 'user', content: message.text },
        ])
      } else if (message.type === 'mentionCandidates') {
        setMentionCandidates(message.paths)
      } else if (message.type === 'capabilities') {
        setSupportsVision(message.supportsVision)
      } else if (message.type === 'pathPicked') {
        setPickedPath({ purpose: message.purpose, path: message.path })
      } else if (message.type === 'pythonEnvProbe') {
        setPythonProbe({
          ...(message.interpreter !== undefined ? { interpreter: message.interpreter } : {}),
          ...(message.venvDir !== undefined ? { venvDir: message.venvDir } : {}),
          detail: message.detail,
        })
      } else if (message.type === 'tools') {
        // Assigned whole. Unpacking field by field is how every field added later gets
        // silently dropped on the last hop — it has happened in this file before.
        setToolCatalogue(message)
      } else if (message.type === 'schedules') {
        setScheduleSkills(message.skills)
        setSchedules(message.schedules)
        setScheduleTools(message.tools)
        setRunningScheduleId(message.runningId)
        setSchedulerState(message.scheduler)
      } else if (message.type === 'searchLog') {
        setSearchLog(message.entries)
      } else if (message.type === 'chart') {
        /*
         * Appended as its own entry, exactly as a restored transcript derives it.
         *
         * The host decides what is a chart, using the same function the transcript uses — this
         * only places it. Deciding again here is what made a live chart render as nothing.
         */
        setMessages((prev) => [
          ...prev.filter(
            (entry) =>
              !(
                entry.kind === 'text' &&
                entry.role === 'assistant' &&
                entry.pending === true &&
                entry.content.length === 0
              ),
          ),
          {
            kind: 'chart',
            chart: message.chart,
            ...(message.expertInformed === true ? { expertInformed: true } : {}),
            // The role travels with the flag. Copying one and not the other is how this file
            // dropped every field added to the expert message once before (CLAUDE.md), and it is
            // what made every reply read "informed by expert" whoever had answered.
            ...(message.informedBy !== undefined ? { informedBy: message.informedBy } : {}),
          },
        ])
      } else if (message.type === 'chartError') {
        setMessages((prev) => [...prev, { kind: 'chartError', message: message.message }])
      } else if (message.type === 'searchProbe') {
        setSearchProbes((current) => ({
          ...current,
          [message.target]: {
            query: message.query,
            text: message.text,
            ...(message.error !== undefined ? { error: message.error } : {}),
          },
        }))
        setProbeRunning((current) => ({ ...current, [message.target]: false }))
      } else if (message.type === 'dispatcher') {
        setDispatcher({
          enabled: message.enabled,
          hiddenTools: message.hiddenTools,
          skills: message.skills,
          hiddenSkills: message.hiddenSkills,
          ...(message.docsIndex !== undefined ? { docsIndex: message.docsIndex } : {}),
        })
      } else if (message.type === 'projectSettings') {
        // Assigned whole, like every other message here — copying fields is how a field added
        // later is silently dropped on the last hop.
        setProjectSettings(message)
      } else if (message.type === 'docsIndexed') {
        setDocsIndexing(false)
        setDocsResult({
          ...(message.indexed !== undefined ? { indexed: message.indexed } : {}),
          ...(message.index !== undefined ? { index: message.index } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
        })
      } else if (message.type === 'expertSpend') {
        setExpertSpend({
          usd: message.usd,
          consultations: message.consultations,
          unpriced: message.unpriced,
          ...(message.usage !== undefined ? { usage: message.usage } : {}),
          ...(message.exhausted !== undefined ? { exhausted: message.exhausted } : {}),
          maxSpendUsd: message.maxSpendUsd,
          maxConsultations: message.maxConsultations,
          overridden: message.overridden,
          ...(message.estimate !== undefined ? { estimate: message.estimate } : {}),
        })
      } else if (message.type === 'mcpServerSaved') {
        setMcpSavedTick((tick) => tick + 1)
      } else if (message.type === 'embedder') {
        /*
         * Assigned whole, never field by field.
         *
         * It was unpacked one field at a time, and it had already drifted: the host sent
         * `indexAlias` and `skillsAlias` and this dropped both on the floor. Saving a team alias
         * therefore wrote it to disk correctly, and the panel never heard - so the button never
         * flipped to "saved", the Publish step stayed disabled, and pressing Save looked like it
         * did nothing at all.
         *
         * This is the same defect as the expert message (CLAUDE.md, "the bug shape that keeps
         * costing the most time") and it recurred here for the same reason: a field-by-field copy
         * silently discards whatever is added to the protocol next. `App.embedderMessage.test.ts`
         * reads this file and fails on the shape rather than waiting for the symptom.
         */
        // `type` is the discriminant and is not part of the state; everything else is, whether
        // or not this file has been taught its name.
        const { type: embedderDiscriminant, ...embedderState } = message
        void embedderDiscriminant
        setEmbedder(embedderState)
      } else if (message.type === 'skills') {
        setSkills(message.skills)
        setSkillIssues(message.issues)
        setSkillsDir(message.skillsDir)
        setSkillExtraDirs(message.extraDirs)
      } else if (message.type === 'python') {
        setPythonStatus(message.status)
        setPythonSettings(message.settings)
      } else if (message.type === 'embedderModels') {
        setEmbedderModels(message.models)
        setEmbedderModelsWarning(message.warning)
        setEmbedderModelsLoading(false)
      } else if (message.type === 'embedderSaved') {
        setEmbedderSavedTick((tick) => tick + 1)
      } else if (message.type === 'indexProgress') {
        setIndexProgress(message.progress)
      } else if (message.type === 'outlookFolders') {
        setMailTree({
          folders: message.folders ?? [],
          loading: false,
          ...(message.error !== undefined ? { error: message.error } : {}),
        })
      } else if (message.type === 'indexingProgress') {
        setIndexingProgress({
          kind: message.kind,
          phase: message.phase,
          running: message.running,
          ...(message.done !== undefined ? { done: message.done } : {}),
          ...(message.total !== undefined ? { total: message.total } : {}),
          ...(message.detail !== undefined ? { detail: message.detail } : {}),
        })
      } else if (message.type === 'datasetStatus') {
        setDatasets({
          datasets: message.datasets,
          tools: message.tools,
          stores: message.stores,
          defaultStoreLabel: message.defaultStoreLabel,
          semantic: message.semantic,
          guidance: message.guidance,
        })
      } else if (message.type === 'mailStatus') {
        setMailStatus({
          enabled: message.enabled,
          available: message.available,
          folders: message.folders,
          syncMinutes: message.syncMinutes,
          retentionMonths: message.retentionMonths,
          indexed: message.indexed,
          ...(message.oldest !== undefined ? { oldest: message.oldest } : {}),
          ...(message.newest !== undefined ? { newest: message.newest } : {}),
          sizeBytes: message.sizeBytes,
          semantic: message.semantic,
          ...(message.storeId !== undefined ? { storeId: message.storeId } : {}),
          stores: message.stores,
          ...(message.busy !== undefined ? { busy: message.busy } : {}),
          ...(message.lastResult !== undefined ? { lastResult: message.lastResult } : {}),
        })
      } else if (message.type === 'teamSkillsPublished') {
        setTeamSkillsResult({
          ...(message.count !== undefined ? { count: message.count } : {}),
          ...(message.collection !== undefined ? { collection: message.collection } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
        })
      } else if (message.type === 'teamAliasAttached') {
        setAliasResult({
          ...(message.alias !== undefined ? { alias: message.alias } : {}),
          ...(message.index !== undefined ? { index: message.index } : {}),
          ...(message.attributed !== undefined ? { attributed: message.attributed } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
        })
      } else if (message.type === 'indexResult') {
        setIndexProgress(undefined)
        setIndexResult({
          ...(message.result !== undefined ? { result: message.result } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
        })
      } else if (message.type === 'storeSync') {
        setStoreSync({
          running: message.running,
          ...(message.copied !== undefined ? { copied: message.copied } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
          ...(message.fromLabel !== undefined ? { fromLabel: message.fromLabel } : {}),
        })
      } else if (message.type === 'searchConnectionSaved') {
        setSearchSavedTick((tick) => tick + 1)
      } else if (message.type === 'network') {
        setNetwork(message.settings)
      } else if (message.type === 'plan') {
        setPlan(message.plan)
      } else if (message.type === 'planProgress') {
        setPlanCheckpoints(message.checkpoints)
      } else if (message.type === 'agents') {
        /*
         * The whole message, not field by field.
         *
         * CLAUDE.md records what happened the last time a panel's state was unpacked one field at
         * a time: every field added afterwards was silently dropped on the way through, the host
         * was correct, the protocol was correct, and the panel quietly discarded the answer.
         */
        setAgents(message)
        // Applied immediately so a colour change is visible without a round trip through save.
        // The roles in the message, so a user-defined one gets a colour of its own rather
        // than falling through to the expert's.
        applyAgentColors(
          message.colors,
          message.roles.map((entry) => entry.role),
        )
      } else if (message.type === 'expert') {
        /*
         * Everything except the discriminant, rather than a hand-copied list.
         *
         * This used to name each field, and every field added since was silently dropped here —
         * the measured price, whether the plan reports cost, the measuring step, the keep-alive
         * setting. The bridge sent them, the panel never saw them, and the symptom was a button
         * that appeared to do nothing while the log said it had worked.
         *
         * The whole message is assigned: it is a variable rather than a fresh literal, so the
         * extra `type` is accepted and carrying it costs nothing.
         */
        setExpert(message)
        // The composer badge means "usable", not merely "switched on".
        setExpertEnabled(message.enabled && message.available)
      } else if (message.type === 'tasks') {
        setTasks(message.tasks)
        setActiveTaskId(message.activeTaskId)
      } else if (message.type === 'taskRestored') {
        // A wholesale replacement, not a merge: this arrives on panel load and when a task
        // is opened, and in both cases the previous transcript is no longer what's shown.
        setMessages(message.entries)
        setActiveTaskId(message.taskId)
        setError(undefined)
        setPendingApproval(undefined)
        setIsStreaming(false)
        // The rollback point belongs to the session that took it, not to the transcript.
        setCanRollback(false)
      }
    })

    // Fetch once on mount so the fresh-install CTA (or the chat) can render correctly
    // without the user having to open Settings first.
    props.transport.post({ type: 'requestProfiles' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestSettings' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestMcp' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestExpert' } satisfies UiToHostMessage)
    /*
     * Without this the Agents tab renders its initial empty state for ever: no roles, no
     * providers to assign, and Claude reported as absent — which is what was reported, three
     * symptoms of one missing line. `agentsRequested.test.ts` reads this file, because a request
     * that is never sent is invisible to any test of the thing that would have answered it.
     */
    props.transport.post({ type: 'requestAgents' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestPlan' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestSearch' } satisfies UiToHostMessage)
    /*
     * Also what starts the mail timer, if it is configured. The panel opening is the first
     * moment the bridge is reliably alive with settings loaded, which is the same signal MCP
     * uses to connect - so nothing that reads mail is started at editor startup.
     */
    props.transport.post({ type: 'requestMailStatus' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestDatasetStatus' } satisfies UiToHostMessage)
    // Asked for alongside the search state, since that is the tab that shows it.
    props.transport.post({ type: 'requestProjectSettings' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestNetwork' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestPython' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestSkills' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestSchedules' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestTools' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestVariables' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestReviews' } satisfies UiToHostMessage)

    return unsubscribe
  }, [props.transport])

  const openSettings = (): void => {
    const outgoing: UiToHostMessage = { type: 'requestProfiles' }
    props.transport.post(outgoing)
    setView('settings')
  }

  const send = (text: string, images: ImageAttachmentInput[]): void => {
    if (isStreaming) {
      // Queued host-side: the loop consumes it mid-turn, and this webview can be destroyed
      // and rebuilt at any moment, so it cannot be the one holding the queue.
      props.transport.post({ type: 'queueMessage', text } satisfies UiToHostMessage)
      return
    }
    setError(undefined)
    // The transcript shows what the user typed, mentions unexpanded — the host attaches
    // the file contents on the way to the model, and echoing them here would bury the
    // question under the source it refers to.
    const shown =
      images.length > 0
        ? `${text}${text.length > 0 ? '\n' : ''}[${images.length} image(s) attached]`
        : text
    setMessages((prev) => [...prev, { kind: 'text', role: 'user', content: shown }])
    setIsStreaming(true)
    const outgoing: UiToHostMessage =
      images.length > 0 ? { type: 'sendMessage', text, images } : { type: 'sendMessage', text }
    props.transport.post(outgoing)
  }

  const unqueue = (index: number): void => {
    props.transport.post({ type: 'unqueueMessage', index } satisfies UiToHostMessage)
  }

  const queryMentions = (query: string): void => {
    props.transport.post({ type: 'requestMentionCandidates', query } satisfies UiToHostMessage)
  }

  const cancel = (): void => {
    const outgoing: UiToHostMessage = { type: 'cancel' }
    props.transport.post(outgoing)
  }

  const decideApproval = (id: string, decision: ApprovalDecision): void => {
    setPendingApproval(undefined)
    props.transport.post({ type: 'approvalResponse', id, decision } satisfies UiToHostMessage)
  }

  const alwaysAllow = (id: string, scope: 'tool' | 'command' | 'folder'): void => {
    setPendingApproval(undefined)
    props.transport.post({ type: 'approvalResponseAlways', id, scope } satisfies UiToHostMessage)
  }

  const changeMode = (nextModeId: string): void => {
    setModeId(nextModeId)
    props.transport.post({ type: 'setMode', modeId: nextModeId } satisfies UiToHostMessage)
  }

  const setAutoApprove = (group: ApprovableGroup, enabled: boolean): void => {
    props.transport.post({ type: 'setAutoApprove', group, enabled } satisfies UiToHostMessage)
  }
  const revokeTool = (toolName: string): void => {
    props.transport.post({ type: 'revokeAllowedTool', toolName } satisfies UiToHostMessage)
  }
  const revokeCommand = (command: string): void => {
    props.transport.post({ type: 'revokeAllowedCommand', command } satisfies UiToHostMessage)
  }
  const openHistory = (): void => {
    props.transport.post({ type: 'requestTasks' } satisfies UiToHostMessage)
    setView('history')
  }
  const openTask = (id: string): void => {
    props.transport.post({ type: 'openTask', id } satisfies UiToHostMessage)
    // Switch immediately rather than waiting for `taskRestored`; the host replaces the
    // transcript when it arrives, and leaving the user staring at the list feels broken.
    setView('chat')
  }
  const newTask = (): void => {
    props.transport.post({ type: 'newTask' } satisfies UiToHostMessage)
    setView('chat')
  }
  const deleteTask = (id: string): void => {
    props.transport.post({ type: 'deleteTask', id } satisfies UiToHostMessage)
  }

  const requestModels = (profile: ProfileInput): void => {
    setModelsLoading(true)
    setModelsWarning(undefined)
    props.transport.post({ type: 'requestModels', profile } satisfies UiToHostMessage)
  }
  const runTestConnection = (profile: ProfileInput): void => {
    setTestRunning(true)
    setTestResult(undefined)
    props.transport.post({ type: 'testConnection', profile } satisfies UiToHostMessage)
  }
  /** Results belong to the profile that produced them; opening another must not inherit them. */
  const resetProviderProbes = (): void => {
    setModels([])
    setModelsWarning(undefined)
    setModelsLoading(false)
    setTestResult(undefined)
    setTestRunning(false)
  }
  const searchProps = {
    connections: searchConnections,
    activeConnectionId: activeSearchId,
    indexes: searchIndexes,
    ...(searchIndexesWarning !== undefined ? { indexesWarning: searchIndexesWarning } : {}),
    ...(searchTestResult !== undefined ? { testResult: searchTestResult } : {}),
    savedTick: searchSavedTick,
    onSave: (connection: SearchConnectionInput) => {
      setError(undefined)
      props.transport.post({ type: 'saveSearchConnection', connection } satisfies UiToHostMessage)
    },
    onDelete: (id: string) =>
      props.transport.post({ type: 'deleteSearchConnection', id } satisfies UiToHostMessage),
    onSyncFrom: (fromId: string) => {
      setStoreSync({ running: true })
      props.transport.post({ type: 'syncVectorStore', fromId } satisfies UiToHostMessage)
    },
    ...(storeSync !== undefined ? { sync: storeSync } : {}),
    onSetActive: (id: string | undefined, forProject?: boolean) =>
      props.transport.post({
        type: 'setActiveSearchConnection',
        id,
        ...(forProject === true ? { forProject: true } : {}),
      } satisfies UiToHostMessage),
    project: projectSettings,
    onClearProject: () =>
      props.transport.post({ type: 'clearProjectSettings' } satisfies UiToHostMessage),
    onListIndexes: (connection: SearchConnectionInput) =>
      props.transport.post({ type: 'requestSearchIndexes', connection } satisfies UiToHostMessage),
    onTest: (connection: SearchConnectionInput) => {
      setSearchTestResult(undefined)
      props.transport.post({ type: 'testSearchConnection', connection } satisfies UiToHostMessage)
    },
    indexing: {
      embedder,
      profiles,
      connectionLabel: searchConnections.find((connection) => connection.id === activeSearchId)
        ?.label,
      progress: indexProgress,
      lastResult: indexResult,
      models: embedderModels,
      modelsWarning: embedderModelsWarning,
      modelsLoading: embedderModelsLoading,
      savedTick: embedderSavedTick,
      onRequestModels: (profileId: string) => {
        // Cleared first so a stale catalogue from the previous profile is never shown
        // against the new one.
        setEmbedderModels([])
        setEmbedderModelsWarning(undefined)
        setEmbedderModelsLoading(true)
        props.transport.post({ type: 'requestEmbedderModels', profileId } satisfies UiToHostMessage)
      },
      onSaveEmbedder: (
        profileId: string,
        model: string,
        dimensions: number,
        indexName: string,
        indexPrefix: string,
        indexAlias: string,
      ) => {
        setError(undefined)
        props.transport.post({
          type: 'saveEmbedder',
          profileId,
          model,
          dimensions,
          ...(indexName.length > 0 ? { indexName } : {}),
          ...(indexPrefix.length > 0 ? { indexPrefix } : {}),
          ...(indexAlias.length > 0 ? { indexAlias } : {}),
        } satisfies UiToHostMessage)
      },
      onAttachTeamAlias: () => {
        setAliasResult(undefined)
        props.transport.post({ type: 'attachTeamAlias' } satisfies UiToHostMessage)
      },
      aliasResult,
      onStartIndexing: () => {
        setIndexResult(undefined)
        props.transport.post({ type: 'startIndexing' } satisfies UiToHostMessage)
      },
      onClearIndex: () =>
        props.transport.post({ type: 'clearCodebaseIndex' } satisfies UiToHostMessage),
      onCancelIndexing: () =>
        props.transport.post({ type: 'cancelIndexing' } satisfies UiToHostMessage),
    },
    dispatcher: {
      enabled: dispatcher.enabled,
      hiddenTools: dispatcher.hiddenTools,
      skills: dispatcher.skills,
      hiddenSkills: dispatcher.hiddenSkills,
      ...(dispatcher.docsIndex !== undefined ? { docsIndex: dispatcher.docsIndex } : {}),
      indexing: docsIndexing,
      ...(docsResult !== undefined ? { result: docsResult } : {}),
      // Semantic matching needs both a place to put vectors and something to make them with.
      retrievalReady: activeSearchId !== undefined && embedder?.model !== undefined,
      onToggle: (enabled: boolean) => {
        setDispatcher((current) => ({ ...current, enabled }))
        props.transport.post({ type: 'setDispatcher', enabled } satisfies UiToHostMessage)
      },
      onToggleSkills: (enabled: boolean) => {
        setDispatcher((current) => ({ ...current, skills: enabled }))
        props.transport.post({ type: 'setSkillRetrieval', enabled } satisfies UiToHostMessage)
      },
      onIndexDocs: (kind?: 'tool' | 'skill') => {
        setDocsResult(undefined)
        setDocsIndexing(true)
        props.transport.post({
          type: 'indexDocs',
          ...(kind === undefined ? {} : { kind }),
        } satisfies UiToHostMessage)
      },
      onClearDocsIndex: () => {
        setDocsResult(undefined)
        setDocsIndexing(true)
        props.transport.post({ type: 'clearDocsIndex' } satisfies UiToHostMessage)
      },
    },
    activity: {
      entries: searchLog,
      probe: searchProbes.docs,
      probeRunning: probeRunning.docs === true,
      onProbe: (query: string, target: ProbeTarget) => {
        clearProbe(target)
        setProbeRunning((current) => ({ ...current, [target]: true }))
        props.transport.post({ type: 'runSearchProbe', query, target } satisfies UiToHostMessage)
      },
      onClear: () => props.transport.post({ type: 'clearSearchLog' } satisfies UiToHostMessage),
      // Local state: the result was never stored host-side, so dismissing it is a UI concern.
      onClearProbe: () => clearProbe('docs'),
    },
  }

  const saveExpert = (
    enabled: boolean,
    path: string,
    model: string,
    limits: { maxSpendUsd: number; maxConsultations: number },
  ): void => {
    props.transport.post({
      type: 'setExpert',
      enabled,
      ...(path.length > 0 ? { path } : {}),
      ...(model.length > 0 ? { model } : {}),
      maxSpendUsd: limits.maxSpendUsd,
      maxConsultations: limits.maxConsultations,
    } satisfies UiToHostMessage)
  }
  const saveMcpServer = (
    name: string,
    previousName: string | undefined,
    config: McpServerConfig,
  ): void => {
    setError(undefined)
    props.transport.post({
      type: 'saveMcpServer',
      name,
      ...(previousName !== undefined ? { previousName } : {}),
      config,
    } satisfies UiToHostMessage)
  }
  /** Opens a skill or Python tool in a real editor tab, where an edit actually saves. */
  const openManagedFile = (filePath: string): void => {
    props.transport.post({ type: 'openManagedFile', path: filePath } satisfies UiToHostMessage)
  }
  const browseForPath = (request: {
    purpose: string
    kind: 'file' | 'folder'
    extensions?: string[]
  }): void => {
    // Cleared first so picking the same path twice in a row still registers as a change.
    setPickedPath(undefined)
    props.transport.post({ type: 'browseForPath', ...request } satisfies UiToHostMessage)
  }
  const detectPython = (venvDir: string, script: string): void => {
    props.transport.post({ type: 'probePythonEnv', venvDir, script } satisfies UiToHostMessage)
  }
  const deleteMcpServer = (name: string): void => {
    props.transport.post({ type: 'deleteMcpServer', name } satisfies UiToHostMessage)
  }
  const saveMcp = (json: string): void => {
    props.transport.post({ type: 'saveMcpServers', json } satisfies UiToHostMessage)
  }
  const restartMcp = (name: string): void => {
    props.transport.post({ type: 'restartMcpServer', name } satisfies UiToHostMessage)
  }
  const setMcpServerEnabled = (name: string, enabled: boolean): void => {
    props.transport.post({ type: 'setMcpServerEnabled', name, enabled } satisfies UiToHostMessage)
  }
  const connectMcp = (name: string): void => {
    props.transport.post({ type: 'connectMcpServer', name } satisfies UiToHostMessage)
  }
  const setMcpToolPermission = (
    server: string,
    tool: string,
    permission: McpToolPermission,
  ): void => {
    props.transport.post({
      type: 'setMcpToolPermission',
      server,
      tool,
      permission,
    } satisfies UiToHostMessage)
  }

  const rollback = (): void => {
    props.transport.post({ type: 'rollback' } satisfies UiToHostMessage)
  }

  const saveProfile = (input: ProfileInput): void => {
    props.transport.post({ type: 'saveProfile', profile: input } satisfies UiToHostMessage)
  }
  const duplicateProfile = (id: string): void => {
    props.transport.post({ type: 'duplicateProfile', id } satisfies UiToHostMessage)
  }
  const deleteProfile = (id: string): void => {
    props.transport.post({ type: 'deleteProfile', id } satisfies UiToHostMessage)
  }
  const setActiveProfile = (id: string): void => {
    props.transport.post({ type: 'setActiveProfile', id } satisfies UiToHostMessage)
  }
  const exportConfig = (): void => {
    props.transport.post({ type: 'exportConfig' } satisfies UiToHostMessage)
  }
  const importConfig = (): void => {
    props.transport.post({ type: 'importConfig' } satisfies UiToHostMessage)
  }

  const hasNoProviders = profilesLoaded && profiles.length === 0

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        boxSizing: 'border-box',
        background: colors.background,
        color: colors.foreground,
        fontFamily,
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>Light Code</strong>
          {view === 'chat' && (
            <ModeSelector
              modeId={modeId}
              disabled={isStreaming}
              onChange={changeMode}
              expertAvailable={expertEnabled}
            />
          )}
          {/*
            Beside the mode selector because choosing Junior mode and deciding what the expert
            may spend are the same thought, and both belong to this conversation rather than to
            the application.
          */}
          {/*
            Absent where the expert is a provider profile.
            Nothing meters a profile per call, so a spend figure would be a zero that reads as
            "this has cost you nothing yet" rather than "nothing is counting" — and a cap over
            it would look like protection while binding on nothing.
          */}
          {view === 'chat' && agents.budgetMatters && (
            <ExpertBudget
              enabled={expertEnabled}
              modeId={modeId}
              usd={expertSpend.usd}
              consultations={expertSpend.consultations}
              maxSpendUsd={expertSpend.maxSpendUsd}
              maxConsultations={expertSpend.maxConsultations}
              overridden={expertSpend.overridden}
              {...(expertSpend.estimate !== undefined ? { estimate: expertSpend.estimate } : {})}
              {...(expertSpend.usage !== undefined ? { usage: expertSpend.usage } : {})}
              {...(expertSpend.exhausted !== undefined ? { exhausted: expertSpend.exhausted } : {})}
              onSetLimits={(limits) =>
                props.transport.post({
                  type: 'setTaskExpertLimits',
                  ...limits,
                } satisfies UiToHostMessage)
              }
            />
          )}
        </div>
        {view === 'chat' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button
              type="button"
              aria-label="New task"
              title="New task"
              style={iconButtonStyle('ghost', isStreaming)}
              disabled={isStreaming}
              onClick={newTask}
            >
              <NewTaskIcon />
            </button>
            <button
              type="button"
              aria-label="History"
              title="History"
              style={iconButtonStyle('ghost')}
              onClick={openHistory}
            >
              <HistoryIcon />
            </button>
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              style={iconButtonStyle('ghost')}
              onClick={openSettings}
            >
              <SettingsIcon />
            </button>
            {/*
              The guide lives in the main header, not inside Settings.

              Putting it behind the gear meant you had to already be somewhere specific to find
              out where anything is — help that is only reachable once you have navigated is
              help for people who no longer need it.
            */}
            <button
              type="button"
              aria-label="Guide"
              title="Open the guide"
              style={iconButtonStyle('ghost')}
              onClick={() => {
                if (guide.native) {
                  props.transport.post({ type: 'openWalkthrough' } satisfies UiToHostMessage)
                  return
                }
                setView('guide')
              }}
            >
              <HelpIcon />
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Back"
            title="Back"
            style={iconButtonStyle('ghost')}
            onClick={() => setView('chat')}
          >
            <BackIcon />
          </button>
        )}
      </div>
      {/*
        Errors are rendered here, outside the view switch, because they can arrive while any
        view is open. They used to be shown only inside `Chat`, so a failed save in Settings
        set the state and displayed nothing at all — the form simply closed and the change
        was gone, with the explanation sitting in a variable nobody rendered.
      */}
      {error !== undefined && view !== 'chat' && (
        <div
          role="alert"
          style={{
            margin: '8px 12px 0',
            padding: '8px 10px',
            fontSize: 12,
            borderRadius: 4,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            color: 'var(--vscode-inputValidation-errorForeground, var(--vscode-foreground))',
            background: 'var(--vscode-inputValidation-errorBackground, transparent)',
            border:
              '1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground))',
          }}
        >
          <span style={{ flex: 1 }}>{error}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setError(undefined)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ✕
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'guide' ? (
          <Guide
            {...(guide.mediaBase !== undefined ? { mediaBase: guide.mediaBase } : {})}
            onClose={() => setView('chat')}
            onOpenTab={(tab) => {
              // The same path the host's own message takes, so a tab reached from the guide and
              // a tab reached from a walkthrough button land identically.
              props.transport.post({ type: 'requestProfiles' } satisfies UiToHostMessage)
              setRequestedTab({ tab, nonce: Date.now() })
              setView('settings')
            }}
          />
        ) : view === 'settings' ? (
          <SettingsPanel
            {...(requestedTab !== undefined ? { requestedTab } : {})}
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSave={saveProfile}
            onDuplicate={duplicateProfile}
            onDelete={deleteProfile}
            onSetActive={setActiveProfile}
            onExport={exportConfig}
            onImport={importConfig}
            {...(session !== undefined ? { sharedProfileIds: session.sharedProfileIds } : {})}
            onRequestModels={requestModels}
            onTestConnection={runTestConnection}
            onEditingChange={resetProviderProbes}
            models={models}
            {...(modelsWarning !== undefined ? { modelsWarning } : {})}
            modelsLoading={modelsLoading}
            testRunning={testRunning}
            {...(testResult !== undefined ? { testResult } : {})}
            approvals={approvals}
            onSetAutoApprove={setAutoApprove}
            onRevokeTool={revokeTool}
            onRevokeCommand={revokeCommand}
            maxIterations={maxIterations}
            readRoots={readRoots}
            onSetReadRoots={(roots) =>
              props.transport.post({ type: 'setReadRoots', roots } satisfies UiToHostMessage)
            }
            accentColor={accentColor}
            onSetAccentColor={(value) => {
              // Applied locally first so dragging through swatches is instant; config catches
              // up on the round trip and re-confirms it.
              setAccentColor(value)
              applyAccent(value)
              props.transport.post({ type: 'setAccentColor', value } satisfies UiToHostMessage)
            }}
            agents={{
              ...agents,
              onAssign: (role, assignment) =>
                props.transport.post({
                  type: 'setAgentRole',
                  role,
                  ...(assignment !== undefined ? { assignment } : {}),
                } satisfies UiToHostMessage),
              onSetPrompt: (role, prompt) =>
                props.transport.post({
                  type: 'setAgentPrompt',
                  role,
                  // Absent resets to the default, which is not the same as an empty prompt.
                  ...(prompt !== undefined ? { prompt } : {}),
                } satisfies UiToHostMessage),
              onSetBudget: (matters) =>
                props.transport.post({ type: 'setAgentBudget', matters } satisfies UiToHostMessage),
              onSetTeamGuidance: (guidance) =>
                props.transport.post({
                  type: 'setTeamGuidance',
                  ...(guidance !== undefined ? { guidance } : {}),
                } satisfies UiToHostMessage),
              onSaveCustomRole: (role) =>
                props.transport.post({
                  type: 'saveCustomRole',
                  ...role,
                } satisfies UiToHostMessage),
              onDeleteCustomRole: (id) =>
                props.transport.post({ type: 'deleteCustomRole', id } satisfies UiToHostMessage),
              onSetRoleTools: (role, usesTools) =>
                props.transport.post({
                  type: 'setRoleTools',
                  role,
                  usesTools,
                } satisfies UiToHostMessage),
              onSetRoleWrite: (role, canWrite) =>
                props.transport.post({
                  type: 'setRoleWrite',
                  role,
                  canWrite,
                } satisfies UiToHostMessage),
              onSetRoleEnabled: (role, enabled) =>
                props.transport.post({
                  type: 'setRoleEnabled',
                  role,
                  enabled,
                } satisfies UiToHostMessage),
              onSetRoleThinking: (role, level) =>
                props.transport.post({
                  type: 'setRoleThinking',
                  role,
                  // Absent clears the override rather than storing a level.
                  ...(level !== undefined ? { level } : {}),
                } satisfies UiToHostMessage),
              /*
               * The cap comes from core rather than being repeated here.
               *
               * The form states it before a save can fail on it, and a second copy in the UI is
               * the one that would go stale the day it changes — the shape this codebase pays
               * for most often.
               */
              customRoleLimit: CUSTOM_ROLE_LIMIT,
            }}
            onSetAgentColor={(role, hex) => {
              // Applied locally as well as saved, so the change is instant rather than waiting
              // for the round trip a settings reply would take — the same rule the theme follows.
              setAgents((current) => ({ ...current, colors: { ...current.colors, [role]: hex } }))
              applyAgentColor(role, hex)
              props.transport.post({
                type: 'setAgentColor',
                role,
                color: hex,
              } satisfies UiToHostMessage)
            }}
            expertColor={expertColor}
            onSetExpertColor={(value) => {
              setExpertColor(value)
              applyExpert(value)
              props.transport.post({ type: 'setExpertColor', value } satisfies UiToHostMessage)
            }}
            offersOffice={offersOffice}
            {...(themeChoice.choosesTheme ? { choosesTheme: true } : {})}
            {...(themeChoice.theme === undefined ? {} : { theme: themeChoice.theme })}
            onSetTheme={(theme) => {
              // Applied locally as well as saved, so the change is instant rather than waiting
              // for the round trip that a settings reply would take.
              setThemeChoice((current) => ({ ...current, theme }))
              props.transport.post({ type: 'setTheme', theme } satisfies UiToHostMessage)
            }}
            onSetMaxIterations={(value) =>
              props.transport.post({ type: 'setMaxIterations', value } satisfies UiToHostMessage)
            }
            mcpServers={mcpServers}
            mcpJson={mcpJson}
            mcpWarnings={mcpWarnings}
            mcpSaveError={mcpSaveError}
            mcpConfigs={mcpConfigs}
            mcpPlatform={mcpPlatform}
            mcpSavedTick={mcpSavedTick}
            mcpPythonProbe={pythonProbe}
            onDetectPython={detectPython}
            onBrowse={browseForPath}
            pickedPath={pickedPath}
            onSaveMcpServer={saveMcpServer}
            onDeleteMcpServer={deleteMcpServer}
            onDuplicateMcpServer={(name: string) =>
              props.transport.post({ type: 'duplicateMcpServer', name } satisfies UiToHostMessage)
            }
            onSaveMcp={saveMcp}
            onRestartMcp={restartMcp}
            onSetMcpServerEnabled={setMcpServerEnabled}
            onSetMcpToolPermission={setMcpToolPermission}
            onSetMcpToolTimeout={(server, tool, seconds) =>
              props.transport.post({
                type: 'setMcpToolTimeout',
                server,
                tool,
                ...(seconds === undefined ? {} : { seconds }),
              } satisfies UiToHostMessage)
            }
            onConnectMcp={connectMcp}
            expert={expert}
            onSaveExpert={saveExpert}
            onAssessJunior={(profileId) =>
              props.transport.post({
                type: 'assessJunior',
                // Absent means the model in the chat, which is what the picker's first entry says.
                ...(profileId !== undefined ? { profileId } : {}),
              } satisfies UiToHostMessage)
            }
            onMeasureCost={() =>
              props.transport.post({ type: 'measureExpertCost' } satisfies UiToHostMessage)
            }
            onClearPricing={() =>
              props.transport.post({ type: 'clearExpertPricing' } satisfies UiToHostMessage)
            }
            onSetKeepAlive={(enabled) =>
              props.transport.post({
                type: 'setExpertKeepAlive',
                enabled,
              } satisfies UiToHostMessage)
            }
            onClearAssessment={(model, profileLabel) =>
              props.transport.post({
                type: 'clearAssessment',
                // Both or neither: a subject is a model *through a profile*, and half of one
                // would forget whichever entry happened to match first.
                ...(model !== undefined && profileLabel !== undefined
                  ? { model, profileLabel }
                  : {}),
              } satisfies UiToHostMessage)
            }
            onRecheckExpert={() => {
              // Cleared first so the tab visibly restarts rather than showing a stale answer.
              setExpert(undefined)
              props.transport.post({ type: 'requestExpert' } satisfies UiToHostMessage)
            }}
            search={searchProps}
            skills={{
              team: {
                alias: embedder?.skillsAlias,
                onSaveAlias: (alias: string) =>
                  props.transport.post({
                    type: 'saveSkillsAlias',
                    alias,
                  } satisfies UiToHostMessage),
                onPublish: () => {
                  setTeamSkillsResult(undefined)
                  props.transport.post({ type: 'publishTeamSkills' } satisfies UiToHostMessage)
                },
                onClear: () => {
                  setTeamSkillsResult(undefined)
                  props.transport.post({ type: 'clearTeamSkills' } satisfies UiToHostMessage)
                },
                onStop: () =>
                  props.transport.post({
                    type: 'cancelIndexing',
                    kind: 'teamSkills',
                  } satisfies UiToHostMessage),
                publishing: indexingProgress?.kind === 'teamSkills' && indexingProgress.running,
                progress: indexingProgress?.kind === 'teamSkills' ? indexingProgress : undefined,
                result: teamSkillsResult,
              },
              skills,
              issues: skillIssues,
              skillsDir,
              extraDirs: skillExtraDirs,
              configuredDir: skillConfiguredDir,
              onOpenFile: openManagedFile,
              onOpenStandingSkill: () =>
                props.transport.post({ type: 'openStandingSkill' } satisfies UiToHostMessage),
              // The button sits here because this is where a skill changes. It reindexes skills
              // only: a run that also swept tools would invite the question of what it touched.
              onReindex: () => {
                setDocsResult(undefined)
                setDocsIndexing(true)
                props.transport.post({ type: 'indexDocs', kind: 'skill' } satisfies UiToHostMessage)
              },
              probe: { running: probeRunning.docs === true, result: searchProbes.docs },
              onProbe: (query: string, target: ProbeTarget) => {
                clearProbe(target)
                setProbeRunning((current) => ({ ...current, [target]: true }))
                props.transport.post({
                  type: 'runSearchProbe',
                  query,
                  target,
                } satisfies UiToHostMessage)
              },
              onClearProbe: () => clearProbe('docs'),
              onClearIndex: () => {
                setDocsResult(undefined)
                props.transport.post({
                  type: 'clearDocsIndex',
                  kind: 'skill',
                } satisfies UiToHostMessage)
              },
              indexProgress: indexingProgress?.kind === 'skills' ? indexingProgress : undefined,
              onStopIndexing: () =>
                props.transport.post({
                  type: 'cancelIndexing',
                  kind: 'skills',
                } satisfies UiToHostMessage),
              indexing: docsIndexing,
              indexResult:
                docsResult === undefined
                  ? undefined
                  : docsResult.error !== undefined
                    ? `Failed: ${docsResult.error}`
                    : `Indexed ${String(docsResult.indexed ?? 0)} entries.`,
              onDelete: (name) =>
                props.transport.post({ type: 'deleteSkillFile', name } satisfies UiToHostMessage),
              onSaveDirs: (dir: string, paths: string[]) => {
                setSkillConfiguredDir(dir)
                props.transport.post({
                  type: 'saveSkillDirs',
                  dir,
                  paths,
                } satisfies UiToHostMessage)
              },
            }}
            schedules={{
              schedules,
              tools: scheduleTools,
              skills: scheduleSkills,
              runningId: runningScheduleId,
              onSave: (schedule) =>
                props.transport.post({ type: 'saveSchedule', schedule } satisfies UiToHostMessage),
              onDelete: (id) =>
                props.transport.post({ type: 'deleteSchedule', id } satisfies UiToHostMessage),
              onDuplicate: (id) =>
                props.transport.post({ type: 'duplicateSchedule', id } satisfies UiToHostMessage),
              onToggle: (id, enabled) =>
                props.transport.post({
                  type: 'setScheduleEnabled',
                  id,
                  enabled,
                } satisfies UiToHostMessage),
              onRunNow: (id) =>
                props.transport.post({ type: 'runScheduleNow', id } satisfies UiToHostMessage),
              // The same candidates the composer uses; the host does not care who asked.
              mentionCandidates,
              onQueryMentions: queryMentions,
              // The same path the host already opens skills and Python tools through, confined to the
              // folders those things live in - a report is one more file the user asked to see.
              onOpenReport: (reportPath: string) =>
                props.transport.post({
                  type: 'openManagedFile',
                  path: reportPath,
                } satisfies UiToHostMessage),
              onOpenRun: (taskId: string, title: string) =>
                props.transport.post({
                  type: 'openScheduleRun',
                  taskId,
                  title,
                } satisfies UiToHostMessage),
              scheduler: schedulerState,
              onRestartScheduler: () =>
                props.transport.post({ type: 'restartScheduler' } satisfies UiToHostMessage),
              onDeleteRun: (id, at) =>
                props.transport.post({
                  type: 'deleteScheduleRun',
                  id,
                  at,
                } satisfies UiToHostMessage),
              onClearRuns: (id) =>
                props.transport.post({
                  type: 'clearScheduleRuns',
                  ...(id === undefined ? {} : { id }),
                } satisfies UiToHostMessage),
            }}
            customData={{
              datasets: datasets.datasets,
              tools: datasets.tools,
              stores: datasets.stores,
              defaultStoreLabel: datasets.defaultStoreLabel,
              semantic: datasets.semantic,
              guidance: datasets.guidance,
              progress: indexingProgress?.kind === 'dataset' ? indexingProgress : undefined,
              probe: { running: probeRunning.data === true, result: searchProbes.data },
              onProbe: (query: string, target: ProbeTarget) => {
                clearProbe(target)
                setProbeRunning((current) => ({ ...current, [target]: true }))
                props.transport.post({
                  type: 'runSearchProbe',
                  query,
                  target,
                } satisfies UiToHostMessage)
              },
              onClearProbe: () => clearProbe('data'),
              /*
               * Asks for both, because the tab shows both: the tool list it offers as collectors,
               * and the record counts beside each dataset. One button, one round trip.
               */
              onRefresh: () => {
                props.transport.post({ type: 'requestTools' } satisfies UiToHostMessage)
                props.transport.post({ type: 'requestDatasetStatus' } satisfies UiToHostMessage)
              },
              onSave: (dataset) =>
                props.transport.post({ type: 'saveDataset', dataset } satisfies UiToHostMessage),
              onDelete: (id: string) =>
                props.transport.post({ type: 'deleteDataset', id } satisfies UiToHostMessage),
              onSync: (id: string) =>
                props.transport.post({ type: 'syncDataset', id } satisfies UiToHostMessage),
              onClear: (id: string, resync: boolean) =>
                props.transport.post({
                  type: 'clearDataset',
                  id,
                  resync,
                } satisfies UiToHostMessage),
              onStop: () =>
                props.transport.post({ type: 'cancelIndexing' } satisfies UiToHostMessage),
            }}
            outlook={{
              status: mailStatus,
              onSave: (settings) =>
                props.transport.post({
                  type: 'saveMailSettings',
                  ...settings,
                } satisfies UiToHostMessage),
              onSyncNow: () => props.transport.post({ type: 'syncMail' } satisfies UiToHostMessage),
              onPrune: () => props.transport.post({ type: 'pruneMail' } satisfies UiToHostMessage),
              tree: mailTree,
              progress: indexingProgress?.kind === 'mail' ? indexingProgress : undefined,
              onRefreshFolders: () => {
                setMailTree((current) => ({ ...current, loading: true }))
                // Forced only once there is something on screen: the first load comes from
                // the cache, which is what makes opening the tab instant.
                props.transport.post({
                  type: 'requestOutlookFolders',
                  force: mailTree.folders.length > 0,
                } satisfies UiToHostMessage)
              },
              onClear: (resync: boolean) =>
                props.transport.post({ type: 'clearMailIndex', resync } satisfies UiToHostMessage),
              probe: { running: probeRunning.mail === true, result: searchProbes.mail },
              onProbe: (query: string, target: ProbeTarget) => {
                clearProbe(target)
                setProbeRunning((current) => ({ ...current, [target]: true }))
                props.transport.post({
                  type: 'runSearchProbe',
                  query,
                  target,
                } satisfies UiToHostMessage)
              },
              onClearProbe: () => clearProbe('mail'),
              onRefreshDays: (days: number) =>
                props.transport.post({ type: 'refreshMail', days } satisfies UiToHostMessage),
              onStop: () =>
                props.transport.post({
                  type: 'cancelIndexing',
                  kind: 'mail',
                } satisfies UiToHostMessage),
            }}
            tools={{
              ...toolCatalogue,
              docsIndex: {
                enabled: dispatcher.enabled,
                retrievalReady: activeSearchId !== undefined && embedder?.model !== undefined,
                indexing: docsIndexing,
                result: describeDocsResult(docsResult),
              },
              onIndexDocs: () =>
                props.transport.post({ type: 'indexDocs', kind: 'tool' } satisfies UiToHostMessage),
              probe: { running: probeRunning.docs === true, result: searchProbes.docs },
              onProbe: (query: string, target: ProbeTarget) => {
                clearProbe(target)
                setProbeRunning((current) => ({ ...current, [target]: true }))
                props.transport.post({
                  type: 'runSearchProbe',
                  query,
                  target,
                } satisfies UiToHostMessage)
              },
              onClearProbe: () => clearProbe('docs'),
              onRefreshTools: () =>
                props.transport.post({ type: 'requestTools' } satisfies UiToHostMessage),
              onClearDocs: () => {
                setDocsResult(undefined)
                props.transport.post({
                  type: 'clearDocsIndex',
                  kind: 'tool',
                } satisfies UiToHostMessage)
              },
              progress: indexingProgress?.kind === 'tools' ? indexingProgress : undefined,
              onStopIndexing: () =>
                props.transport.post({
                  type: 'cancelIndexing',
                  kind: 'tools',
                } satisfies UiToHostMessage),
              ...(toolTimeoutSeconds === undefined ? {} : { toolTimeoutSeconds }),
              onSetToolTimeoutFor: (name: string, seconds?: number) =>
                props.transport.post({
                  type: 'setToolTimeoutFor',
                  name,
                  ...(seconds === undefined ? {} : { seconds }),
                } satisfies UiToHostMessage),
              onSetToolTimeout: (seconds?: number) =>
                props.transport.post({
                  type: 'setToolTimeout',
                  ...(seconds === undefined ? {} : { seconds }),
                } satisfies UiToHostMessage),
              onSetOffice: (excel, outlook) => {
                setToolCatalogue((current) => ({
                  ...current,
                  office: { ...current.office, excel, outlook },
                }))
                props.transport.post({
                  type: 'setOffice',
                  excel,
                  outlook,
                } satisfies UiToHostMessage)
              },
            }}
            {...(reviews !== undefined
              ? {
                  reviews: {
                    ...reviews,
                    onDecide: (id: string, approved: boolean, reason?: string) =>
                      props.transport.post({
                        type: 'decideReview',
                        id,
                        approved,
                        ...(reason !== undefined ? { reason } : {}),
                      } satisfies UiToHostMessage),
                  },
                }
              : {})}
            {...(variables !== undefined
              ? {
                  variables: {
                    ...variables,
                    onSaveUser: (next) =>
                      props.transport.post({
                        type: 'saveUserVariables',
                        variables: next,
                      } satisfies UiToHostMessage),
                    onSaveAdmin: (next) =>
                      props.transport.post({
                        type: 'saveAdminVariables',
                        variables: next,
                      } satisfies UiToHostMessage),
                    onSaveAdminIds: (ids) =>
                      props.transport.post({ type: 'saveAdminIds', ids } satisfies UiToHostMessage),
                  },
                }
              : {})}
            python={{
              /*
               * Only profiles that exist can be offered. A picker listing something deleted would
               * let someone choose a profile the generator then warns about on every settings load.
               */
              /*
               * Only where the host offers it. The extension declares nothing, so the picker is
               * absent there rather than present and inert — the same rule the Variables and
               * Review tabs follow.
               */
              ...(allowProgrammingProfile
                ? {
                    programming: {
                      profiles: profiles.map((profile) => ({
                        id: profile.id,
                        label: profile.label,
                      })),
                      selectedId: programmingProfileId,
                      onSelect: (id) =>
                        props.transport.post({
                          type: 'setProgrammingProfile',
                          id,
                        } satisfies UiToHostMessage),
                    },
                  }
                : {}),
              status: pythonStatus,
              settings: pythonSettings,
              onBrowse: browseForPath,
              pickedPath,
              onOpenFile: openManagedFile,
              onDeleteTool: (name: string) =>
                props.transport.post({ type: 'deletePythonTool', name } satisfies UiToHostMessage),
              onApproveTool: (name: string) =>
                props.transport.post({ type: 'approvePythonTool', name } satisfies UiToHostMessage),
              onSave: (settings) =>
                /*
                 * Every field, always — empty included.
                 *
                 * **`venvPath` was simply absent from this message.** The tab collected it, and
                 * this dropped it on the floor: the field had never worked, and because the host
                 * wrote the whole `python` block from what arrived, saving anything at all erased
                 * a virtualenv configured by hand. Reported as a venv disappearing after an
                 * update, which is when somebody next opened the tab and pressed Save.
                 *
                 * Omitting an *empty* field is the second half of the same mistake. The host
                 * merges now, so absent means "leave it alone" — which would make clearing a box
                 * do nothing at all. Sent empty, it means "remove this", and the two are
                 * different things the message has to be able to say.
                 */
                props.transport.post({
                  type: 'setPython',
                  dynamicTools: settings.dynamicTools,
                  uvPath: settings.uvPath,
                  toolsDir: settings.toolsDir,
                  venvPath: settings.venvPath,
                  interpreterPath: settings.interpreterPath,
                  timeoutSeconds: settings.timeoutSeconds,
                  indexUrl: settings.indexUrl,
                  offline: settings.offline,
                  // Same reasoning as `venvPath` above, which was dropped here once and cost a
                  // user their configured virtualenv: every field the tab collects is sent.
                  env: settings.env,
                } satisfies UiToHostMessage),
            }}
            network={{
              ...(network !== undefined ? { settings: network } : { settings: undefined }),
              onSave: (settings) =>
                props.transport.post({ type: 'saveNetwork', settings } satisfies UiToHostMessage),
            }}
          />
        ) : view === 'history' ? (
          <HistoryList
            tasks={tasks}
            activeTaskId={activeTaskId}
            onOpen={openTask}
            onDelete={deleteTask}
            onNew={newTask}
          />
        ) : hasNoProviders ? (
          <div style={{ padding: 20, textAlign: 'center' }}>
            <p style={{ color: colors.muted }}>No provider configured yet.</p>
            <button type="button" style={primaryButtonStyle(false)} onClick={openSettings}>
              Configure a Provider
            </button>
          </div>
        ) : (
          <Chat
            /*
             * Identifies the conversation so the transcript can open at its end. A new,
             * unsaved chat has no id yet, and 'new' is a stable stand-in for it - without one
             * every keystroke would look like a conversation change and re-pin the scroll.
             */
            plan={plan}
            planCheckpoints={planCheckpoints}
            /*
             * Only specialists that can actually answer, and derived from the same roles message
             * the Agents tab renders — so the picker cannot offer somebody the host would then
             * refuse. A role nobody is assigned to is not addressable.
             */
            directRoles={agents.roles
              .filter((role) => role.available && role.enabled)
              .map((role) => ({ role: role.role, name: role.name, summary: role.summary }))}
            onSetPlan={(next) => {
              // Optimistic, then confirmed by the host's own `plan` message — the strip must not
              // lag a click behind the thing it describes.
              setPlan(next)
              props.transport.post({ type: 'setPlan', plan: next } satisfies UiToHostMessage)
            }}
            conversationKey={activeTaskId ?? 'new'}
            messages={messages}
            isStreaming={isStreaming}
            error={error}
            pendingApproval={pendingApproval}
            pendingForm={pendingForm}
            onSubmitForm={(id, values) => {
              setPendingForm(undefined)
              props.transport.post({
                type: 'formResponse',
                id,
                submitted: true,
                values,
              } satisfies UiToHostMessage)
            }}
            onDismissForm={(id) => {
              setPendingForm(undefined)
              props.transport.post({
                type: 'formResponse',
                id,
                submitted: false,
                values: {},
              } satisfies UiToHostMessage)
            }}
            canRollback={canRollback}
            onSend={send}
            onCancel={cancel}
            onDecideApproval={decideApproval}
            onAlwaysAllow={alwaysAllow}
            onRollback={rollback}
            usage={usage}
            expertSpend={expertSpend}
            supportsVision={supportsVision}
            mentionCandidates={mentionCandidates}
            onQueryMentions={queryMentions}
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSelectProfile={setActiveProfile}
            expertEnabled={expertEnabled}
            queued={queued}
            onUnqueue={unqueue}
            searchConnections={searchConnections.map((connection) => ({
              id: connection.id,
              label: connection.label,
            }))}
            activeSearchId={activeSearchId}
            onSelectSearch={(id) =>
              props.transport.post({
                type: 'setActiveSearchConnection',
                id,
              } satisfies UiToHostMessage)
            }
          />
        )}
      </div>
    </div>
  )
}
