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
  type PythonStatus,
  type McpToolPermission,
  type TestConnectionStep,
  type Transport,
  type UiToHostMessage,
  type WorkspaceApprovals,
} from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { Chat } from './Chat.js'
import type { PendingApproval } from './approval/ApprovalPrompt.js'
import type { DisplayMessage } from './MessageList.js'
import { ModeSelector } from './ModeSelector.js'
import { SettingsPanel } from './settings/SettingsPanel.js'
import type { ExpertState } from './settings/ExpertTab.js'
import type { SearchIndex } from './settings/SearchTab.js'
import type { EmbedderState } from './settings/IndexingSection.js'
import { HistoryList } from './history/HistoryList.js'
import { BackIcon, HistoryIcon, NewTaskIcon, SettingsIcon } from './icons.js'
import { applyAccent, applyExpert, DEFAULT_ACCENT, DEFAULT_EXPERT } from './styles.js'
import { colors, fontFamily, iconButtonStyle, primaryButtonStyle } from './theme.js'

export interface AppProps {
  transport: Transport
}

type View = 'chat' | 'settings' | 'history'

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
    { kind: 'text', role: last.role, content: last.content, ...(last.expertInformed === true ? { expertInformed: true } : {}) },
  ]
}

export function App(props: AppProps): ReactElement {
  const [view, setView] = useState<View>('chat')
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | undefined>(undefined)
  const [profilesLoaded, setProfilesLoaded] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | undefined>(undefined)
  const [canRollback, setCanRollback] = useState(false)
  const [modeId, setModeId] = useState<string>(DEFAULT_MODE_ID)
  const [approvals, setApprovals] = useState<WorkspaceApprovals>({})
  const [maxIterations, setMaxIterations] = useState(25)
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT)
  const [readRoots, setReadRoots] = useState<string[]>([])
  const [expertColor, setExpertColor] = useState(DEFAULT_EXPERT)
  const [expertSpend, setExpertSpend] = useState<{
    usd: number
    consultations: number
    unpriced: number
    usage?: number
    exhausted?: boolean
    maxSpendUsd: number
    maxConsultations: number
    overridden: boolean
  }>({ usd: 0, consultations: 0, unpriced: 0, maxSpendUsd: 0, maxConsultations: 0, overridden: false })
  const [dispatcher, setDispatcher] = useState<{ enabled: boolean; hiddenTools: number; docsIndex?: string }>({
    enabled: false,
    hiddenTools: 0,
  })
  const [docsIndexing, setDocsIndexing] = useState(false)
  const [searchLog, setSearchLog] = useState<SearchLogEntry[]>([])
  const [searchProbe, setSearchProbe] = useState<{ query: string; text: string; error?: string } | undefined>(undefined)
  const [searchProbeRunning, setSearchProbeRunning] = useState(false)
  const [docsResult, setDocsResult] = useState<{ indexed?: number; index?: string; error?: string } | undefined>(
    undefined,
  )
  const [mcpServers, setMcpServers] = useState<McpServerState[]>([])
  const [mcpJson, setMcpJson] = useState('{\n  "mcpServers": {}\n}')
  const [mcpWarnings, setMcpWarnings] = useState<Record<string, string[]>>({})
  const [mcpSaveError, setMcpSaveError] = useState<string | undefined>(undefined)
  const [mcpConfigs, setMcpConfigs] = useState<Record<string, McpServerConfig>>({})
  const [mcpPlatform, setMcpPlatform] = useState<McpPlatform>('posix')
  const [mcpSavedTick, setMcpSavedTick] = useState(0)
  const [pickedPath, setPickedPath] = useState<{ purpose: string; path: string } | undefined>(undefined)
  const [pythonProbe, setPythonProbe] = useState<{ interpreter?: string; venvDir?: string; detail: string } | undefined>(
    undefined,
  )
  const [models, setModels] = useState<string[]>([])
  const [modelsWarning, setModelsWarning] = useState<string | undefined>(undefined)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [testRunning, setTestRunning] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; steps: TestConnectionStep[] } | undefined>(undefined)
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
  const [searchTestResult, setSearchTestResult] = useState<{ ok: boolean; detail: string } | undefined>(undefined)
  const [searchSavedTick, setSearchSavedTick] = useState(0)
  const [embedder, setEmbedder] = useState<EmbedderState | undefined>(undefined)
  const [indexProgress, setIndexProgress] = useState<IndexProgress | undefined>(undefined)
  const [indexResult, setIndexResult] = useState<{ result?: IndexResult; error?: string } | undefined>(undefined)
  const [embedderModels, setEmbedderModels] = useState<string[]>([])
  const [embedderModelsWarning, setEmbedderModelsWarning] = useState<string | undefined>(undefined)
  const [embedderModelsLoading, setEmbedderModelsLoading] = useState(false)
  const [embedderSavedTick, setEmbedderSavedTick] = useState(0)
  const [pythonStatus, setPythonStatus] = useState<PythonStatus | undefined>(undefined)
  const [skills, setSkills] = useState<{ name: string; description: string; filePath: string }[]>([])
  const [skillIssues, setSkillIssues] = useState<{ filePath: string; detail: string }[]>([])
  const [skillsDir, setSkillsDir] = useState<string | undefined>(undefined)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [scheduleTools, setScheduleTools] = useState<ScheduleToolInfo[]>([])
  const [schedulerState, setSchedulerState] = useState<{ running: boolean; lastTickAt?: number } | undefined>(
    undefined,
  )
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
          const updated: DisplayMessage = { kind: 'reasoning', content: message.text, pending: true }
          if (index === -1) return [...prev, updated]
          return [...prev.slice(0, index), updated, ...prev.slice(index + 1)]
        })
      } else if (message.type === 'toolCall') {
        setMessages((prev) => [
          ...finalizePendingMessage(prev),
          { kind: 'tool', toolCall: message.toolCall, ...(message.expertInformed === true ? { expertInformed: true } : {}) },
        ])
      } else if (message.type === 'toolResult') {
        // Replace the pending entry for this call rather than appending a second one.
        setMessages((prev) => {
          const entry: DisplayMessage = {
            kind: 'tool',
            toolCall: message.toolCall,
            ...(message.expertInformed === true ? { expertInformed: true } : {}),
          }
          const index = prev.findIndex((m) => m.kind === 'tool' && m.toolCall.id === message.toolCall.id)
          if (index === -1) return [...prev, entry]
          return [...prev.slice(0, index), entry, ...prev.slice(index + 1)]
        })
      } else if (message.type === 'approvalRequest') {
        setMessages(finalizePendingMessage)
        setPendingApproval({
          id: message.id,
          toolName: message.toolName,
          group: message.group,
          preview: message.preview,
          ...(message.alwaysScope === undefined ? {} : { alwaysScope: message.alwaysScope }),
        })
      } else if (message.type === 'settings') {
        setModeId(message.modeId)
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
        setMessages((prev) => [...finalizePendingMessage(prev), { kind: 'text', role: 'user', content: message.text }])
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
      } else if (message.type === 'schedules') {
        setSchedules(message.schedules)
        setScheduleTools(message.tools)
        setRunningScheduleId(message.runningId)
        setSchedulerState(message.scheduler)
      } else if (message.type === 'searchLog') {
        setSearchLog(message.entries)
      } else if (message.type === 'searchProbe') {
        setSearchProbeRunning(false)
        setSearchProbe({
          query: message.query,
          text: message.text,
          ...(message.error !== undefined ? { error: message.error } : {}),
        })
      } else if (message.type === 'dispatcher') {
        setDispatcher({
          enabled: message.enabled,
          hiddenTools: message.hiddenTools,
          ...(message.docsIndex !== undefined ? { docsIndex: message.docsIndex } : {}),
        })
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
        })
      } else if (message.type === 'mcpServerSaved') {
        setMcpSavedTick((tick) => tick + 1)
      } else if (message.type === 'embedder') {
        setEmbedder({
          ...(message.profileId !== undefined ? { profileId: message.profileId } : {}),
          ...(message.model !== undefined ? { model: message.model } : {}),
          ...(message.dimensions !== undefined ? { dimensions: message.dimensions } : {}),
          ...(message.indexName !== undefined ? { indexName: message.indexName } : {}),
          ...(message.indexNameIsCustom !== undefined ? { indexNameIsCustom: message.indexNameIsCustom } : {}),
          ...(message.indexPrefix !== undefined ? { indexPrefix: message.indexPrefix } : {}),
          defaultIndexPrefix: message.defaultIndexPrefix,
          indexedFiles: message.indexedFiles,
        })
      } else if (message.type === 'skills') {
        setSkills(message.skills)
        setSkillIssues(message.issues)
        setSkillsDir(message.skillsDir)
        setSkillExtraDirs(message.extraDirs)
      } else if (message.type === 'python') {
        setPythonStatus(message.status)
      } else if (message.type === 'embedderModels') {
        setEmbedderModels(message.models)
        setEmbedderModelsWarning(message.warning)
        setEmbedderModelsLoading(false)
      } else if (message.type === 'embedderSaved') {
        setEmbedderSavedTick((tick) => tick + 1)
      } else if (message.type === 'indexProgress') {
        setIndexProgress(message.progress)
      } else if (message.type === 'indexResult') {
        setIndexProgress(undefined)
        setIndexResult({
          ...(message.result !== undefined ? { result: message.result } : {}),
          ...(message.error !== undefined ? { error: message.error } : {}),
        })
      } else if (message.type === 'searchConnectionSaved') {
        setSearchSavedTick((tick) => tick + 1)
      } else if (message.type === 'network') {
        setNetwork(message.settings)
      } else if (message.type === 'expert') {
        setExpert({
          enabled: message.enabled,
          available: message.available,
          path: message.path,
          ...(message.version !== undefined ? { version: message.version } : {}),
          ...(message.reason !== undefined ? { reason: message.reason } : {}),
          ...(message.model !== undefined ? { model: message.model } : {}),
          maxSpendUsd: message.maxSpendUsd,
          maxConsultations: message.maxConsultations,
        })
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
    props.transport.post({ type: 'requestSearch' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestNetwork' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestPython' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestSkills' } satisfies UiToHostMessage)
    props.transport.post({ type: 'requestSchedules' } satisfies UiToHostMessage)

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
    const shown = images.length > 0 ? `${text}${text.length > 0 ? '\n' : ''}[${images.length} image(s) attached]` : text
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
    onDelete: (id: string) => props.transport.post({ type: 'deleteSearchConnection', id } satisfies UiToHostMessage),
    onSetActive: (id: string | undefined) =>
      props.transport.post({ type: 'setActiveSearchConnection', id } satisfies UiToHostMessage),
    onListIndexes: (connection: SearchConnectionInput) =>
      props.transport.post({ type: 'requestSearchIndexes', connection } satisfies UiToHostMessage),
    onTest: (connection: SearchConnectionInput) => {
      setSearchTestResult(undefined)
      props.transport.post({ type: 'testSearchConnection', connection } satisfies UiToHostMessage)
    },
    indexing: {
      embedder,
      profiles,
      connectionLabel: searchConnections.find((connection) => connection.id === activeSearchId)?.label,
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
      onSaveEmbedder: (profileId: string, model: string, dimensions: number, indexName: string, indexPrefix: string) => {
        setError(undefined)
        props.transport.post({
          type: 'saveEmbedder',
          profileId,
          model,
          dimensions,
          ...(indexName.length > 0 ? { indexName } : {}),
          ...(indexPrefix.length > 0 ? { indexPrefix } : {}),
        } satisfies UiToHostMessage)
      },
      onStartIndexing: () => {
        setIndexResult(undefined)
        props.transport.post({ type: 'startIndexing' } satisfies UiToHostMessage)
      },
      onCancelIndexing: () => props.transport.post({ type: 'cancelIndexing' } satisfies UiToHostMessage),
    },
    dispatcher: {
      enabled: dispatcher.enabled,
      hiddenTools: dispatcher.hiddenTools,
      ...(dispatcher.docsIndex !== undefined ? { docsIndex: dispatcher.docsIndex } : {}),
      indexing: docsIndexing,
      ...(docsResult !== undefined ? { result: docsResult } : {}),
      // Semantic matching needs both a place to put vectors and something to make them with.
      retrievalReady: activeSearchId !== undefined && embedder?.model !== undefined,
      onToggle: (enabled: boolean) => {
        setDispatcher((current) => ({ ...current, enabled }))
        props.transport.post({ type: 'setDispatcher', enabled } satisfies UiToHostMessage)
      },
      onIndexDocs: () => {
        setDocsResult(undefined)
        setDocsIndexing(true)
        props.transport.post({ type: 'indexDocs' } satisfies UiToHostMessage)
      },
      onClearDocsIndex: () => {
        setDocsResult(undefined)
        setDocsIndexing(true)
        props.transport.post({ type: 'clearDocsIndex' } satisfies UiToHostMessage)
      },
    },
    activity: {
      entries: searchLog,
      probe: searchProbe,
      probeRunning: searchProbeRunning,
      onProbe: (query: string, target: 'codebase' | 'docs') => {
        setSearchProbe(undefined)
        setSearchProbeRunning(true)
        props.transport.post({ type: 'runSearchProbe', query, target } satisfies UiToHostMessage)
      },
      onClear: () => props.transport.post({ type: 'clearSearchLog' } satisfies UiToHostMessage),
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
  const saveMcpServer = (name: string, previousName: string | undefined, config: McpServerConfig): void => {
    setError(undefined)
    props.transport.post({
      type: 'saveMcpServer',
      name,
      ...(previousName !== undefined ? { previousName } : {}),
      config,
    } satisfies UiToHostMessage)
  }
  const browseForPath = (request: { purpose: string; kind: 'file' | 'folder'; extensions?: string[] }): void => {
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
  const setMcpToolPermission = (server: string, tool: string, permission: McpToolPermission): void => {
    props.transport.post({ type: 'setMcpToolPermission', server, tool, permission } satisfies UiToHostMessage)
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
            <ModeSelector modeId={modeId} disabled={isStreaming} onChange={changeMode} expertAvailable={expertEnabled} />
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
            <button type="button" aria-label="History" title="History" style={iconButtonStyle('ghost')} onClick={openHistory}>
              <HistoryIcon />
            </button>
            <button type="button" aria-label="Settings" title="Settings" style={iconButtonStyle('ghost')} onClick={openSettings}>
              <SettingsIcon />
            </button>
          </div>
        ) : (
          <button type="button" aria-label="Back" title="Back" style={iconButtonStyle('ghost')} onClick={() => setView('chat')}>
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
            border: '1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground))',
          }}
        >
          <span style={{ flex: 1 }}>{error}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setError(undefined)}
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}
          >
            ✕
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'settings' ? (
          <SettingsPanel
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSave={saveProfile}
            onDuplicate={duplicateProfile}
            onDelete={deleteProfile}
            onSetActive={setActiveProfile}
            onExport={exportConfig}
            onImport={importConfig}
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
            onSetReadRoots={(roots) => props.transport.post({ type: 'setReadRoots', roots } satisfies UiToHostMessage)}
            accentColor={accentColor}
            onSetAccentColor={(value) => {
              // Applied locally first so dragging through swatches is instant; config catches
              // up on the round trip and re-confirms it.
              setAccentColor(value)
              applyAccent(value)
              props.transport.post({ type: 'setAccentColor', value } satisfies UiToHostMessage)
            }}
            expertColor={expertColor}
            onSetExpertColor={(value) => {
              setExpertColor(value)
              applyExpert(value)
              props.transport.post({ type: 'setExpertColor', value } satisfies UiToHostMessage)
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
            onSaveMcp={saveMcp}
            onRestartMcp={restartMcp}
            onSetMcpServerEnabled={setMcpServerEnabled}
            onSetMcpToolPermission={setMcpToolPermission}
            onConnectMcp={connectMcp}
            expert={expert}
            onSaveExpert={saveExpert}
            search={searchProps}
            skills={{
              skills,
              issues: skillIssues,
              skillsDir,
              extraDirs: skillExtraDirs,
              configuredDir: skillConfiguredDir,
              onDelete: (name) => props.transport.post({ type: 'deleteSkillFile', name } satisfies UiToHostMessage),
              onSaveDirs: (dir: string, paths: string[]) => {
                setSkillConfiguredDir(dir)
                props.transport.post({ type: 'saveSkillDirs', dir, paths } satisfies UiToHostMessage)
              },
            }}
            schedules={{
              schedules,
              tools: scheduleTools,
              runningId: runningScheduleId,
              onSave: (schedule) => props.transport.post({ type: 'saveSchedule', schedule } satisfies UiToHostMessage),
              onDelete: (id) => props.transport.post({ type: 'deleteSchedule', id } satisfies UiToHostMessage),
              onToggle: (id, enabled) =>
                props.transport.post({ type: 'setScheduleEnabled', id, enabled } satisfies UiToHostMessage),
              onRunNow: (id) => props.transport.post({ type: 'runScheduleNow', id } satisfies UiToHostMessage),
              // The same candidates the composer uses; the host does not care who asked.
              mentionCandidates,
              onQueryMentions: queryMentions,
              onOpenRun: (taskId: string, title: string) =>
                props.transport.post({ type: 'openScheduleRun', taskId, title } satisfies UiToHostMessage),
              scheduler: schedulerState,
              onRestartScheduler: () => props.transport.post({ type: 'restartScheduler' } satisfies UiToHostMessage),
              onDeleteRun: (id, at) =>
                props.transport.post({ type: 'deleteScheduleRun', id, at } satisfies UiToHostMessage),
              onClearRuns: (id) =>
                props.transport.post({
                  type: 'clearScheduleRuns',
                  ...(id === undefined ? {} : { id }),
                } satisfies UiToHostMessage),
            }}
            python={{
              status: pythonStatus,
              onBrowse: browseForPath,
              pickedPath,
              onSave: (settings) =>
                props.transport.post({
                  type: 'setPython',
                  dynamicTools: settings.dynamicTools,
                  ...(settings.uvPath.length > 0 ? { uvPath: settings.uvPath } : {}),
                  ...(settings.toolsDir.length > 0 ? { toolsDir: settings.toolsDir } : {}),
                  timeoutSeconds: settings.timeoutSeconds,
                  ...(settings.indexUrl.length > 0 ? { indexUrl: settings.indexUrl } : {}),
                  offline: settings.offline,
                } satisfies UiToHostMessage),
            }}
            network={{
              ...(network !== undefined ? { settings: network } : { settings: undefined }),
              onSave: (settings) => props.transport.post({ type: 'saveNetwork', settings } satisfies UiToHostMessage),
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
            messages={messages}
            isStreaming={isStreaming}
            error={error}
            pendingApproval={pendingApproval}
            canRollback={canRollback}
            onSend={send}
            onCancel={cancel}
            onDecideApproval={decideApproval}
            onAlwaysAllow={alwaysAllow}
            onRollback={rollback}
            usage={usage}
            expertSpend={expertSpend}
            onSetExpertLimits={(limits) =>
              props.transport.post({ type: 'setTaskExpertLimits', ...limits } satisfies UiToHostMessage)
            }
            supportsVision={supportsVision}
            mentionCandidates={mentionCandidates}
            onQueryMentions={queryMentions}
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSelectProfile={setActiveProfile}
            expertEnabled={expertEnabled}
            queued={queued}
            onUnqueue={unqueue}
            searchConnections={searchConnections.map((connection) => ({ id: connection.id, label: connection.label }))}
            activeSearchId={activeSearchId}
            onSelectSearch={(id) =>
              props.transport.post({ type: 'setActiveSearchConnection', id } satisfies UiToHostMessage)
            }
          />
        )}
      </div>
    </div>
  )
}
