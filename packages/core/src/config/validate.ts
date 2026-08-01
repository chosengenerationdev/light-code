import { providerProfileSchema } from '../providers/types.js'

export interface FieldError {
  path: string
  message: string
}

/**
 * Reuses the exact field validators from `providerProfileSchema` (the schema the file
 * loader validates against) so a hand-edited file and a UI save fail identically — see
 * CLAUDE.md §15. `id` and `auth` are excluded: the UI assigns an id separately and
 * collects a raw API key string rather than an `Auth` object.
 */
const providerFormSchema = providerProfileSchema.pick({
  label: true,
  wireFormat: true,
  baseUrl: true,
  model: true,
})

export function validateProviderForm(input: unknown): FieldError[] {
  const result = providerFormSchema.safeParse(input)
  if (result.success) return []
  return result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
}
