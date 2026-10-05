import fs from 'node:fs/promises'
import type { SecretStore } from '../platform/secrets.js'
import { credentialPointer, type CredentialSummary } from '../secrets/credentials.js'
import { declaredCredentials } from './declaredCredentials.js'
import { hashSource } from './registry.js'

export { declaredCredentials }

/**
 * `light_code.credential("Corp LDAP")`: a Python tool reading one of Fire Code's saved credentials.
 *
 * Safer than an environment variable on every count that matters:
 *
 * - **Only what the tool declares.** The tool lists the credentials it uses in its own source,
 *   `__credentials__ = ["Corp LDAP"]`. That line is part of the code you approved - the review
 *   shows it - and the approval is pinned to the file's hash, so asking for one more credential
 *   means approving the tool again. A variable is visible to every tool and every command.
 * - **Only the tool that asked, as approved.** The caller must be a loaded tool whose file still
 *   matches the approved hash at the moment of asking.
 * - **Never shown to the model.** Values handed out are blanked from the tool's result, its printed
 *   output and any traceback before they reach the conversation (`PythonManager`).
 *
 * What it cannot do, and the handbook says so: an approved tool that sends the value somewhere
 * else is doing what its code says. Reviewing the code is what guards against that.
 */

export async function readToolCredential(options: {
  name: string
  caller: string
  /** The loaded tool by name: where its file is and the hash it was approved at. */
  findTool: (name: string) => { filePath: string; hash: string } | undefined
  credentials: () => Promise<readonly CredentialSummary[]>
  secrets: SecretStore
}): Promise<string | { username: string; password: string }> {
  const { name, caller } = options
  const tool = caller.length > 0 ? options.findTool(caller) : undefined
  if (tool === undefined) throw new Error('Only an approved Python tool can read a saved credential.')

  let source: string
  try {
    source = await fs.readFile(tool.filePath, 'utf8')
  } catch {
    throw new Error(`${caller} could not be read back to check what it declares.`)
  }
  if (hashSource(source) !== tool.hash) {
    throw new Error(`${caller} changed since it was approved, so it gets no credentials until it is approved again.`)
  }
  const declared = declaredCredentials(source)
  if (!declared.some((d) => d.toLowerCase() === name.trim().toLowerCase())) {
    throw new Error(
      `${caller} did not declare "${name}". Add it to the tool's __credentials__ list ` +
        `(e.g. __credentials__ = [${[...declared, name].map((d) => JSON.stringify(d)).join(', ')}]); ` +
        'the tool then needs approving again, which shows the user what it asks for.',
    )
  }

  const saved = (await options.credentials()).find((c) => c.label.toLowerCase() === name.trim().toLowerCase())
  if (saved === undefined) {
    throw new Error(`There is no saved credential called "${name}". Add it on Fire Code's Credentials page (the key button).`)
  }
  const read = async (field: string): Promise<string> => {
    const value = await options.secrets.get(credentialPointer(saved.id, field))
    if (value === undefined || value.length === 0) throw new Error(`The saved credential "${saved.label}" has no ${field} stored.`)
    return value
  }
  if (saved.kind === 'login') return { username: await read('username'), password: await read('password') }
  return read('value')
}
