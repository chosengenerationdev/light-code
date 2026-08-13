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
import type { BrowseRequest } from './PathField.js'
import { ProvidersTab, type ProvidersTabProps } from './ProvidersTab.js'

export interface SettingsPanelProps extends ProvidersTabProps {
  approvals: WorkspaceApprovals
  onSetAutoApprove: (group: ApprovableGroup, enabled: boolean) => void
  onRevokeTool: (toolName: string) => void
  onRevokeCommand: (command: string) => void
  maxIterations: number
  onSetMaxIterations: (value: number) => void
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
}

type TabId = 'providers' | 'approvals' | 'mcp' | 'search' | 'expert' | 'network' | 'python'

const TABS: { id: TabId; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'mcp', label: 'MCP' },
  { id: 'search', label: 'Search' },
  { id: 'expert', label: 'Expert' },
  { id: 'network', label: 'Network' },
  { id: 'python', label: 'Python' },
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
      <div style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            style={{
              padding: '8px 12px',
              fontFamily,
              fontSize: 12,
              background: 'transparent',
              color: active === tab.id ? colors.foreground : colors.muted,
              border: 'none',
              borderBottom: `2px solid ${active === tab.id ? colors.buttonBackground : 'transparent'}`,
              cursor: 'pointer',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {active === 'providers' ? (
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
          />
        ) : active === 'search' ? (
          <SearchTab {...props.search} />
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
