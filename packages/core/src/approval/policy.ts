import type { AutoApproveSettings, WorkspaceApprovals } from '../config/schema.js'
import type { ApprovableGroup, ToolGroup, ToolPreview } from '../tools/types.js'
import { isCommandAllowlisted } from './commands.js'
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
])

export function decideFromPolicy(
  request: ApprovalRequest,
  approvals: WorkspaceApprovals | undefined,
): ApprovalDecision | undefined {
  if (!requiresApproval(request.group)) return 'approve'

  /*
   * Checked before everything, including the allowlist. "Always allow" on one of these would
   * be a standing grant to install code, made by a click on a prompt that looked like an
   * ordinary edit.
   */
  if (ALWAYS_ASK_TOOLS.has(request.toolName)) return undefined

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
  ) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const decided = decideFromPolicy(request, this.getApprovals())
    if (decided !== undefined) return decided
    return this.inner.requestApproval(request)
  }
}
