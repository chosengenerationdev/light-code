import type { AutoApproveSettings, WorkspaceApprovals } from '../config/schema.js'
import type { ApprovableGroup, ToolGroup, ToolPreview } from '../tools/types.js'
import { isCommandAllowlisted } from './commands.js'
import { matchRiskyCommand, type RiskyCommandRule } from './riskyCommands.js'
import { isSafeCommand, type SafeCommandOptions } from './safeCommands.js'

/**
 * Whether safe commands may run unprompted, and which count.
 *
 * `enabled` is the mode's business (`Mode.autoApproveSafeCommands`); the lists are the user's. Two
 * separate questions, so neither can be answered by accident from the other.
 */
export interface SafeCommandPolicy extends SafeCommandOptions {
  enabled: boolean
}
import { requiresApproval, type ApprovalDecision, type ApprovalGate, type ApprovalRequest } from './types.js'

// Both shapes are inferred from the config schema so the validator and the runtime type
// cannot drift. Everything defaults off — §8: "All auto-approve toggles ship off."
export type { ApprovableGroup, AutoApproveSettings, WorkspaceApprovals }

export function isApprovableGroup(group: ToolGroup): group is ApprovableGroup {
  return group === 'read' || group === 'edit' || group === 'command' || group === 'mcp'
}

function categoryEnabled(group: ToolGroup, settings: AutoApproveSettings | undefined): boolean {
  if (settings === undefined || !isApprovableGroup(group)) return false
  return settings[group] === true
}

/**
 * Decides whether a request can be answered without asking the user. Returns `undefined`
 * when it cannot — the caller must then prompt.
 *
 * `execute_command` is deliberately stricter than its category suggests: the category
 * toggle alone is not enough, because "auto-approve all commands" and "auto-approve the
 * commands I listed" are very different grants. A command is auto-approved only if it is
 * on the exact-match allowlist, *or* the category toggle is on.
 */
/**
 * Tools that always ask, whatever the auto-approve settings say.
 *
 * These write **model-authored code and prose that later runs or is injected into context**:
 * a Python tool becomes a callable code path, and a skill becomes standing instructions
 * nobody code-reviews. §13 calls this the sharpest surface in the project, and the reason is
 * compounding — an auto-approved tool creation means an injected instruction can install a
 * *persistent* capability, which is then auto-approved on every later call by the same
 * setting.
 *
 * So the toggles cannot reach them. "Auto-approve edits" is a statement about editing the
 * files you are working on, not about granting the assistant new abilities, and reading it as
 * the latter is a grant nobody knowingly made.
 *
 * This does not restrict what the assistant can *do* — every one of these still works. It
 * only means a human sees the source once, which is what §13 asks for and all it asks for.
 */
export const ALWAYS_ASK_TOOLS: ReadonlySet<string> = new Set([
  'create_python_tool',
  'update_python_tool',
  'delete_python_tool',
  'write_skill',
  'delete_skill',
  /*
   * VBA installed into a workbook runs on this machine as this user, and nobody reviews a macro
   * afterwards. That is the same act as creating a Python tool, so it gets the same rule: a
   * human sees the source once, and no category toggle can stand in for that.
   */
  'excel_write_macro',
  // Changes a workbook somebody has open and has not saved, with no undo this product owns.
  'excel_write_range',
  /*
   * Writing a file to disk, and the only Excel tool that does. `overwrite` makes it able to
   * replace one, and "create the March report" landing on February's is not a mistake that
   * announces itself - so the path is read once by a person.
   */
  'excel_create_workbook',
  /*
   * The point of no return for every other Excel write.
   *
   * Those deliberately leave the workbook dirty, so closing without saving is the undo. This is
   * what spends it, and a category toggle standing in for that would quietly remove the only
   * escape hatch the feature has.
   */
  'excel_save_workbook',
  /*
   * Deleting a sheet discards data that is nowhere in the transcript, and turns every formula
   * referencing it into #REF! with no way back. Renaming and moving are milder, but splitting the
   * tool to say so would produce six tool descriptions differing by a word - see `excel_sheets`.
   */
  'excel_sheets',
  /*
   * Running a macro executes somebody else's VBA as the user: it can rewrite the workbook, write
   * files, or send mail. That is not something a category toggle should ever cover, and the
   * approval showing the actual source is the only thing standing between "run DoTheThing" and
   * whatever DoTheThing does.
   */
  'excel_run_macro',
  /*
   * It reads files off this machine and puts them into a message addressed to other people.
   *
   * Nothing is sent - the draft opens on screen and the user decides - so the act being approved
   * is the composing, and specifically which files and which recipients. "Auto-approve commands"
   * is a statement about running commands, and reading it as permission to attach whatever the
   * model names to whoever it names is a grant nobody knowingly made. The preview lists both by
   * name rather than by count, which is only useful if somebody is shown it.
   */
  'outlook_create_draft',
  /*
   * The plan is what holds the assistant to work the user agreed, so a category toggle must
   * never stand in for reading the change. Auto-approving this would mean an agent could widen
   * its own instructions and then point at them as authority — and both the panel and the
   * prompt would look right afterwards, because both would be reading the new plan.
   */
  'update_plan',
  /*
   * A role's prompt is prose injected into a model that then advises on this repository's code —
   * the reason `agents` is user-scope only. Softening a reviewer does not error; it approves
   * things, in the same tone as before. A category toggle must never stand in for reading that
   * diff.
   */
  'update_role',
  // Inventing one is the same act as rewriting one: a prompt that will advise on this code.
  'create_role',
  // And removing one takes a prompt somebody wrote with it.
  'delete_role',
])

