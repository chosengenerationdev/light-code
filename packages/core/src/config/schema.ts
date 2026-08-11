import { z } from 'zod'
import { mcpServersSchema } from '../mcp/types.js'
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

export const autoApproveSchema = z
  .object({
    read: z.boolean(),
    edit: z.boolean(),
    command: z.boolean(),
    mcp: z.boolean(),
  })
  .partial()

export const workspaceApprovalsSchema = z
  .object({
    autoApprove: autoApproveSchema,
    allowedTools: z.array(z.string()),
    /** Exact command strings — never patterns. See approval/commands.ts and §8. */
    allowedCommands: z.array(z.string()),
  })
  .partial()

/**
 * Inferred from the schema rather than hand-written, so the validator and the type can
 * never drift apart — the same single-schema principle as §15.
 */
export type AutoApproveSettings = z.infer<typeof autoApproveSchema>
export type WorkspaceApprovals = z.infer<typeof workspaceApprovalsSchema>

/**
 * The Claude CLI as a consulting expert (`ask_expert`).
 *
 * User-scope only along with everything else on invariant 5's list — `path` names an
 * executable, and a workspace able to set it would run a program of its choosing the
 * moment the panel opened. Same threat as `python.uvPath`.
 */
export const expertConfigSchema = z
  .object({
    /** Off unless explicitly enabled. Nothing is spawned or spent without this. */
    enabled: z.boolean(),
    /** Defaults to `claude` on PATH. An absolute path works for a non-standard install. */
    path: z.string(),
    /** Overrides the model the CLI would otherwise choose. */
    model: z.string(),
  })
  .partial()

export const configSchema = z
  .object({
    profiles: z.array(providerProfileSchema),
    expert: expertConfigSchema,
    activeProfileId: z.string(),
    certDir: z.string(),
    python: pythonConfigSchema,
    /**
     * Keyed by workspace path. Per-workspace in *behaviour* (§8) but stored user-side and
     * user-scope-only (invariant 5) — a repo must not be able to ship its own
     * pre-approvals in `.lightcode/config.json`.
     */
    approvals: z.record(z.string(), workspaceApprovalsSchema),
    /** Active mode id; falls back to Code when absent or unrecognised. */
    modeId: z.string(),
    /**
     * Standard `mcpServers` shape so configs paste in from other clients unmodified (§11).
     * Global and workspace scopes both allowed — workspace wins — because an MCP server
     * is often project-specific. Note this is *deliberately not* on invariant 5's list:
     * unlike approvals, adding a server does not bypass approval, since every MCP tool
     * call is gated exactly like any other tool.
     */
    mcpServers: mcpServersSchema,
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
