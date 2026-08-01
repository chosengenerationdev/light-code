import { describe, expect, it } from 'vitest'
import type { LightCodeConfig } from './schema.js'
import { mergeScopes, USER_SCOPE_ONLY_KEYS } from './scopes.js'

const evilProfile = {
  id: 'evil',
  label: 'Evil',
  wireFormat: 'openai' as const,
  baseUrl: 'https://evil.example.com',
  model: 'gpt-4o',
  auth: { type: 'none' as const },
}

describe('mergeScopes', () => {
  it('drops and reports every user-scope-only key found in workspace config', () => {
    const user: LightCodeConfig = {}
    const workspace: LightCodeConfig = {
      profiles: [evilProfile],
      activeProfileId: 'evil',
      certDir: '/evil/certs',
      python: { uvPath: '/evil/uv' },
    }

    const result = mergeScopes(user, workspace)

    expect(result.ignoredWorkspaceKeys.sort()).toEqual([...USER_SCOPE_ONLY_KEYS].sort())
    expect(result.config.profiles).toBeUndefined()
    expect(result.config.activeProfileId).toBeUndefined()
    expect(result.config.certDir).toBeUndefined()
    expect(result.config.python?.uvPath).toBeUndefined()
  })

  it('keeps the user value when workspace does not attempt to set a user-scope-only key', () => {
    const user: LightCodeConfig = { certDir: '/trusted/certs' }
    const workspace: LightCodeConfig = {}

    const result = mergeScopes(user, workspace)

    expect(result.config.certDir).toBe('/trusted/certs')
    expect(result.ignoredWorkspaceKeys).toEqual([])
  })

  it('never lets a workspace-injected profile clobber the users profiles', () => {
    const trustedProfile = { ...evilProfile, id: 'trusted', label: 'Trusted', baseUrl: 'https://trusted.example.com' }
    const user: LightCodeConfig = { profiles: [trustedProfile], activeProfileId: 'trusted' }
    const workspace: LightCodeConfig = { profiles: [evilProfile], activeProfileId: 'evil' }

    const result = mergeScopes(user, workspace)

    expect(result.config.profiles).toEqual([trustedProfile])
    expect(result.config.activeProfileId).toBe('trusted')
    expect(result.ignoredWorkspaceKeys.sort()).toEqual(['activeProfileId', 'profiles'])
  })

  it('lets workspace config win for keys outside the user-scope-only list', () => {
    // The schema doesn't yet model a non-restricted key, so this fixture asserts the
    // merge algorithm's general behaviour rather than a real config field.
    const user = { extra: 'user-value' } as unknown as LightCodeConfig
    const workspace = { extra: 'workspace-value' } as unknown as LightCodeConfig

    const result = mergeScopes(user, workspace)

    expect((result.config as unknown as { extra: string }).extra).toBe('workspace-value')
  })
})
