import type {
  ApprovableGroup,
  McpPlatform,
  McpServerConfig,
  McpServerState,
  McpToolPermission,
  WorkspaceApprovals,
} from '@light-code/core/browser'
import { useEffect, useState, type ReactElement } from 'react'
import { colors, fontFamily } from '../theme.js'
import { ApprovalsTab } from './ApprovalsTab.js'
import { McpTab } from './McpTab.js'
import { ExpertTab, type ExpertState } from './ExpertTab.js'
import { SearchTab, type SearchTabProps } from './SearchTab.js'
import { NetworkTab, type NetworkTabProps } from './NetworkTab.js'
import { PythonTab, type PythonTabProps } from './PythonTab.js'
import { ToolsTab, type ToolsTabProps } from './ToolsTab.js'
import { ReviewsTab, type ReviewsTabProps } from './ReviewsTab.js'
import { VariablesTab, type VariablesTabProps } from './VariablesTab.js'
import { SkillsTab, type SkillsTabProps } from './SkillsTab.js'
import { SchedulesTab, type SchedulesTabProps } from './SchedulesTab.js'
import type { BrowseRequest } from './PathField.js'
import { ProvidersTab, type ProvidersTabProps } from './ProvidersTab.js'
import { AppearanceSection } from './AppearanceSection.js'
import {
  BookIcon,
  ClockIcon,
  ExpertIcon,
  GlobeIcon,
  PaletteIcon,
  VariablesIcon,
  ProviderIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
  PythonIcon,
  ToolboxIcon,
} from '../icons.js'

export interface SettingsPanelProps extends ProvidersTabProps {
  approvals: WorkspaceApprovals
  onSetAutoApprove: (group: ApprovableGroup, enabled: boolean) => void
  onRevokeTool: (toolName: string) => void
  onRevokeCommand: (command: string) => void
  maxIterations: number
  onSetMaxIterations: (value: number) => void
  readRoots: string[]
  onSetReadRoots: (roots: string[]) => void
  accentColor: string
  onSetAccentColor: (value: string) => void
  expertColor: string
  onSetExpertColor: (value: string) => void
  /** Only where the host has no theme of its own — see `AppearanceSectionProps.theme`. */
  choosesTheme?: boolean
  theme?: 'system' | 'light' | 'dark'
  onSetTheme?: (theme: 'system' | 'light' | 'dark') => void
  mcpServers: McpServerState[]
  mcpJson: string
  mcpWarnings: Record<string, string[]>
  mcpSaveError: string | undefined
  mcpConfigs: Record<string, McpServerConfig>
  mcpPlatform: McpPlatform
  mcpSavedTick: number
  mcpPythonProbe: { interpreter?: string; venvDir?: string; detail: string } | undefined
  onDetectPython: (venvDir: string, script: string) => void
  onBrowse: (request: BrowseRequest) => void
  pickedPath: { purpose: string; path: string } | undefined
  onSaveMcpServer: (name: string, previousName: string | undefined, config: McpServerConfig) => void
  onDeleteMcpServer: (name: string) => void
  onDuplicateMcpServer: (name: string) => void
  onSaveMcp: (json: string) => void
  onRestartMcp: (name: string) => void
  onSetMcpServerEnabled: (name: string, enabled: boolean) => void
  onSetMcpToolPermission: (server: string, tool: string, permission: McpToolPermission) => void
  onSetMcpToolTimeout: (server: string, tool: string, seconds?: number) => void
  onConnectMcp: (name: string) => void
  expert: ExpertState | undefined
  onRecheckExpert: () => void
  onAssessJunior: () => void
  onClearAssessment: () => void
  /** Runs two real consultations to learn what they cost on this plan. */
  onMeasureCost: () => void
  onClearPricing: () => void
  onSetKeepAlive: (enabled: boolean) => void
  onSaveExpert: (
    enabled: boolean,
    path: string,
    model: string,
    limits: { maxSpendUsd: number; maxConsultations: number },
  ) => void
  search: SearchTabProps
  network: Omit<NetworkTabProps, 'onBrowse' | 'pickedPath'>
  python: PythonTabProps
  tools: ToolsTabProps
  /** Changes which tab is shown. Bumped by the host so the same tab can be asked for twice. */
  requestedTab?: { tab: string; nonce: number } | undefined
  /**
   * Session variables, present only where the host has them.
   *
   * Absent in the VS Code extension — one user with their own environment has nothing to
   * resolve — and the tab is not rendered at all rather than rendered empty. A tab that exists
   * but can never do anything is worse than one that does not.
   */
  /**
   * Work waiting to be approved. Present only where the host has a queue — a shared server.
   *
   * Shown to authors too, not only administrators: a rejection with a reason has to reach the
   * person who must act on it, and a queue only administrators can see leaves the author waiting
   * without knowing what for.
   */
  reviews?: ReviewsTabProps | undefined
  variables?: VariablesTabProps | undefined
  skills: SkillsTabProps
  schedules: SchedulesTabProps
}

