import { CONTINUE_PROMPT } from './unfinished.js'
import { isObserverNote } from '../observers/events.js'
import type { ChatMessage } from '../providers/types.js'

/**
 * Starting a new chat from where this one is, with a clean handoff instead of a compacted history.
 *
 * Asked for: compaction "dilutes the chat", so a button that has the agent write a handoff and opens a new
 * chat with it - all the key information, nothing of the noise. Two halves, kept apart on purpose:
 *
 * - **Facts read straight from the conversation**: every message the user typed, verbatim, and the files
 *   read, files changed and commands run, from the actual tool calls. These are not left to the model's
 *   memory, because a summary is exactly where a file name or a requirement quietly goes missing.
 * - **The model's handoff note**: the goal, what is done and decided, what is left, open questions and the
 *   next step - the judgement a list of facts cannot carry.
 */

export interface HandoffFacts {
  userMessages: string[]
  filesRead: string[]
  filesChanged: string[]
  commands: string[]
}

const READ_TOOLS = new Set(['read_file', 'read_many_files', 'big_file'])
const WRITE_TOOLS = new Set(['write_to_file', 'apply_diff', 'use_skill_file'])
const COMMAND_TOOLS = new Set(['execute_command'])

function argumentsOf(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A tool reached through `call_tool` is counted as itself. */
function unwrap(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  if (name !== 'call_tool' || typeof args['name'] !== 'string') return { name, args }
  const inner = args['arguments']
  return { name: args['name'], args: inner !== null && typeof inner === 'object' ? (inner as Record<string, unknown>) : {} }
}

/** What the conversation shows for certain, in the order it happened, each once. */
export function handoffFacts(messages: readonly ChatMessage[]): HandoffFacts {
  const facts: HandoffFacts = { userMessages: [], filesRead: [], filesChanged: [], commands: [] }
  const add = (list: string[], value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0 && !list.includes(value.trim())) list.push(value.trim())
  }
  for (const message of messages) {
    if (message.role === 'user') {
      // The loop's own "continue" nudge is user-role, but nobody typed it.
      // Nor did anybody type a reviewer's note.
      if (message.content.trim() !== CONTINUE_PROMPT.trim() && message.content.trim().length > 0 && !isObserverNote(message.content)) facts.userMessages.push(message.content.trim())
      continue
    }
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls ?? []) {
      const { name, args } = unwrap(call.name, argumentsOf(call.arguments))
      if (READ_TOOLS.has(name)) {
        add(facts.filesRead, args['path'])
        // read_many_files: `files: [{ path }]`.
        if (Array.isArray(args['files'])) for (const f of args['files']) add(facts.filesRead, (f as { path?: unknown } | null)?.path)
      } else if (WRITE_TOOLS.has(name)) {
        add(facts.filesChanged, args['path'] ?? args['destination'])
      } else if (COMMAND_TOOLS.has(name)) {
        add(facts.commands, args['command'])
      }
    }
  }
  return facts
}

/** One tool result, shortened: the note needs what happened, not the whole output. */
const RESULT_CHARS = 1_500

/**
 * The conversation as plain text for the model to read, within `maxChars`. When it is too long the start
 * (where the goal usually is) and as much of the end as fits are kept, and the middle is marked as cut.
 */
export function handoffTranscript(messages: readonly ChatMessage[], maxChars: number): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') parts.push(`USER:\n${message.content}`)
    else if (message.role === 'assistant') {
      const calls = (message.toolCalls ?? []).map((call) => `[tool ${call.name} ${call.arguments.length > 400 ? `${call.arguments.slice(0, 400)}…` : call.arguments}]`)
      parts.push(`ASSISTANT:\n${[message.content, ...calls].filter((part) => part.trim().length > 0).join('\n')}`)
    } else {
      const content = message.content.length > RESULT_CHARS ? `${message.content.slice(0, RESULT_CHARS)}\n… (${String(message.content.length - RESULT_CHARS)} more characters)` : message.content
      parts.push(`TOOL RESULT:\n${content}`)
    }
  }
  const whole = parts.join('\n\n')
  if (whole.length <= maxChars) return whole
  const head = Math.floor(maxChars * 0.25)
  const tail = maxChars - head
  return `${whole.slice(0, head)}\n\n… [the middle of the conversation is cut here to fit] …\n\n${whole.slice(whole.length - tail)}`
}

export const HANDOFF_PROMPT = [
  'You are handing this work over to a fresh chat, which will start with only what you write now.',
  'Write a handoff note in Markdown that lets someone continue without the conversation. Use these sections:',
  '## Goal - what the user is trying to achieve, in their terms.',
  '## Done so far - what has been completed, and how it was verified.',
  '## Decisions and constraints - choices made and why, rules the user set, approaches ruled out.',
  '## Current state - where things stand right now: what works, what is broken, what is half-done.',
  '## Open questions - anything unresolved or waiting on the user.',
  '## Next steps - the concrete next actions, in order.',
  'Name files, functions, commands, settings and error messages exactly. Keep it dense - no pleasantries,',
  'no restating these instructions. The user\'s own messages and the files and commands are attached',
  'separately, verbatim, so do not copy them out; refer to them where it helps.',
].join('\n')

const MAX_QUOTED_MESSAGE = 4_000
const MAX_QUOTED_TOTAL = 24_000

/** The first message of the new chat: the note, then the facts, so the next model reads both. */
export function composeHandoff(note: string, facts: HandoffFacts, previousTitle: string | undefined): string {
  const lines: string[] = [`# Handoff${previousTitle !== undefined ? `: ${previousTitle}` : ''}`, '', 'This chat continues an earlier one. Pick up from here.', '', note.trim()]
  if (facts.userMessages.length > 0) {
    lines.push('', '## What the user asked for, in their words')
    // Newest kept when they do not all fit: the latest requests are the ones still in force.
    const kept: string[] = []
    let total = 0
    for (const text of [...facts.userMessages].reverse()) {
      const clipped = text.length > MAX_QUOTED_MESSAGE ? `${text.slice(0, MAX_QUOTED_MESSAGE)}…` : text
      if (total + clipped.length > MAX_QUOTED_TOTAL) break
      kept.unshift(clipped)
      total += clipped.length
    }
    if (kept.length < facts.userMessages.length) lines.push(`(${String(facts.userMessages.length - kept.length)} earlier messages left out to keep this short.)`)
    for (const text of kept) lines.push('', ...text.split('\n').map((line) => `> ${line}`))
  }
  const list = (title: string, items: readonly string[], code: boolean): void => {
    if (items.length === 0) return
    lines.push('', `## ${title}`, ...items.map((item) => `- ${code ? `\`${item.replace(/`/g, "'")}\`` : item}`))
  }
  list('Files changed', facts.filesChanged, true)
  list('Files read', facts.filesRead, true)
  list('Commands run', facts.commands, true)
  return lines.join('\n')
}
