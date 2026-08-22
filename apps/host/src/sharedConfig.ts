import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { providerProfileSchema, sessionVariablesSchema, type ProviderProfile, type SessionVariable } from '@light-code/core'

/**
 * Settings an administrator sets once, for everyone.
 *
 * Separate from every user's own config file, and deliberately not a scope of it. `ConfigManager`
 * merges user and workspace scopes and drops workspace values for the keys invariant 5 protects —
 * a third scope threaded through that would put "which of three files won" into a merge that
 * already carries a security rule, and the answer would be hard to see at the point it mattered.
 *
 * So this is a small store of its own, read by the server and applied where it belongs. Today
 * that is session variables; H3's shared provider defaults will live here too.
 */
export interface SharedConfig {
  /** Applied to every user's session, overriding their own of the same name. */
  variables: SessionVariable[]
  /**
   * Provider profiles offered to everyone.
   *
   * Merged into each user's list, read-only to them, with ids prefixed in that view so the two
   * halves can never be confused — see `sharedProfiles.ts`. Users add their own alongside these.
   */
  profiles: ProviderProfile[]
  /** Used by anyone who has not chosen a profile, which is every new user. */
  defaultProfileId?: string
  /**
   * Identity ids treated as administrators.
   *
   * Seeded from `--admin-id` and editable in the admin interface, so adding a colleague does not
   * mean restarting the server. The command line still wins on start: an operator locked out of
   * their own deployment needs a way back in that does not require the interface they cannot
   * reach.
   */
  adminIds: string[]
}

const EMPTY: SharedConfig = { variables: [], adminIds: [], profiles: [] }

export class SharedConfigStore {
  private cache: SharedConfig | undefined

  constructor(private readonly filePath: string) {}

  async load(): Promise<SharedConfig> {
    if (this.cache !== undefined) return this.cache
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Record<string, unknown>
      /*
       * Parsed field by field rather than all-or-nothing. A hand-edited file with one bad entry
       * should cost that entry, not every administrator's id — being locked out of the admin
       * interface by a typo in an unrelated list is a bad failure to design in.
       */
      const variables = sessionVariablesSchema.safeParse(raw['variables'])
      const adminIds = Array.isArray(raw['adminIds'])
        ? raw['adminIds'].filter((id): id is string => typeof id === 'string')
        : []
      /*
        * Profiles are validated as a whole rather than entry by entry: a half-valid profile is a
        * gateway with no credentials or a credential with no gateway, and offering it to every
        * user would produce a failure that looks like an outage.
        */
      const profiles = z.array(providerProfileSchema).safeParse(raw['profiles'])
      const defaultProfileId = typeof raw['defaultProfileId'] === 'string' ? raw['defaultProfileId'] : undefined
      this.cache = {
        variables: variables.success ? variables.data : [],
        adminIds,
        profiles: profiles.success ? profiles.data : [],
        ...(defaultProfileId !== undefined ? { defaultProfileId } : {}),
      }
    } catch {
      // Absent is the normal case on a first run, and unreadable is not worth failing to start
      // over — an administrator can set it again through the interface.
      this.cache = { ...EMPTY }
    }
    return this.cache
  }

  async save(next: Partial<SharedConfig>): Promise<SharedConfig> {
    const current = await this.load()
    const merged: SharedConfig = { ...current, ...next }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    // Written whole and atomically enough for a file this size: a torn write here would lose the
    // administrator list, and rewriting it is the one thing they may be unable to do.
    const temporary = `${this.filePath}.tmp`
    await fs.writeFile(temporary, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, this.filePath)
    this.cache = merged
    return merged
  }
}