type TabId =
  | 'providers'
  | 'approvals'
  | 'mcp'
  | 'search'
  | 'expert'
  | 'network'
  | 'python'
  | 'tools'
  | 'skills'
  | 'schedules'
  | 'appearance'
  | 'variables'
  | 'reviews'

/**
 * Icons rather than words, with the **active tab keeping its label**.
 *
 * Nine labelled tabs already overflowed a sidebar and grew a horizontal scrollbar, which is the
 * worst of both: it hides tabs *and* takes vertical space. Icons alone fit, but ten unlabelled
 * glyphs is a memory test — "was Approvals the shield or the lock?" — so the selected one
 * expands to name itself. You can always see where you are, and the row still fits.
 *
 * Every icon keeps its label as a tooltip, so nothing is discoverable only by clicking.
 */
/** The last documentation-index run, as one line. Undefined when nothing has run yet. */
function describeDocsResult(
  result: { indexed?: number; index?: string; error?: string } | undefined,
): string | undefined {
  if (result === undefined) return undefined
  if (result.error !== undefined) return `Failed: ${result.error}`
  const count = result.indexed ?? 0
  return `Indexed ${String(count)} ${count === 1 ? 'entry' : 'entries'}.`
}

const TABS: { id: TabId; label: string; Icon: (props: { size?: number }) => ReactElement }[] = [
  { id: 'providers', label: 'Providers', Icon: ProviderIcon },
  { id: 'approvals', label: 'Approvals', Icon: ShieldIcon },
  { id: 'mcp', label: 'MCP', Icon: ServerIcon },
  { id: 'search', label: 'Search', Icon: SearchIcon },
  { id: 'expert', label: 'Expert', Icon: ExpertIcon },
  { id: 'schedules', label: 'Schedules', Icon: ClockIcon },
  { id: 'python', label: 'Python', Icon: PythonIcon },
  // After the sources it lists, because it is where you go to *read* rather than change.
  { id: 'tools', label: 'Tools', Icon: ToolboxIcon },
  { id: 'skills', label: 'Skills', Icon: BookIcon },
  { id: 'network', label: 'Network', Icon: GlobeIcon },
  { id: 'reviews', label: 'Review', Icon: ShieldIcon },
  { id: 'variables', label: 'Variables', Icon: VariablesIcon },
  { id: 'appearance', label: 'Appearance', Icon: PaletteIcon },
]

/**
 * Tabbed shell. MCP and Modes tabs slot in here in later phases without redesigning it.
 * (Modes has no tab of its own — the mode selector lives in the chat header, where it is
 * actually used.)
 */
