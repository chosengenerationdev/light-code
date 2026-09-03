import { describe, expect, it } from 'vitest'

import {
  applyWorkspaceOverrides,
  describeOverrides,
  overridesFor,
  workspaceOverrideKey,
  OVERRIDABLE_KEYS,
  type WorkspaceOverrides,
} from './workspaceOverrides.js'

/**
 * Opening a second codebase on one machine and finding it shares the first one's vector store,
 * model and Python environment is simply wrong — and the fix must not weaken invariant 5.
 *
 * The distinction it rests on is *who writes the value*, not whether it may vary: these live in
 * **user** config keyed by workspace path, exactly as `approvals` has since Phase 4. A repository
 * still cannot set any of them.
 */
const base = {
  activeProfileId: 'gateway',
  activeVectorStoreId: 'shared-cluster',
  python: { uvPath: '/usr/bin/uv', venvPath: '/home/me/.venv' },
  profiles: [{ id: 'gateway' }],
} as never

describe('a project saying something different', () => {
  it('replaces a scalar for this project and leaves the default alone', () => {
    const result = applyWorkspaceOverrides(base, { activeVectorStoreId: 'local-qdrant' } as WorkspaceOverrides)
    expect(result.activeVectorStoreId).toBe('local-qdrant')
    expect(result.activeProfileId).toBe('gateway')
  })

  /**
   * A project naming its own `venvPath` means "this project's interpreter", not "this project's
   * interpreter and no uv path at all". Replacing the block would strand it with a broken half.
   */
  it('merges into a nested block rather than replacing it', () => {
    const result = applyWorkspaceOverrides(base, { python: { venvPath: '/repo/.venv' } } as WorkspaceOverrides)
    expect(result.python).toEqual({ uvPath: '/usr/bin/uv', venvPath: '/repo/.venv' })
  })

  it('changes nothing when the project has said nothing', () => {
    expect(applyWorkspaceOverrides(base, undefined)).toEqual(base)
    expect(applyWorkspaceOverrides(base, {} as WorkspaceOverrides)).toEqual(base)
  })

  /**
   * The allow list is the security property. `profiles`, `tls`, `certDir`, `office` and `expert`
   * describe the machine and its credentials — a per-project override of those would reintroduce
   * exactly what invariant 5 exists to prevent, through a door nobody meant to open.
   */
  it('ignores a key that is not overridable, even if one is hand-edited in', () => {
    const result = applyWorkspaceOverrides(base, { profiles: [{ id: 'evil' }] } as unknown as WorkspaceOverrides)
    expect(result.profiles).toEqual([{ id: 'gateway' }])
  })

  it('does not list credentials or machine-wide settings as overridable', () => {
    for (const forbidden of ['profiles', 'vectorStores', 'certDir', 'tls', 'office', 'expert', 'approvals']) {
      expect(OVERRIDABLE_KEYS as readonly string[]).not.toContain(forbidden)
    }
  })

  it('does list the ones a project genuinely owns', () => {
    for (const wanted of ['activeVectorStoreId', 'activeProfileId', 'python', 'embedder', 'modeId']) {
      expect(OVERRIDABLE_KEYS as readonly string[]).toContain(wanted)
    }
  })
})

describe('finding a project’s settings again', () => {
  /**
   * The lesson `approvals` learned the hard way: on Windows the same folder arrives as `d:\x` and
   * `D:\x` depending on how the window was opened, and a JSON key is an exact string — so the
   * project looked like a different one and every setting silently stopped applying.
   */
  it('matches however the path is spelled on this platform', () => {
    const stored = { 'D:\\Projects\\Alpha': { activeProfileId: 'local' } } as Record<string, WorkspaceOverrides>
    const found = overridesFor(stored, 'D:\\Projects\\Alpha')
    expect(found?.activeProfileId).toBe('local')

    if (process.platform === 'win32') {
      expect(overridesFor(stored, 'd:\\projects\\alpha')?.activeProfileId).toBe('local')
      expect(workspaceOverrideKey('D:\\Projects\\Alpha')).toBe(workspaceOverrideKey('d:\\projects\\alpha'))
    }
  })

  it('drops a trailing separator, which is the other way one project gets two entries', () => {
    expect(workspaceOverrideKey('/home/me/project/')).toBe(workspaceOverrideKey('/home/me/project'))
  })

  it('finds nothing for a project that has said nothing', () => {
    expect(overridesFor({}, '/home/me/other')).toBeUndefined()
    expect(overridesFor(undefined, '/home/me/other')).toBeUndefined()
    expect(overridesFor({ '/a': {} } as Record<string, WorkspaceOverrides>, undefined)).toBeUndefined()
  })
})

describe('telling the user what this project has changed', () => {
  it('lists only what was actually overridden', () => {
    expect(describeOverrides({ activeVectorStoreId: 'x', modeId: 'junior' } as WorkspaceOverrides)).toEqual([
      'activeVectorStoreId',
      'modeId',
    ])
    expect(describeOverrides(undefined)).toEqual([])
  })
})
