// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HostToUiMessage, Transport } from '@light-code/core/browser'

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
  /*
   * Present but empty, which is what "nothing configured" means for the Agents tab: every role
   * exists and nobody is assigned to any of them. Absent is a different thing entirely, and the
   * fixture is cast, so leaving it out is not a type error — it is a crash, which is exactly what
   * this file caught.
   */
  agents: {
    roles: [],
    profiles: [],
    cliAvailable: false,
    budgetMatters: false,
    teamGuidance: '',
    defaultTeamGuidance: '',
    teamGuidanceIsDefault: true,
    colors: {},
    onAssign: () => undefined,
    onSetPrompt: () => undefined,
    onSetBudget: () => undefined,
    onSetTeamGuidance: () => undefined,
  },
  onSetAgentColor: () => undefined,
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
    // No folder open in the fixture, so the per-project controls are correctly absent.
    project: { workspaceOpen: false, overridden: [] },
    onClearProject: () => undefined,
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
      onClearIndex: () => undefined,
      probe: { running: false, result: undefined },
      onProbe: () => undefined,
      onClearProbe: () => undefined,
      onRefreshTools: () => undefined,
    },
  },
  network: { warnings: [], issues: [] },
  python: { status: undefined, settings: {}, tools: [], issues: [] },
  atlassian: {
    products: undefined,
    savedTicks: {},
    tests: {},
    testing: {},
    onSave: () => undefined,
    onClearToken: () => undefined,
    onTest: () => undefined,
  },
  tools: {
    tools: [],
    dispatcher: false,
    // Unsupported until the host says otherwise, so the toggles are never enabled on a machine
    // that cannot honour them.
    office: { supported: false, excel: false, outlook: false },
    onSetOffice: () => undefined,
    probe: { running: false, result: undefined },
    onProbe: () => undefined,
    onClearProbe: () => undefined,
  },
  skills: {
    skills: [],
    issues: [],
    extraDirs: [],
    configuredDir: '',
    probe: { running: false, result: undefined },
    onProbe: () => undefined,
    onClearProbe: () => undefined,
  },
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

function render(requestedTab?: { tab: string; nonce: number }, transport?: Transport): void {
  act(() =>
    root.render(
      <SettingsPanel
        {...(noops as React.ComponentProps<typeof SettingsPanel>)}
        {...(base as unknown as React.ComponentProps<typeof SettingsPanel>)}
        {...(requestedTab !== undefined ? { requestedTab } : {})}
        {...(transport !== undefined ? { transport } : {})}
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
    render({ tab: 'agents', nonce: 2 })
    expect(activeTab()).toBe('agents')
  })

  /**
   * A renamed tab still answers to its old name.
   *
   * Tab ids are written into walkthrough links, documentation and whatever anybody bookmarked,
   * and an id the panel does not recognise is *ignored* — so without this, a link to the old
   * Expert tab would appear to do nothing at all, which is worse than an error.
   */
  it('still opens Agents for a link that asks for the old Expert tab', () => {
    render({ tab: 'network', nonce: 1 })
    render({ tab: 'expert', nonce: 2 })
    expect(activeTab()).toBe('agents')
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
    'agents',
    'schedules',
    'python',
    'tools',
    'devops',
    'skills',
    'network',
    'appearance',
  ])('renders the %s tab with nothing configured', (tab) => {
    render({ tab, nonce: 1 })
    expect(activeTab()).toBe(tab)
    expect((container.textContent ?? '').length).toBeGreaterThan(20)
  })
})

/**
 * An add-on's own tab. Asked for in exactly these terms: "I don't want the new tab to be appearing in
 * Light Code or Fire Code, it should appear only when addon is installed".
 */
describe('a tab an add-on brings', () => {
  const ICON = 'data:image/svg+xml;base64,PHN2Zy8+'
  function fakeTransport(): Transport & { sent: unknown[]; deliver: (message: HostToUiMessage) => void } {
    let listeners: ((message: unknown) => void)[] = []
    const sent: unknown[] = []
    return {
      sent,
      post: (message: unknown) => sent.push(message),
      onMessage: (listener: (message: unknown) => void) => {
        listeners.push(listener)
        return () => {
          listeners = listeners.filter((l) => l !== listener)
        }
      },
      deliver: (message: HostToUiMessage) => act(() => [...listeners].forEach((listener) => listener(message))),
    }
  }
  const installed = (addons: { pageTitle?: string; state?: 'available' | 'enabled' | 'updated' }[]): HostToUiMessage => ({
    type: 'addons',
    addons: addons.map((extra) => ({
      package: 'light-code-addon-linux',
      version: '0.1.0',
      displayName: 'Linux',
      dir: 'd',
      main: 'm',
      server: 'addon-linux',
      state: extra.state ?? 'enabled',
      ...(extra.pageTitle !== undefined ? { pageTitle: extra.pageTitle, icon: ICON } : {}),
    })),
    problems: [],
    missing: [],
    folders: [],
    defaultFolders: [],
  })

  it('appears only while the add-on is installed and enabled, with its own icon', () => {
    const transport = fakeTransport()
    render(undefined, transport)
    expect(transport.sent).toContainEqual({ type: 'requestAddons' })
    expect(container.querySelector('button[title="Linux"]')).toBeNull()

    transport.deliver(installed([{ pageTitle: 'Linux' }]))
    const tab = container.querySelector<HTMLButtonElement>('button[title="Linux"]')
    expect(tab?.querySelector('img')?.getAttribute('src')).toBe(ICON)
    act(() => tab?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(activeTab()).toBe('linux')
    expect(transport.sent).toContainEqual({ type: 'requestAddonPage', package: 'light-code-addon-linux' })

    // Uninstalled: gone, and the panel falls back rather than showing an empty page.
    transport.deliver(installed([]))
    expect(container.querySelector('button[title="Linux"]')).toBeNull()
    expect(activeTab()).toBe('providers')
    // Installed but declaring no page: no tab either.
    transport.deliver(installed([{}]))
    expect(container.querySelector('button[title="Linux"]')).toBeNull()
    // Installed but switched off, or updated and not yet enabled again: no tab.
    transport.deliver(installed([{ pageTitle: 'Linux', state: 'available' }]))
    expect(container.querySelector('button[title="Linux"]')).toBeNull()
    transport.deliver(installed([{ pageTitle: 'Linux', state: 'updated' }]))
    expect(container.querySelector('button[title="Linux"]')).toBeNull()
    // The Add-ons tab, where they are switched on, is always there.
    expect(container.querySelector('button[title="Add-ons"]')).not.toBeNull()
  })
})
