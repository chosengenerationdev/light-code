import { z } from 'zod'
import { providerProfileSchema } from '../providers/types.js'

/**
 * The whole config file, one schema shared by the UI and the file loader (§15) so a
 * hand-edited file and a UI save fail identically. Only the shape needed so far
 * (Phase 2) is modelled; MCP servers, approvals, etc. extend this in later phases
 * without redesigning it.
 */
export const pythonConfigSchema = z
  .object({
    uvPath: z.string(),
  })
  .partial()

export const configSchema = z
  .object({
    profiles: z.array(providerProfileSchema),
    activeProfileId: z.string(),
    certDir: z.string(),
    python: pythonConfigSchema,
  })
  .partial()

export type LightCodeConfig = z.infer<typeof configSchema>

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

/** Parses and validates raw JSON text. `undefined` input (no file yet) yields `{}`. */
export function parseConfig(raw: string | undefined): LightCodeConfig {
  if (raw === undefined) return {}

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new ConfigValidationError(
      `Config file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      [],
    )
  }

  const result = configSchema.safeParse(json)
  if (!result.success) {
    throw new ConfigValidationError(
      `Config file failed validation: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      result.error.issues,
    )
  }
  return result.data
}
