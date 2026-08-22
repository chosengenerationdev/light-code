import type { z } from 'zod'
import type { PathDenylist } from '../fs/denylist.js'
import type { FileSystem } from '../platform/filesystem.js'
import type { Terminal } from '../platform/terminal.js'

export type ToolGroup = 'read' | 'edit' | 'command' | 'mcp' | 'always'

/**
 * Groups that can be auto-approved. `always` is excluded because it is never gated at
 * all — control tools perform no work, so there is nothing to approve.
 */
export type ApprovableGroup = Exclude<ToolGroup, 'always'>

export interface ToolResult {
  content: string
  isError?: boolean
  /** Present for tools that touch a specific file, so the loop can track consecutive mistakes per file. */
  path?: string
}

export interface ToolExecutionContext {
  fs: FileSystem
  terminal: Terminal
  workspaceRoot: string
  denylist: PathDenylist
  /**
   * Confined, normalized paths read via `read_file` this session. `write_to_file`/
   * `apply_diff` refuse to touch an *existing* file that isn't in this set — cheap
   * invariant, eliminates a class of hallucinated edits. See CLAUDE.md §6.
   */
  readFiles: Set<string>
  /**
   * Extra directories tools may **read** from, beyond the workspace.
   *
   * For files that genuinely live elsewhere — a network share of logs being the case that
   * prompted this, and on Windows that means a UNC path the workspace can never contain.
   *
   * Read-only by construction: `resolveToolPath` ignores these when a tool is writing, because
   * checkpoints only snapshot the workspace and an edit outside it could not be rolled back.
   */
  readRoots?: string[]
  /**
   * Values made visible to whatever this session spawns — shell commands, Python tools.
   *
   * Optional and absent in the VS Code extension, which has one user and their own environment
   * already. The Node host supplies it because a shared server has to answer "whose value" —
   * see `session/variables.ts`, and note especially that these are **not secrets**: everything
   * spawned runs as the service account, so another user's agent can read them.
   */
  sessionEnv?: Record<string, string>
  /**
   * Asks the user whether a path outside every allowed root may be read.
   *
   * Pre-registering every share before the assistant can look at anything is a lot of friction
   * for a permission the user is perfectly able to grant when it is actually needed — and the
   * prompt is *better* evidence than the setting, because it names the real resolved path
   * rather than blessing a whole tree in advance (invariant 8).
   *
   * Absent means refuse, which is what an unattended scheduled run gets: there is nobody to
   * ask, so a run cannot widen its own filesystem access.
   */
  requestPathAccess?: (realPath: string) => Promise<boolean>
  /**
   * Absolute path to the `rg` executable, supplied by the host.
   *
   * Core deliberately does **not** import `@vscode/ripgrep`. That package resolves a
   * platform-specific binary on disk, which makes it a platform concern (§4) — and
   * importing it from core put a top-level `require` into the bundled extension for a
   * package that is not inside the VSIX, so loading the published extension failed
   * outright with `MODULE_NOT_FOUND`. Build, typecheck and package all passed; only
   * installing it revealed the problem.
   *
   * Omitted disables the ripgrep-backed paths, which degrade rather than throw.
   */
  ripgrepPath?: string
  signal?: AbortSignal
}

/**
 * What executing a tool would actually do, computed by the tool itself — never the
 * model's description of its own intent. This is invariant 8 ("approval UI shows ground
 * truth") expressed as a type: the approval prompt renders only these.
 */
export type ToolPreview =
  /** The literal command line that will be run, verbatim. */
  | { kind: 'command'; command: string; cwd: string }
  /** A real diff, produced by running the edit against the file's current content. */
  | {
      kind: 'diff'
      path: string
      before: string
      after: string
      /**
       * One line of provenance, shown above the diff.
       *
       * For source a *different* model wrote — the programming provider. Where a change came
       * from is part of what the user is judging, and the approval prompt is the only place it
       * can be said before the file exists.
       */
      note?: string
    }
  /** Fallback for tools with nothing richer to show — the resolved parameters. */
  | { kind: 'text'; text: string }

export interface Tool<TParams = Record<string, unknown>> {
  name: string
  group: ToolGroup
  description: string
  parametersSchema: z.ZodType<TParams>
  /**
   * Authoritative JSON Schema, when the tool has one that did not come from zod — MCP
   * servers supply their own. Preferred over converting `parametersSchema`, because
   * round-tripping through zod can silently drop keywords the provider relies on
   * (CLAUDE.md §11 calls schema translation a silent-failure source).
   */
  rawJsonSchema?: unknown
  execute(params: TParams, context: ToolExecutionContext): Promise<ToolResult>
  /**
   * Computes ground truth for the approval prompt without performing the action. Tools
   * that change the world (edit, command) must implement this; read-only tools may
   * omit it and fall back to showing their arguments.
   */
  preview?(params: TParams, context: ToolExecutionContext): Promise<ToolPreview>
}
