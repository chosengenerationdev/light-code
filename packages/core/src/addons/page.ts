import { z } from 'zod'

/**
 * An add-on's own settings tab, declared in its `package.json` (`lightCode.addon.settings`).
 *
 * Asked for with the Linux add-on: "after installing the addon, this should show a new tab ... where
 * user should be able to add the Linux machines", and - the decisive part - "I don't want the new tab
 * to be appearing in Light Code or Fire Code, it should appear only when addon is installed". So Light
 * Code ships no tab for any add-on. An add-on *describes* a page; Light Code renders it.
 *
 * **Declared, not supplied.** The add-on gives fields, not HTML or script: the panel is the one part of
 * Light Code that holds secrets on screen and talks to the host, and an add-on's own markup running
 * there would be third-party code inside it. A form described as data renders with Light Code's own
 * controls and theme, works in every host, and cannot do anything but be filled in.
 *
 * Values are kept in user settings (`addons.settings`), secrets in secret storage, and both reach the
 * add-on when it starts (`addons/delivery.ts`) - never through the panel.
 */

const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/

export const addonFieldSchema = z.object({
  key: z.string().regex(KEY),
  label: z.string().min(1).max(80),
  type: z.enum(['string', 'number', 'boolean', 'choice', 'secret', 'path', 'text']),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).max(30).optional(),
  placeholder: z.string().max(200).optional(),
  help: z.string().max(500).optional(),
  /** A pattern the value must match, with the sentence shown when it does not. */
  pattern: z.string().max(200).optional(),
  patternMessage: z.string().max(200).optional(),
  /** Shown only while another field of the same form has this value - auth fields by auth method. */
  showWhen: z.object({ field: z.string().regex(KEY), equals: z.union([z.string(), z.array(z.string())]) }).optional(),
})

export const addonPageSchema = z.object({
  title: z.string().min(1).max(40),
  description: z.string().max(1000).optional(),
  /** Settings of the add-on as a whole. */
  fields: z.array(addonFieldSchema).max(30).optional(),
  /** A list of things the user adds - machines, sites, accounts. */
  records: z
    .object({
      /** What one is called: "machine". */
      noun: z.string().min(1).max(30),
      title: z.string().min(1).max(40),
      description: z.string().max(1000).optional(),
      /** The field that names a record, unique among them: what the user and the agent call it. */
      keyField: z.string().regex(KEY),
      /** One line under the name, e.g. "{username}@{host}:{port}". */
      summary: z.string().max(200).optional(),
      fields: z.array(addonFieldSchema).min(1).max(30),
      /**
       * Buttons on each record, each calling one of the add-on's own tools with `{ [keyField]: name }`
       * - "Test connection". Pressed by the user, about a record they are looking at, so it is not an
       * agent's tool call and asks no approval.
       */
      actions: z
        .array(
          z.object({
            label: z.string().min(1).max(40),
            tool: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            /** Shown before it runs, needing a second press: for an action that changes something. */
            confirm: z.string().max(800).optional(),
            /** Offered only for records with this value - "Set up SSH key" for password sign-in. */
            showWhen: z.object({ field: z.string().regex(KEY), equals: z.union([z.string(), z.array(z.string())]) }).optional(),
          }),
        )
        .max(5)
        .optional(),
      max: z.number().int().positive().max(500).optional(),
    })
    .optional(),
})

export type AddonField = z.infer<typeof addonFieldSchema>
export type AddonPage = z.infer<typeof addonPageSchema>

/** What is kept for an add-on: its own values, and its records. Secrets are never here. */
export interface AddonStoredSettings {
  values?: Record<string, unknown> | undefined
  records?: { id: string; values: Record<string, unknown> }[] | undefined
}

/** Where one secret field is kept in secret storage. */
export function addonSecretRef(pkg: string, recordId: string | undefined, field: string): string {
  return `addon:${pkg}:${recordId ?? '_'}:${field}`
}

/**
 * Checks values against their fields and returns them typed, or the sentence saying which is wrong.
 * Secret fields are left out: their values travel separately and are never stored here.
 */
export function cleanAddonValues(
  fields: readonly AddonField[],
  values: Record<string, unknown>,
): { ok: true; values: Record<string, unknown> } | { ok: false; message: string } {
  const out: Record<string, unknown> = {}
  // Defaults count when deciding what is shown: an auth method left at its default still decides.
  const effective: Record<string, unknown> = { ...values }
  for (const field of fields) {
    const given = values[field.key]
    if ((given === undefined || given === '' || given === null) && field.default !== undefined) effective[field.key] = field.default
  }
  for (const field of fields) {
    if (field.type === 'secret') continue
    const value = effective[field.key]
    if (!isShown(field, effective)) continue
    if (value === undefined || value === '') {
      if (field.required === true) return { ok: false, message: `${field.label} is required.` }
      continue
    }
    switch (field.type) {
      case 'number': {
        const n = typeof value === 'number' ? value : Number(String(value).trim())
        if (!Number.isFinite(n)) return { ok: false, message: `${field.label} must be a number.` }
        out[field.key] = n
        break
      }
      case 'boolean':
        out[field.key] = value === true || value === 'true'
        break
      case 'choice': {
        const text = String(value)
        if (!(field.options ?? []).some((option) => option.value === text)) return { ok: false, message: `${field.label}: choose one of the options.` }
        out[field.key] = text
        break
      }
      default: {
        const text = String(value).trim()
        if (field.pattern !== undefined && !new RegExp(field.pattern).test(text)) {
          return { ok: false, message: field.patternMessage ?? `${field.label} is not in the expected form.` }
        }
        out[field.key] = text
      }
    }
  }
  return { ok: true, values: out }
}

/**
 * What a button's tool may ask Light Code to change on its record, in its structured result:
 * `{ "lightCode": { "recordUpdate": { ...values } } }`. Only fields the page declares, checked as if
 * typed, and never a secret.
 */
export function recordUpdateFrom(structured: unknown): Record<string, unknown> | undefined {
  const update = (structured as { lightCode?: { recordUpdate?: unknown } } | undefined)?.lightCode?.recordUpdate
  return update !== null && typeof update === 'object' && !Array.isArray(update) ? (update as Record<string, unknown>) : undefined
}

/** Whether a field is on screen for these values. */
export function isShown(field: Pick<AddonField, 'showWhen'>, values: Record<string, unknown>): boolean {
  if (field.showWhen === undefined) return true
  const current = String(values[field.showWhen.field] ?? '')
  const wanted = field.showWhen.equals
  return Array.isArray(wanted) ? wanted.includes(current) : current === wanted
}
