import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import type { Tool } from '../tools/types.js'

/**
 * Fire Code's monitoring, as a Light Code host sees it.
 *
 * The engine is Fire Code's own (Rust, `apps/sun/native/src/monitor.rs`): it finds monitor skills, runs
 * them on their schedule, judges their rows, keeps history and sends the Windows notifications. A host
 * reaches it over its own stdin and stdout - a `light-code-monitor:` line out, one JSON line back - so
 * there is no socket or port to secure. Absent in the VS Code extension and the plain Node host: there is
 * no dashboard there to show anything on.
 *
 * Two roles, both optional:
 * - **`MonitoringChannel`**: a chat's agent asking the engine (list, a monitor's rows, run now, acknowledge,
 *   approve what it just wrote). Every Fire Code chat has it while monitoring is on.
 * - **`MonitorExecutorChannel`**: the background host that runs the tools monitors name. One per Fire Code,
 *   with no window. The only way a monitor reaches the network or a credential, so every request still
 *   goes through the one HttpClient (invariant 2).
 */
export interface MonitoringChannel {
  /** One engine operation. Rejects with the engine's own sentence when it refuses. */
  request(op: string, args?: Record<string, unknown>): Promise<unknown>
}

/** What the engine asks the executor for. */
export type MonitorRequest =
  /** Run a monitor's tool once; the answer's `data` is the tool's text. */
  | { kind: 'fetch'; id: string; tool: string; args: Record<string, unknown>; timeoutMs: number }
  /** The team's history in OpenSearch (`history.ts`): claim, write, latest, history, prune. */
  | { kind: 'store'; id: string; op: string; storeId: string; index: string; args: Record<string, unknown> }
  /** Explain an alert from the facts Fire Code gathered (`explain.ts`); `data` is Markdown. */
  | { kind: 'explain'; id: string; context: Record<string, unknown> }
  /**
   * A monitor's skill file that is a copy synced from the team (a bucket folder, the team repository), changed
   * by the user on the dashboard: `write` its new text where the team keeps it, or `delete` it everywhere.
   * Fire Code has no network of its own; this host has the bucket and repository connections.
   */
  | { kind: 'skill'; id: string; op: 'write' | 'delete'; name: string; file: string; content?: string }
  /**
   * Whether a monitor's tool can run on this computer - present, approved, allowed for monitors - without running
   * it. Asked before this computer claims a team monitor's run, so a member who cannot run it leaves it to one who
   * can. `data` is `{ ready: true }` or `{ ready: false, reason }`.
   */
  | { kind: 'probe'; id: string; tool: string }
  /**
   * The dashboard's refresh: bring the team's skills and tools down now - the bucket folders and the team
   * repository - rather than at the next timed sync, so a monitor a colleague just added (or deleted) shows.
   * `data` is `{ synced: string[] }`, the places synced.
   */
  | { kind: 'sync'; id: string }

export type MonitorAnswer = { ok: true; data: unknown } | { ok: false; error: string }

export interface MonitorExecutorChannel {
  /** Called once: how this host answers the engine. Then the engine is told it is ready. */
  serve(handler: (request: MonitorRequest) => Promise<MonitorAnswer>): void
}

/**
 * Why a monitor may not run this tool unattended, or undefined when it may.
 *
 * A monitor only *observes*: it runs again and again with nobody watching, so anything that changes
 * something is refused whatever the user approved - edit and command tools, everything that always asks,
 * and everything a schedule may never have. **Python tools are the exception** to the command rule: they
 * are code this machine approved byte for byte (§13), and a monitor reading an internal system needs one.
 * The same function decides for the executor and for `monitor_create`, so the two cannot disagree.
 */
export function monitorToolRefusal(tool: Tool | undefined, name: string): string | undefined {
  if (tool === undefined) {
    return (
      `There is no tool called "${name}" here. A monitor uses a Python tool (py__name), an MCP tool, or a read tool ` +
      "that exists in the settings monitoring runs with (Fire Code → Settings → Monitoring → 'Run tools with the settings of')."
    )
  }
  if (ALWAYS_ASK_TOOLS.has(tool.name) || NEVER_AVAILABLE_TO_SCHEDULES.includes(tool.name)) {
    return `"${tool.name}" changes something or always asks, so a monitor - which runs unattended - may not use it.`
  }
  if (tool.group === 'edit' || tool.group === 'always') {
    return `"${tool.name}" is not a reading tool (${tool.group}), so a monitor may not use it.`
  }
  if (tool.group === 'command' && !tool.name.startsWith('py__')) {
    return `"${tool.name}" runs commands, so a monitor may not use it. Write a Python tool that reads what is needed and returns rows.`
  }
  return undefined
}
