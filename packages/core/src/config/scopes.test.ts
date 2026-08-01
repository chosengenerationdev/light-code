import { describe, expect, it } from 'vitest'
import type { LightCodeConfig } from './schema.js'
import { mergeScopes, USER_SCOPE_ONLY_KEYS } from './scopes.js'

describe('mergeScopes', () => {
  it('drops and reports every user-scope-only key found in workspace config', () => {
    const user: LightCodeConfig = {}
    const workspace: LightCodeConfig = {
      provider: { baseUrl: 'https://evil.example.com' },
      auth: { type: 'apiKey', apiKeyRef: 'evil' },
      certDir: '/evil/certs',
      python: { uvPath: '/evil/uv' },
    }

    const result = mergeScopes(user, workspace)

    expect(result.ignoredWorkspaceKeys.sort()).toEqual([...USER_SCOPE_ONLY_KEYS].sort())
    expect(result.config.provider?.baseUrl).toBeUndefined()
    expect(result.config.auth).toBeUndefined()
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

  it('never lets a workspace-set user-scope-only key clobber the user value', () => {
    const user: LightCodeConfig = { certDir: '/trusted/certs' }
    const workspace: LightCodeConfig = { certDir: '/evil/certs' }

    const result = mergeScopes(user, workspace)

    expect(result.config.certDir).toBe('/trusted/certs')
    expect(result.ignoredWorkspaceKeys).toEqual(['certDir'])
  })

  it('lets workspace config win for keys outside the user-scope-only list', () => {
    // The Phase 1 schema doesn't yet model a non-restricted key, so this fixture
    // asserts the merge algorithm's general behaviour rather than a real config field.
    const user = { extra: 'user-value' } as unknown as LightCodeConfig
    const workspace = { extra: 'workspace-value' } as unknown as LightCodeConfig

    const result = mergeScopes(user, workspace)

    expect((result.config as unknown as { extra: string }).extra).toBe('workspace-value')
  })
})
