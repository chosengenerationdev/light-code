import { describe, expect, it } from 'vitest'
import type { LightCodeConfig } from '../config/schema.js'
import { NoActiveProfileError, ProfileNotFoundError, resolveActiveProfile } from './registry.js'
import type { ProviderProfile } from './types.js'

function profile(id: string): ProviderProfile {
  return {
    id,
    label: id,
    wireFormat: 'openai',
    baseUrl: 'https://example.com',
    model: 'gpt-4o',
    auth: { type: 'none' },
  }
}

describe('resolveActiveProfile', () => {
  it('throws NoActiveProfileError when no profiles are configured', () => {
    expect(() => resolveActiveProfile({})).toThrow(NoActiveProfileError)
  })

  it('falls back to the first profile when activeProfileId is not set', () => {
    const config: LightCodeConfig = { profiles: [profile('a'), profile('b')] }
    expect(resolveActiveProfile(config).id).toBe('a')
  })

  it('resolves the profile matching activeProfileId', () => {
    const config: LightCodeConfig = { profiles: [profile('a'), profile('b')], activeProfileId: 'b' }
    expect(resolveActiveProfile(config).id).toBe('b')
  })

  it('throws ProfileNotFoundError when activeProfileId matches nothing', () => {
    const config: LightCodeConfig = { profiles: [profile('a')], activeProfileId: 'missing' }
    expect(() => resolveActiveProfile(config)).toThrow(ProfileNotFoundError)
  })
})