export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const [active, setActive] = useState<TabId>('providers')

  /*
   * Keyed on a nonce, not on the tab name: the walkthrough may ask for the tab already
   * showing — someone re-reading a step — and an effect keyed on the name alone would do
   * nothing the second time, which reads as a broken button.
   */
  /*
   * A tab that has gone away takes the view with it — otherwise a session that loses the
   * Variables tab (a reconnect that resolves differently) would render an empty pane.
   */
  const present: Record<string, boolean> = {
    variables: props.variables !== undefined,
    reviews: props.reviews !== undefined,
  }
  const visible = TABS.filter((tab) => present[tab.id] ?? true)
  const shown = visible.some((tab) => tab.id === active) ? active : 'providers'

  const requested = props.requestedTab
  useEffect(() => {
    if (requested === undefined) return
    if (TABS.some((tab) => tab.id === requested.tab)) setActive(requested.tab as TabId)
  }, [requested])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        role="tablist"
        className="lc-scroll"
        style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, flexShrink: 0, overflowX: 'auto' }}
      >
        {/*
          Filtered rather than disabled. The Variables tab only exists where the host has the
          concept, and a greyed-out tab would invite the question this cannot answer.
        */}
        {visible.map((tab) => {
          const selected = shown === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              // Drives the underline in styles.ts, which scales from the centre so switching
              // tabs slides rather than blinks.
              aria-selected={selected}
              className="lc-tab"
              // The label is always reachable, even when only the icon is drawn.
              title={tab.label}
              aria-label={tab.label}
              onClick={() => setActive(tab.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: selected ? '8px 10px' : '8px 8px',
                fontFamily,
                fontSize: 12,
                background: 'transparent',
                color: selected ? colors.accent : colors.muted,
                border: 'none',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              <tab.Icon size={15} />
              {selected && <span>{tab.label}</span>}
            </button>
          )
        })}
        </div>
      {/* Keyed on the tab so a switch re-mounts and replays the entry animation. */}
      <div key={shown} className="lc-scroll lc-panel" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {shown === 'reviews' && props.reviews !== undefined ? (
          <ReviewsTab {...props.reviews} />
        ) : shown === 'variables' && props.variables !== undefined ? (
          <VariablesTab {...props.variables} />
        ) : shown === 'appearance' ? (
          <div style={{ padding: 12 }}>
            <AppearanceSection
              accentColor={props.accentColor}
              onChangeAccent={props.onSetAccentColor}
              expertColor={props.expertColor}
              onChangeExpert={props.onSetExpertColor}
              {...(props.theme === undefined ? {} : { theme: props.theme })}
              {...(props.choosesTheme === true && props.onSetTheme !== undefined
                ? { onChangeTheme: props.onSetTheme }
                : {})}
            />
          </div>
        ) : shown === 'providers' ? (
          <ProvidersTab
            {...(props.sharedProfileIds !== undefined ? { sharedProfileIds: props.sharedProfileIds } : {})}
            profiles={props.profiles}
            activeProfileId={props.activeProfileId}
            onSave={props.onSave}
            onDuplicate={props.onDuplicate}
            onDelete={props.onDelete}
            onSetActive={props.onSetActive}
            onExport={props.onExport}
            onImport={props.onImport}
            onRequestModels={props.onRequestModels}
            onTestConnection={props.onTestConnection}
            onEditingChange={props.onEditingChange}
            models={props.models}
            {...(props.modelsWarning !== undefined ? { modelsWarning: props.modelsWarning } : {})}
            modelsLoading={props.modelsLoading}
            testRunning={props.testRunning}
            {...(props.testResult !== undefined ? { testResult: props.testResult } : {})}
          />
        ) : shown === 'approvals' ? (
          <ApprovalsTab
            approvals={props.approvals}
            onSetAutoApprove={props.onSetAutoApprove}
            onRevokeTool={props.onRevokeTool}
            onRevokeCommand={props.onRevokeCommand}
            maxIterations={props.maxIterations}
            onSetMaxIterations={props.onSetMaxIterations}
            readRoots={props.readRoots}
            onSetReadRoots={props.onSetReadRoots}
          />
        ) : shown === 'search' ? (
          <SearchTab {...props.search} />
        ) : shown === 'schedules' ? (
          <SchedulesTab {...props.schedules} />
        ) : shown === 'skills' ? (
          <SkillsTab {...props.skills} />
        ) : shown === 'tools' ? (
          <ToolsTab {...props.tools} />
        ) : shown === 'python' ? (
          <PythonTab {...props.python} />
        ) : shown === 'network' ? (
          <NetworkTab {...props.network} onBrowse={props.onBrowse} pickedPath={props.pickedPath} />
        ) : shown === 'expert' ? (
          <ExpertTab
            expert={props.expert}
            onSave={props.onSaveExpert}
            onRecheck={props.onRecheckExpert}
            onAssess={props.onAssessJunior}
            onClearAssessment={props.onClearAssessment}
            onMeasureCost={props.onMeasureCost}
            onClearPricing={props.onClearPricing}
            onSetKeepAlive={props.onSetKeepAlive}
            onBrowse={props.onBrowse}
            pickedPath={props.pickedPath}
          />
        ) : (
          <McpTab
            servers={props.mcpServers}
            json={props.mcpJson}
            warnings={props.mcpWarnings}
            saveError={props.mcpSaveError}
            configs={props.mcpConfigs}
            platform={props.mcpPlatform}
            savedTick={props.mcpSavedTick}
            pythonProbe={props.mcpPythonProbe}
            onDetectPython={props.onDetectPython}
            onBrowse={props.onBrowse}
            pickedPath={props.pickedPath}
            onSaveServer={props.onSaveMcpServer}
            onDeleteServer={props.onDeleteMcpServer}
            onDuplicateServer={props.onDuplicateMcpServer}
            onSave={props.onSaveMcp}
            onRestart={props.onRestartMcp}
            onSetServerEnabled={props.onSetMcpServerEnabled}
            onSetToolPermission={props.onSetMcpToolPermission}
            onSetToolTimeout={props.onSetMcpToolTimeout}
            onConnect={props.onConnectMcp}
            /*
             * Fed from the Search tab's own props rather than from new state. One source for
             * "is the dispatcher on, is it indexing, what did the last run say" — two would
             * drift, which is the bug shape that has cost this project the most time.
             */
            docsIndex={{
              enabled: props.search.dispatcher.enabled,
              ready: props.search.dispatcher.retrievalReady,
              indexing: props.search.dispatcher.indexing,
              result: describeDocsResult(props.search.dispatcher.result),
            }}
            onIndexDocs={() => props.search.dispatcher.onIndexDocs('tool')}
          />
        )}
      </div>
    </div>
  )
}
