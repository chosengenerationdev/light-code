import type { Skill } from '../skills/index.js'
import type { Tool } from '../tools/types.js'

/**
 * Tells the expert what the junior can do — and, just as importantly, what the expert cannot.
 *
 * ## Why this is needed at all
 *
 * The expert is a separate Claude CLI process holding only `Read`, `Grep` and `Glob`. It
 * cannot call an MCP tool, a Python tool or `search_docs`; it cannot run a command; it has no
 * way to discover that any of those exist. Left uninformed it plans as though the junior were
 * a bare shell — recommending that a file be edited by hand when a configured tool already
 * does it, or inventing a procedure for something an existing skill documents.
 *
 * ## Names, never schemas
 *
 * Forty MCP tools cost a few hundred tokens as a list and several thousand as JSON schemas,
 * and the expert does not need a schema to *choose* a tool. When it needs exact parameters it
 * asks the junior to look them up. That is the same name-first, body-on-demand split §13
 * already makes for skills, applied to the expert's context instead of the prompt's.
 *
 * Descriptions are clipped for the same reason: an MCP server's description can run to a
 * paragraph, and the first line is what distinguishes it from its neighbours.
 */

/** Long enough to tell two tools apart, short enough that forty of them stay cheap. */
const DESCRIPTION_LIMIT = 110

function firstLine(text: string, limit = DESCRIPTION_LIMIT): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0)?.trim() ?? ''
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line
}

export interface BriefingInput {
  /** Tools advertised to the junior in its prompt. */
  promptTools: readonly Tool[]
  /**
   * Tools reachable only through `call_tool` after a `search_docs` lookup. Listed the same
   * way — from the expert's side the distinction does not matter, since it instructs rather
   * than calls.
   */
  dispatchOnlyTools?: readonly Tool[]
  skills?: readonly Skill[]
  /** True when `search_docs` is available, so the expert can ask for a schema by name. */
  retrievalAvailable?: boolean
}

export function buildExpertBriefing(input: BriefingInput): string {
  const sections: string[] = [
    '## Context: you are advising a junior model',
    '',
    'A cheaper model is doing the work in a VS Code workspace and has consulted you. It carries',
    'out everything: reading, editing, running commands, and calling the tools below.',
    '',
    'You are read-only here. You have Read, Grep and Glob; you cannot run commands, edit files,',
    'or call any of the tools listed below. To use one of them, tell the junior to.',
    '',
    'So: give concrete instructions naming the tools it should use, and if you need to know',
    'something only the workspace can tell you, either read it yourself or ask the junior.',
  ]

  const listed = (tools: readonly Tool[]): string[] =>
    [...tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => `- ${tool.name} — ${firstLine(tool.description)}`)

  const dispatchOnly = input.dispatchOnlyTools ?? []
  const everyTool = [...input.promptTools, ...dispatchOnly]

  if (everyTool.length > 0) {
    sections.push('', `### Tools the junior can call (${everyTool.length})`, '')
    sections.push(...listed(everyTool))
    sections.push(
      '',
      // The single most useful thing to tell it, since guessing a schema wastes a whole
      // round trip and produces arguments the tool rejects.
      'These are names and summaries, not full signatures. **Do not guess a tool’s parameters.**',
      input.retrievalAvailable === true
        ? 'If you need the exact arguments for one, ask the junior to run `search_docs` for it and report back — that is cheap for it and it will continue this same conversation.'
        : 'If you need the exact arguments for one, ask the junior to tell you before it calls the tool.',
    )
  }

  const skills = input.skills ?? []
  if (skills.length > 0) {
    sections.push('', `### Project knowledge written down for the junior (${skills.length})`, '')
    sections.push(...skills.map((skill) => `- ${skill.name} — ${firstLine(skill.description)}`))
    sections.push(
      '',
      'Only the summaries are here. Ask the junior to read the full text of any that looks',
      'relevant — these describe how this particular team does things, and they override your',
      'general knowledge where the two disagree.',
    )
  }

  return sections.join('\n')
}
