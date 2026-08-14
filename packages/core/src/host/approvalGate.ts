import type { ApprovalDecision, ApprovalGate, ApprovalRequest, HostToUiMessage } from '@light-code/core'

/**
 * Bridges core's synchronous-looking `requestApproval` to the asynchronous webview
 * round-trip: post the request, park a promise keyed by id, resolve it when the UI
 * answers. Core stays platform-agnostic and never learns about the transport.
 */
interface PendingEntry {
  resolve: (decision: ApprovalDecision) => void
  request: ApprovalRequest
}

export class WebviewApprovalGate implements ApprovalGate {
  private readonly pending = new Map<string, PendingEntry>()

  constructor(private readonly post: (message: HostToUiMessage) => void) {}

  /** The request behind an id, so "always allow" knows what it is remembering. */
  getRequest(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)?.request
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(request.id, { resolve, request })
      this.post({
        type: 'approvalRequest',
        id: request.id,
        toolName: request.toolName,
        group: request.group,
        preview: request.preview,
        ...(request.alwaysScope === undefined ? {} : { alwaysScope: request.alwaysScope }),
      })
    })
  }

  /** Called when the UI answers. Unknown ids are ignored — a stale reply is not a denial. */
  resolve(id: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.pending.delete(id)
    pending.resolve(decision)
  }

  /**
   * Cancelling a turn, or disposing the view, must not leave the loop awaiting an answer
   * that can never arrive. Everything outstanding resolves as denied — the safe direction.
   */
  denyAll(): void {
    for (const entry of this.pending.values()) entry.resolve('deny')
    this.pending.clear()
  }
}
