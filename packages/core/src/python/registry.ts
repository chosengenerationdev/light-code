import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Logger } from '../logging/logger.js'
import type { PythonWorker, WorkerToolDescription } from './worker.js'

/**
 * Discovery and hash-pinning for model-authored Python tools.
 *
 * Everything else in Light Code gates *calling* a tool. This gates the **body**: the code is
 * model-authored, so an injected instruction could otherwise create a persistent code path
 * that is approved once and auto-approved forever after (§13).
 *
 * The pin is what closes that. Approval records a hash of the exact source that was shown;
 * a file whose hash no longer matches is refused and reported, never silently loaded. That
 * covers both an edit made outside Light Code and a second write the user never saw.
 *
 * `.registry.json` is a **generated cache, never hand-edited** — the file on disk is the
 * source of truth. It exists so a session start does not have to import every tool to learn
 * its schema.
 */

export const REGISTRY_FILE = '.registry.json'
/** Namespaces every Python tool, exactly as MCP tools are namespaced (§11). */
export const PYTHON_TOOL_PREFIX = 'py__'

export interface RegisteredTool {
  name: string
  description: string
  schema: Record<string, unknown>
  /** sha256 of the file the user approved. */
  hash: string
  /** Absolute path. Derived from the tools directory and never stored. */
  filePath: string
}

export interface RegistryFile {
  version: 1
  tools: Record<string, { description: string; schema: Record<string, unknown>; hash: string }>
}

export type ToolLoadIssue =
  | { kind: 'hash-mismatch'; name: string; filePath: string; expected: string; actual: string }
  | { kind: 'unapproved'; name: string; filePath: string }
  | { kind: 'invalid'; name: string; filePath: string; detail: string }

export interface LoadedRegistry {
  tools: RegisteredTool[]
  /**
   * Surfaced rather than logged. A refused tool is either an attack or a mistake, and both
   * need saying out loud — silently offering fewer tools than the user expects is the one
   * outcome that teaches nobody anything.
   */
  issues: ToolLoadIssue[]
}

export function hashSource(source: string): string {
  // Line endings normalised: a CRLF checkout must not invalidate every approval (§16).
  return crypto.createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex')
}

/** A tool name safe to namespace, address and put in a filename. */
export function isValidToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(name)
}

export function toolFileName(name: string): string {
  return `${name}.py`
}

async function readRegistryFile(toolsDir: string): Promise<RegistryFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(toolsDir, REGISTRY_FILE), 'utf8')) as RegistryFile
    if (parsed.version === 1 && typeof parsed.tools === 'object') return parsed
  } catch {
    // Missing or unparseable both mean "nothing is approved yet", which is the safe reading:
    // every tool then needs re-approving rather than loading unchecked.
  }
  return { version: 1, tools: {} }
}

export async function writeRegistryFile(toolsDir: string, registry: RegistryFile): Promise<void> {
  await fs.mkdir(toolsDir, { recursive: true })
  await fs.writeFile(path.join(toolsDir, REGISTRY_FILE), JSON.stringify(registry, null, 2), 'utf8')
}

/**
 * Loads every approved tool whose source still matches its recorded hash.
 *
 * A `.py` file with no registry entry is **not** loaded. Dropping a file into the tools
 * directory must not be enough to get it executed — approval is what registers a tool, and
 * the directory is inside the workspace, so a cloned repo could otherwise ship one.
 */
export async function loadRegistry(
  toolsDir: string,
  worker: PythonWorker | undefined,
  logger: Logger,
): Promise<LoadedRegistry> {
  const registry = await readRegistryFile(toolsDir)
  const tools: RegisteredTool[] = []
  const issues: ToolLoadIssue[] = []

  let entries: string[]
  try {
    entries = (await fs.readdir(toolsDir)).filter((file) => file.endsWith('.py'))
  } catch {
    return { tools, issues }
  }

  for (const file of entries) {
    const name = path.basename(file, '.py')
    const filePath = path.join(toolsDir, file)
    if (!isValidToolName(name)) {
      issues.push({ kind: 'invalid', name, filePath, detail: 'Not a valid tool name.' })
      continue
    }

    const approved = registry.tools[name]
    if (approved === undefined) {
      issues.push({ kind: 'unapproved', name, filePath })
      continue
    }

    let source: string
    try {
      source = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      issues.push({ kind: 'invalid', name, filePath, detail: String(error) })
      continue
    }

    const actual = hashSource(source)
    if (actual !== approved.hash) {
      // Loudly refused, never quietly reloaded. This is the case the pin exists for.
      issues.push({ kind: 'hash-mismatch', name, filePath, expected: approved.hash, actual })
      logger.warn(`python tool "${name}" changed since it was approved; refusing to load it`)
      continue
    }

    tools.push({ name, description: approved.description, schema: approved.schema, hash: actual, filePath })
  }

  // Only consulted to refresh a description; the cache is authoritative for what may load.
  if (worker !== undefined) {
    for (const tool of tools) {
      if (tool.description.length > 0) continue
      try {
        const described: WorkerToolDescription = await worker.describe(tool.name, tool.filePath)
        tool.description = described.description
        tool.schema = described.schema
      } catch (error) {
        logger.debug(`could not describe python tool "${tool.name}"`, String(error))
      }
    }
  }

  return { tools, issues }
}

/** Records an approval: the hash here is the source the user was actually shown. */
export async function approveTool(
  toolsDir: string,
  name: string,
  source: string,
  described: WorkerToolDescription,
): Promise<void> {
  const registry = await readRegistryFile(toolsDir)
  registry.tools[name] = {
    description: described.description,
    schema: described.schema,
    hash: hashSource(source),
  }
  await writeRegistryFile(toolsDir, registry)
}

export async function forgetTool(toolsDir: string, name: string): Promise<void> {
  const registry = await readRegistryFile(toolsDir)
  delete registry.tools[name]
  await writeRegistryFile(toolsDir, registry)
}

/** Human-readable, for the UI and for the model when a tool it expected is absent. */
export function describeIssue(issue: ToolLoadIssue): string {
  switch (issue.kind) {
    case 'hash-mismatch':
      return `"${issue.name}" has changed since it was approved and was not loaded. Review the file and approve it again.`
    case 'unapproved':
      return `"${issue.name}" is not approved and was not loaded. A .py file appearing on disk is never enough to run it.`
    case 'invalid':
      return `"${issue.name}" could not be loaded: ${issue.detail}`
  }
}
