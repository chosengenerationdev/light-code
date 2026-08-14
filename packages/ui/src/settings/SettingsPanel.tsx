import type {
  ApprovableGroup,
  McpPlatform,
  McpServerConfig,
  McpServerState,
  McpToolPermission,
  WorkspaceApprovals,
} from '@light-code/core/browser'
import { useState, type ReactElement } from 'react'
import { colors, fontFamily } from '../theme.js'
import { ApprovalsTab } from './ApprovalsTab.js'
import { McpTab } from './McpTab.js'
import { ExpertTab, type ExpertState } from './ExpertTab.js'
import { SearchTab, type SearchTabProps } from './SearchTab.js'
import { NetworkTab, type NetworkTabProps } from './NetworkTab.js'
import { PythonTab, type PythonTabProps } from './PythonTab.js'
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
  ProviderIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
  TerminalIcon,
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
  onSaveMcp: (json: string) => void
  onRestartMcp: (name: string) => void
  onSetMcpServerEnabled: (name: string, enabled: boolean) => void
  onSetMcpToolPermission: (server: string, tool: string, permission: McpToolPermission) => void
  onConnectMcp: (name: string) => void
  expert: ExpertState | undefined
  onSaveExpert: (enabled: boolean, path: string, model: string) => void
  search: SearchTabProps
  network: Omit<NetworkTabProps, 'onBrowse' | 'pickedPath'>
  python: PythonTabProps
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
  | 'skills'
  | 'schedules'
  | 'appearance'

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
const TABS: { id: TabId; label: string; Icon: (props: { size?: number }) => ReactElement }[] = [
  { id: 'providers', label: 'Providers', Icon: ProviderIcon },
  { id: 'approvals', label: 'Approvals', Icon: ShieldIcon },
  { id: 'mcp', label: 'MCP', Icon: ServerIcon },
  { id: 'search', label: 'Search', Icon: SearchIcon },
  { id: 'expert', label: 'Expert', Icon: ExpertIcon },
  { id: 'schedules', label: 'Schedules', Icon: ClockIcon },
  { id: 'python', label: 'Python', Icon: TerminalIcon },
  { id: 'skills', label: 'Skills', Icon: BookIcon },
  { id: 'network', label: 'Network', Icon: GlobeIcon },
  { id: 'appearance', label: 'Appearance', Icon: PaletteIcon },
]

/**
 * Tabbed shell. MCP and Modes tabs slot in here in later phases without redesigning it.
 * (Modes has no tab of its own — the mode selector lives in the chat header, where it is
 * actually used.)
 */
export function SettingsPanel(props: SettingsPanelProps): ReactElement {
  const [active, setActive] = useState<TabId>('providers')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        role="tablist"
        className="lc-scroll"
        style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, flexShrink: 0, overflowX: 'auto' }}
      >
        {TABS.map((tab) => {
          const selected = active === tab.id
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
      <div key={active} className="lc-scroll lc-panel" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {active === 'appearance' ? (
          <div style={{ padding: 12 }}>
            <AppearanceSection
              accentColor={props.accentColor}
              onChangeAccent={props.onSetAccentColor}
              expertColor={props.expertColor}
              onChangeExpert={props.onSetExpertColor}
            />
          </div>
        ) : active === 'providers' ? (
          <ProvidersTab
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
        ) : active === 'approvals' ? (
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
        ) : active === 'search' ? (
          <SearchTab {...props.search} />
        ) : active === 'schedules' ? (
          <SchedulesTab {...props.schedules} />
        ) : active === 'skills' ? (
          <SkillsTab {...props.skills} />
        ) : active === 'python' ? (
          <PythonTab {...props.python} />
        ) : active === 'network' ? (
          <NetworkTab {...props.network} onBrowse={props.onBrowse} pickedPath={props.pickedPath} />
        ) : active === 'expert' ? (
          <ExpertTab expert={props.expert} onSave={props.onSaveExpert} />
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
            onSave={props.onSaveMcp}
            onRestart={props.onRestartMcp}
            onSetServerEnabled={props.onSetMcpServerEnabled}
            onSetToolPermission={props.onSetMcpToolPermission}
            onConnect={props.onConnectMcp}
          />
        )}
      </div>
    </div>
  )
}
