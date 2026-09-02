// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SettingsPanel } from './SettingsPanel.js'

/**
 * The walkthrough's buttons are only worth having if they land somewhere.
 *
 * This is the failure mode that would ship green otherwise: the message arrives, nothing reads
 * it, and the panel opens on Providers every time. From the reader's side that is indistinguishable
 * from a button that does nothing at all — the worst outcome for a control whose whole job is to
 * prove where a setting lives.
 */
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Only what the shell itself needs; each tab renders its own empty state from these. */
const base = {
  profiles: [],
  onSave: () => undefined,
  onDuplicate: () => undefined,
  onDelete: () => undefined,
  onSetActive: () => undefined,
  onExport: () => undefined,
  onImport: () => undefined,
  onRequestModels: () => undefined,
  onTestConnection: () => undefined,
  models: [],
  modelsLoading: false,
  testRunning: false,
  approvals: { autoApprove: {}, allowedCommands: [], allowedTools: [] },
  onSetAutoApprove: () => undefined,
  onRevokeTool: () => undefined,
  onRevokeCommand: () => undefined,
  maxIterations: 25,
  accentColor: '#2f7d4f',
  expertColor: '#7a4bbf',
  readRoots: [],
  onSetReadRoots: () => undefined,
  mcpServers: [],
  mcpJson: '{}',
  mcpWarnings: [],
  mcpConfigs: {},
  expert: undefined,
  search: {
    connections: [],
    activity: { entries: [] },
    indexes: [],
    indexing: { profiles: [], models: [], warnings: [], issues: [] },
    // The MCP tab reads this too, since a new server's tools are indexed and the button to
    // reindex belongs where the server was added. Omitting it here crashed that tab.
    dispatcher: {
      enabled: false,
      hiddenTools: 0,
      skills: false,
      hiddenSkills: 0,
      indexing: false,
      retrievalReady: false,
      onToggle: () => undefined,
      onToggleSkills: () => undefined,
      onIndexDocs: () => undefined,
      onClearDocsIndex: () => undefined,
    },
  },
  network: { warnings: [], issues: [] },
  python: { status: undefined, settings: {}, tools: [], issues: [] },
  tools: {
    tools: [],
    dispatcher: false,
    // Unsupported until the host says otherwise, so the toggles are never enabled on a machine
    // that cannot honour them.
    office: { supported: false, excel: false, outlook: false },
    onSetOffice: () => undefined,
  },
  skills: { skills: [], issues: [], extraDirs: [], configuredDir: '' },
  schedules: { schedules: [], runs: [], tools: [], mentionCandidates: [] },
}

/*
 * Every callback the shell hands down. Named individually would be twenty lines of noise for a
 * test about which tab is lit, and a missing one is a render crash rather than a silent pass.
 */
const noops = new Proxy(
  {},
  {
    get: (_target, key: string) => (key.startsWith('on') ? () => undefined : undefined),
    has: () => true,
  },
)

function render(requestedTab?: { tab: string; nonce: number }): void {
  act(() =>
    root.render(
      <SettingsPanel
        {...(noops as React.ComponentProps<typeof SettingsPanel>)}
        {...(base as unknown as React.ComponentProps<typeof SettingsPanel>)}
        {...(requestedTab !== undefined ? { requestedTab } : {})}
      />,
    ),
  )
}

/** The lit tab is the one whose button is marked current. */
function activeTab(): string | undefined {
  const pressed = container.querySelector('[aria-selected="true"], [aria-current="page"]')
  return pressed?.textContent?.trim().toLowerCase()
}

describe('opening settings on a named tab', () => {
  it('starts on Providers when nothing was asked for', () => {
    render()
    expect(activeTab()).toBe('providers')
  })

  it('opens the tab the host asked for', () => {
    render({ tab: 'network', nonce: 1 })
    expect(activeTab()).toBe('network')
  })

  it('moves when a different tab is asked for', () => {
    render({ tab: 'network', nonce: 1 })
    render({ tab: 'expert', nonce: 2 })
    expect(activeTab()).toBe('expert')
  })

  /**
   * Someone re-reading a step and pressing its button a second time. Keyed on the tab name
   * alone this would be a no-op, which reads as a broken button rather than as "you are
   * already here".
   */
  it('comes back to a tab the user has since navigated away from', () => {
    render({ tab: 'search', nonce: 1 })
    // Only the active tab shows its label, so an inactive one is found by its tooltip.
    const appearance = container.querySelector<HTMLButtonElement>('button[title="Appearance"]')
    act(() => appearance?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(activeTab()).toBe('appearance')

    render({ tab: 'search', nonce: 2 })
    expect(activeTab()).toBe('search')
  })

  it('ignores a tab that does not exist rather than blanking the panel', () => {
    render({ tab: 'nonexistent', nonce: 1 })
    expect(activeTab()).toBe('providers')
  })

  /**
   * Every tab, on empty state. The walkthrough sends people straight into tabs they have never
   * configured, which is the least-exercised path in the panel — a tab that throws on a missing
   * list would have been reached only by someone who went looking for it.
   */
  it.each([
    'providers',
    'approvals',
    'mcp',
    'search',
    'expert',
    'schedules',
    'python',
    'tools',
    'skills',
    'network',
    'appearance',
  ])('renders the %s tab with nothing configured', (tab) => {
    render({ tab, nonce: 1 })
    expect(activeTab()).toBe(tab)
    expect((container.textContent ?? '').length).toBeGreaterThan(20)
  })
})
