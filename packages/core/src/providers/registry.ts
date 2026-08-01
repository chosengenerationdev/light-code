import type { LightCodeConfig } from '../config/schema.js'
import type { ProviderProfile } from './types.js'

export class NoActiveProfileError extends Error {
  constructor() {
    super('No provider profile is configured yet. Add one to your config and set it active.')
    this.name = 'NoActiveProfileError'
  }
}

export class ProfileNotFoundError extends Error {
  constructor(readonly activeProfileId: string) {
    super(`activeProfileId "${activeProfileId}" does not match any configured profile.`)
    this.name = 'ProfileNotFoundError'
  }
}

/**
 * Resolves the active profile from config. Falls back to the first configured profile
 * if none is explicitly marked active — a reasonable default while there's only one.
 */
export function resolveActiveProfile(config: LightCodeConfig): ProviderProfile {
  const profiles = config.profiles ?? []
  if (profiles.length === 0) {
    throw new NoActiveProfileError()
  }

  if (config.activeProfileId === undefined) {
    return profiles[0] as ProviderProfile
  }

  const found = profiles.find((profile) => profile.id === config.activeProfileId)
  if (found === undefined) {
    throw new ProfileNotFoundError(config.activeProfileId)
  }
  return found
}
