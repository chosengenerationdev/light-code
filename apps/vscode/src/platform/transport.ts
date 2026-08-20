import * as vscode from 'vscode'
import type { Logger, Transport } from '@light-code/core'

/**
 * A transport whose webview can be swapped, or absent entirely.
 *
 * The bridge used to be created per webview, which tied everything it owns — including the
 * schedule timer — to the lifetime of a UI panel. A schedule therefore stopped existing the
 * moment the view was torn down, which is how "it never fired, but Run Now works" happens:
 * Run Now is only reachable while the panel is open, which is the one state where the timer
 * was alive.
 *
 * So the bridge now outlives the view and the view attaches to it. Posting with nothing
 * attached is a no-op rather than an error: an unattended run genuinely has nobody to tell,
 * and its output is persisted to the task store either way.
 */
export class WebviewTransport implements Transport {
  private webview: vscode.Webview | undefined
  private subscription: vscode.Disposable | undefined
  /**
   * One message held for a view that exists but has not run its script yet.
   *
   * `reveal` returns long before React mounts, so a walkthrough button that posted straight
   * away would land nowhere and the tab would simply not open — the exact silent failure a
   * navigation button must not have. A single slot rather than a queue: the last place asked
   * for is the only one worth going to.
   */
  private pendingNavigation: unknown | undefined
  /** Proven by an inbound message. A view that has spoken can certainly listen. */
  private live = false
  private readonly listeners = new Set<(message: unknown) => void>()

  constructor(private readonly logger?: Logger) {}

  /** Points the transport at a newly created view. Any previous one is dropped. */
  attach(webview: vscode.Webview): void {
    this.detach()
    this.webview = webview
    this.subscription = webview.onDidReceiveMessage((message: unknown) => {
      if (!this.live) {
        this.live = true
        const held = this.pendingNavigation
        this.pendingNavigation = undefined
        if (held !== undefined) this.post(held)
      }
      for (const listener of this.listeners) listener(message)
    })
  }

  /**
   * Posts now if the view is running, otherwise on the next one that starts.
   *
   * Only for navigation. Holding *state* like this would be wrong — it would arrive against a
   * view that has since rebuilt itself from the host and be stale on delivery.
   */
  postWhenLive(message: unknown): void {
    if (this.live && this.webview !== undefined) {
      this.post(message)
      return
    }
    this.pendingNavigation = message
  }

  detach(): void {
    this.live = false
    this.subscription?.dispose()
    this.subscription = undefined
    this.webview = undefined
  }

  /**
   * Watches outbound messages, for things the *extension* needs to know.
   *
   * The walkthrough completes its steps from context keys, and whether a provider exists or a
   * turn has finished is knowledge the bridge already broadcasts. Observing that is far better
   * than the extension re-reading config and guessing — two readers of one fact drift, and this
   * one would drift silently into a walkthrough step that never ticks.
   */
  observe(listener: (message: unknown) => void): void {
    this.observers.add(listener)
  }

  private readonly observers = new Set<(message: unknown) => void>()

  post(message: unknown): void {
    for (const observer of this.observers) observer(message)
    const webview = this.webview
    if (webview === undefined) return
    webview.postMessage(message).then((delivered) => {
      if (!delivered) this.logger?.warn('postMessage was not delivered', JSON.stringify(message))
    })
  }

  /**
   * Listeners survive a reattach.
   *
   * The bridge subscribes once, at construction, and must keep receiving messages from
   * whichever webview is current — otherwise the second time the panel opens, every button
   * in it would be inert.
   */
  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
