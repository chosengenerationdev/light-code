import { z } from 'zod'
import type { Tool, ToolExecutionContext, ToolResult } from './types.js'

/**
 * A typed field in a form the assistant shows the user.
 *
 * Kept to five types deliberately. Each maps to one control the user already recognises, and
 * anything beyond them — dates, files, nested groups — is a widget to design, a validation
 * rule to agree and a shape for the model to get wrong. A skill that needs a date can ask for
 * a string and say what format it wants.
 *
 * `list` is the one that is not a control of its own: it is a text box whose answer is split on
 * commas into an array. It exists because "give me the trade ids" is a real and frequent shape,
 * and the alternatives are both worse — a `string` the assistant has to split itself, guessing
 * at the separator, or twenty fields for twenty values.
 */
export const formFieldSchema = z.object({
  /** The key this field's answer appears under. */
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'A field name must start with a letter and contain no spaces.'),
  label: z.string().min(1).describe('Shown beside the control. Write it as a question or a noun phrase.'),
  type: z.enum(['string', 'number', 'boolean', 'choice', 'list']),
  description: z.string().optional().describe('One line under the label, for anything the label cannot carry.'),
  /**
   * Choices, required for `choice` and meaningless elsewhere.
   *
   * A value may differ from what is shown, so a form can offer readable labels while the
   * answer stays something the assistant can act on.
   */
  options: z.array(z.object({ value: z.string(), label: z.string().optional() })).optional(),
  required: z.boolean().optional().describe('Defaults to true. A required field blocks submission until answered.'),
  /** Prefills the control. A good default is the difference between a form and an interrogation. */
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  multiline: z.boolean().optional().describe('For `string` and `list`: renders a text area rather than a single line.'),
})
export type FormField = z.infer<typeof formFieldSchema>

const paramsSchema = z.object({
  title: z.string().min(1).describe('What this form is for, in a few words.'),
  description: z.string().optional().describe('Optional sentence above the fields.'),
  fields: z.array(formFieldSchema).min(1).max(20),
})
export type AskUserFormParams = z.infer<typeof paramsSchema>

/** What comes back: one value per field, plus whether the user answered at all. */
export type FormValue = string | number | boolean | string[]

export interface FormAnswer {
  submitted: boolean
  values: Record<string, FormValue>
}

/**
 * Asks the user for structured input, as a form rather than a sentence.
 *
 * ## Why this is not `ask_followup_question`
 *
 * That tool ends the turn and treats the user's next message as the answer, which is right for
 * one open question. It is poor for a skill that needs four specific values: the assistant has
 * to describe every field in prose, the user has to answer in prose, and the assistant then has
 * to parse the prose back into values it can use — and each of those steps can go wrong
 * silently, producing a plausible wrong answer rather than an error.
 *
 * A form asks for exactly what it needs, in controls that cannot be mistyped as the wrong kind
 * of thing, and **the turn continues** with the answers as an ordinary tool result. That last
 * part is the real difference: the work carries straight on instead of restarting from a
 * message.
 *
 * ## Not an approval, and never a substitute for one
 *
 * This gathers *input*. It grants nothing, and nothing it returns bypasses the approval gate:
 * a form asking "shall I delete the branch?" still leads to a tool call that is approved on its
 * own terms. Reading a submitted form as permission would put a model-authored sentence where
 * ground truth belongs, which is exactly what invariant 8 forbids.
 *
 * ## When nobody is there
 *
 * `requestForm` is absent for an unattended run, and then this returns an error telling the
 * model to work from what it has. A scheduled job cannot stop and wait for someone to type.
 */
export function createAskUserFormTool(): Tool<AskUserFormParams> {
  return {
    name: 'ask_user_form',
    group: 'always',
    description:
      'Ask the user for structured input with a small form. Use it when you need several specific ' +
      'values rather than a sentence. Field types: string, number, boolean (a checkbox), choice ' +
      '(a dropdown over `options`), and list (one box the user fills with comma-separated values, ' +
      'answered as an array — use it for "which ids", not one field per id). The turn continues ' +
      'with the answers, so prefer this over ask_followup_question when the inputs are known and ' +
      'typed. Not for permission: acting still needs its own approval.',
    parametersSchema: paramsSchema,
    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      if (context.requestForm === undefined) {
        return {
          content:
            'No one is available to fill in a form in this run. Continue with the information you ' +
            'already have, or state what you would have asked for.',
          isError: true,
        }
      }

      const problem = validateFields(params.fields)
      if (problem !== undefined) return { content: problem, isError: true }

      const answer = await context.requestForm(params)
      if (!answer.submitted) {
        return { content: 'The user dismissed the form without answering. Ask in plain text instead, or continue without it.' }
      }
      return { content: JSON.stringify(answer.values, null, 2) }
    },
  }
}

/**
 * Rejects a form the UI could only render as something confusing.
 *
 * Returned to the model as a tool error so it corrects the call, rather than shown to the user
 * as a broken form. A dropdown with no options is not a control; it is a dead end.
 */
function validateFields(fields: readonly FormField[]): string | undefined {
  const seen = new Set<string>()
  for (const field of fields) {
    if (seen.has(field.name)) return `Two fields are both named "${field.name}". Field names must be unique.`
    seen.add(field.name)

    if (field.type === 'choice' && (field.options === undefined || field.options.length === 0)) {
      return `Field "${field.name}" is a choice but lists no options.`
    }
    if (field.type !== 'choice' && field.options !== undefined) {
      return `Field "${field.name}" is a ${field.type}, so it cannot have options. Use type "choice" for a fixed set.`
    }
  }
  return undefined
}

/**
 * Coerces one submitted value to the field's type, or reports why it cannot.
 *
 * Applied host-side as well as in the form. The UI validates so the user is told immediately;
 * this exists because the UI is not the authority on what reaches the model — a message can be
 * malformed, and a number field that quietly yields the string "twelve" would be discovered
 * much later and somewhere else.
 */
export function coerceFormValue(field: FormField, raw: unknown): { value: FormValue } | { error: string } {
  if (field.type === 'boolean') return { value: raw === true }

  if (field.type === 'list') {
    /*
     * Split on commas *and* newlines. Someone pasting a column out of a spreadsheet gets
     * newlines and someone typing gets commas, and refusing one of those would be a rule the
     * form did not warn about. Empty entries are dropped, so a trailing comma is not an
     * unnamed item — which is what a careful typist leaves behind.
     */
    const items = String(raw ?? '')
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    if (field.required !== false && items.length === 0) return { error: `"${field.label}" needs at least one value.` }
    return { value: items }
  }

  if (field.type === 'number') {
    const parsed = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
    if (!Number.isFinite(parsed)) return { error: `"${field.label}" must be a number.` }
    return { value: parsed }
  }

  const text = String(raw ?? '').trim()
  if (field.type === 'choice') {
    const allowed = (field.options ?? []).map((option) => option.value)
    if (!allowed.includes(text)) return { error: `"${field.label}" must be one of: ${allowed.join(', ')}.` }
    return { value: text }
  }

  if (field.required !== false && text.length === 0) return { error: `"${field.label}" is required.` }
  return { value: text }
}