export function decideFromPolicy(
  request: ApprovalRequest,
  approvals: WorkspaceApprovals | undefined,
  /**
   * Commands the user marked risky, already merged with the built-in list.
   *
   * See `riskyCommands.ts` for why patterns are allowed here and forbidden in the allowlist, and
   * why there are built-in ones at all.
   */
  risky?: readonly RiskyCommandRule[] | undefined,
  /**
   * Read-only commands that may run unprompted, when the active mode allows it.
   *
   * Absent means nothing qualifies, which is every mode but Auto. See `safeCommands.ts` for why
   * this may match a prefix when the allowlist may not.
   */
  safe?: SafeCommandPolicy | undefined,
): ApprovalDecision | undefined {
  if (!requiresApproval(request.group)) return 'approve'

  /*
   * Checked before everything, including the allowlist. "Always allow" on one of these would
   * be a standing grant to install code, made by a click on a prompt that looked like an
   * ordinary edit.
   */
  if (ALWAYS_ASK_TOOLS.has(request.toolName)) return undefined

  /*
   * Checked before the allowlist, before the category toggle, and before `approvals` is even
   * looked at — so a risky command still asks in a workspace that has no approvals entry.
   *
   * The same precedence §11 gives MCP tools: **never beats always.** A stale "always allow" must
   * not resurrect a command the user has since marked risky, and "auto-approve commands" is a
   * statement about ordinary commands rather than about the handful somebody singled out.
   */
  if (request.group === 'command') {
    const command = commandFromPreview(request.preview)
    if (command !== undefined && matchRiskyCommand(command, risky) !== undefined) return undefined
  }

  /*
   * After the risky check and before everything else.
   *
   * After, so a rule can never be skipped by a command that also looks safe. Before `approvals`,
   * because this is a property of the *mode* rather than of what the workspace has allowed — and a
   * fresh workspace is exactly where twenty prompts an hour would be met first.
   */
  if (request.group === 'command' && safe?.enabled === true) {
    const command = commandFromPreview(request.preview)
    if (command !== undefined && isSafeCommand(command, safe)) return 'approve'
  }

  if (approvals === undefined) return undefined

  if (approvals.allowedTools?.includes(request.toolName) === true) return 'approve'

  if (request.group === 'command') {
    const command = commandFromPreview(request.preview)
    if (command !== undefined && isCommandAllowlisted(command, approvals.allowedCommands ?? [])) {
      return 'approve'
    }
  }

  return categoryEnabled(request.group, approvals.autoApprove) ? 'approve' : undefined
}

/**
 * Reads the command from ground truth (the tool's own preview), never from the model's
 * arguments — the allowlist must be checked against the string that will actually run.
 */
function commandFromPreview(preview: ToolPreview): string | undefined {
  return preview.kind === 'command' ? preview.command : undefined
}

/**
 * Wraps another gate, answering from policy where it can and delegating to the user
 * otherwise. Composing rather than teaching the loop about policy keeps the loop's
 * single responsibility — "ask before acting" — intact.
 */
export class PolicyApprovalGate implements ApprovalGate {
  constructor(
    private readonly inner: ApprovalGate,
    private readonly getApprovals: () => WorkspaceApprovals | undefined,
    /**
     * The risky-command rules in force, read per request rather than captured.
     *
     * A function for the same reason `getApprovals` is one: the settings can change mid-session,
     * and a list captured when the gate was constructed would apply the rules somebody had before
     * they went and added the one they were worried about.
     */
    private readonly getRisky?: () => readonly RiskyCommandRule[] | undefined,
    /**
     * Whether safe commands may run unprompted right now.
     *
     * A function because it depends on the **mode**, which the user changes between turns — a
     * value captured here would keep Auto mode's relaxation after they had switched back.
     */
    private readonly getSafe?: () => SafeCommandPolicy | undefined,
  ) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const risky = this.getRisky?.()
    const decided = decideFromPolicy(request, this.getApprovals(), risky, this.getSafe?.())
    if (decided !== undefined) return decided

    /*
     * A refusing rule stops here rather than reaching the prompt.
     *
     * `decideFromPolicy` answers "who decides", and the answer for any risky command is "the
     * user" — so refusal cannot live in there without conflating the two. `refuse` means the user
     * has already decided, in advance, that this one is never run from here; putting it in front
     * of them again would only invite the click they were protecting themselves from.
     */
    const command = commandFromPreview(request.preview)
    if (request.group === 'command' && command !== undefined) {
      const match = matchRiskyCommand(command, risky)
      if (match?.rule.refuse === true) return 'deny'
    }

    return this.inner.requestApproval(request)
  }
}
