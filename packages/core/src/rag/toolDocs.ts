import { toJSONSchema } from 'zod'
import type { Skill } from '../skills/index.js'
import type { Tool } from '../tools/types.js'

/**
 * The corpus behind `search_docs`: one document per hidden tool, plus one per skill.
 *
 * ## The index finds things; it is never the source of truth
 *
 * A document here carries a tool's name and prose so a semantic query can *reach* it. It
 * deliberately does **not** get trusted for the tool's schema at call time — `search_docs`
 * renders that from the live registry instead. An index is a snapshot: a server that
 * restarts with a changed signature, or a workspace indexed last week, would otherwise feed
 * the model a schema that no longer matches and produce argument errors pointing nowhere
 * near the real cause. Same principle as invariant 8 — show ground truth, not a description
 * of it.
 *
 * That split is also what lets `search_docs` degrade to a lexical scan of the registry when
 * no vector store is configured. Without it, turning the dispatcher on without an index
 * would make every hidden tool unreachable.
 *
 * ## Shape
 *
 * These reuse `VectorDocument`, so they share the one mapping, the one writer and every
 * backend adapter. `path` carries a `tool:`/`skill:` qualified id rather than a file path —
 * a small stretch of the field name, taken deliberately in exchange for not maintaining a
 * second collection shape across three backends. Line numbers are 1/1 and unused.
 */

export type DocEntryKind = 'tool' | 'skill'

export interface DocEntry {
  kind: DocEntryKind
  /** Tool name, or skill name. Unique within its kind. */
  name: string
  /** `tool:name` / `skill:name`. The stored `path`, and how a hit is resolved back. */
  id: string
  /** What gets embedded and matched against. */
  text: string
}

/** `tool:s3__get_object` — qualified so a tool and a skill may share a name. */
export function docEntryId(kind: DocEntryKind, name: string): string {
  return `${kind}:${name}`
}

/** Splits an id back into its parts, or undefined if it is not one of ours. */
export function parseDocEntryId(id: string): { kind: DocEntryKind; name: string } | undefined {
  const separator = id.indexOf(':')
  if (separator < 0) return undefined
  const kind = id.slice(0, separator)
  const name = id.slice(separator + 1)
  if (name.length === 0) return undefined
  if (kind !== 'tool' && kind !== 'skill') return undefined
  return { kind, name }
}

/** The JSON Schema a caller must satisfy. An MCP server's own schema wins over a zod round-trip. */
export function schemaForTool(tool: Tool): unknown {
  return tool.rawJsonSchema ?? toJSONSchema(tool.parametersSchema)
}

/**
 * The embeddable text for a tool.
 *
 * The name is repeated and split on separators because a query is written in prose —
 * "read a file from the bucket" has to reach `s3__get_object`, and the underscored,
 * namespaced identifier embeds poorly on its own.
 */
export function toolDocText(tool: Tool): string {
  const words = tool.name.replace(/__/g, ' ').replace(/[_-]+/g, ' ')
  return [
    `Tool: ${tool.name}`,
    `Also known as: ${words}`,
    `Group: ${tool.group}`,
    '',
    tool.description,
    '',
    'Parameters (JSON Schema):',
    JSON.stringify(schemaForTool(tool), null, 2),
  ].join('\n')
}

export function skillDocText(skill: Skill, body?: string): string {
  return [
    `Skill: ${skill.name}`,
    `Also known as: ${skill.name.replace(/[_-]+/g, ' ')}`,
    '',
    skill.description,
    '',
    `Full text: ${skill.filePath}`,
    ...(body !== undefined && body.length > 0 ? ['', body] : []),
  ].join('\n')
}

export function toolDocEntry(tool: Tool): DocEntry {
  return { kind: 'tool', name: tool.name, id: docEntryId('tool', tool.name), text: toolDocText(tool) }
}

export function skillDocEntry(skill: Skill, body?: string): DocEntry {
  return { kind: 'skill', name: skill.name, id: docEntryId('skill', skill.name), text: skillDocText(skill, body) }
}

/**
 * Everything worth indexing for this workspace.
 *
 * Only *dispatch-only* tools are included. A tool already in the prompt needs no retrieval —
 * indexing it would spend embeddings to tell the model something it can already read, and
 * put a second, staler copy of its schema into play.
 */
export function buildDocCorpus(options: {
  dispatchOnlyTools: readonly Tool[]
  skills?: readonly Skill[]
  skillBodies?: ReadonlyMap<string, string>
}): DocEntry[] {
  const entries = options.dispatchOnlyTools.map(toolDocEntry)
  for (const skill of options.skills ?? []) {
    entries.push(skillDocEntry(skill, options.skillBodies?.get(skill.name)))
  }
  // Sorted so a re-index with no changes produces an identical document order, which keeps
  // the manifest's content hashes stable.
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}
