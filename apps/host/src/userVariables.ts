import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sessionVariablesSchema, type SessionVariable } from '@light-code/core'
import { storageKeyFor, type Principal } from './identity.js'

/**
 * A user's own session variables, in a file of their own.
 *
 * ## Not in `config.json`, and this is not a preference
 *
 * `configSchema` is a zod object, so it **strips keys it does not know**. Variables kept there
 * survive until the first time anything saves config — changing mode, picking an accent colour —
 * and then vanish, with no error and nothing to point at. Verified directly: parsing a config
 * containing `variables` returns `undefined` for it.
 *
 * Adding them to the schema was the alternative, and it would put a Node-host concept into the
 * extension's config for no benefit there. A separate file keeps the feature where it belongs and
 * removes the failure mode entirely rather than working around it.
 */
export class UserVariableStore {
  constructor(private readonly filePath: string) {}

  /**
   * Synchronous, because it is read on the path that builds a command's environment and an
   * `await` there would make every tool call wait on a file. It is a few hundred bytes.
   */
  read(): readonly SessionVariable[] {
    return readVariablesFile(this.filePath)
  }

  async save(variables: readonly SessionVariable[]): Promise<readonly SessionVariable[]> {
    const parsed = sessionVariablesSchema.parse(variables)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    // Temp-and-rename, as the task store does: an interrupted write must not leave a truncated
    // file where a good one was.
    const temporary = `${this.filePath}.tmp`
    await fs.writeFile(temporary, JSON.stringify({ variables: parsed }, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    await fs.rename(temporary, this.filePath)
    return parsed
  }
}

/**
 * The store for one principal, built from the data directory.
 *
 * Derives the same per-user path `createSession` uses, so the server and the session it starts
 * cannot disagree about where a user's variables are — two ways of computing one path is how
 * they end up pointing at different files.
 */
export function userVariableStoreFor(dataDir: string, principal: Principal): UserVariableStore {
  return new UserVariableStore(userVariablesPath(path.join(dataDir, 'users', storageKeyFor(principal))))
}

/** Where a user's variables live, beside their config rather than inside it. */
export function userVariablesPath(userDir: string): string {
  return path.join(userDir, 'variables.json')
}

/**
 * Exported so tests exercise the shipped read rather than a copy of it.
 *
 * Any failure yields none, which is what an empty list already means — so a hand-edited file with
 * a mistake in it costs the variables and never the session.
 */
export function readVariablesFile(filePath: string): readonly SessionVariable[] {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    const parsed = sessionVariablesSchema.safeParse(raw['variables'])
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}
