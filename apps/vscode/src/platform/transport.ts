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
  private readonly listeners = new Set<(message: unknown) => void>()

  constructor(private readonly logger?: Logger) {}

  /** Points the transport at a newly created view. Any previous one is dropped. */
  attach(webview: vscode.Webview): void {
    this.detach()
    this.webview = webview
    this.subscription = webview.onDidReceiveMessage((message: unknown) => {
      for (const listener of this.listeners) listener(message)
    })
  }

  detach(): void {
    this.subscription?.dispose()
    this.subscription = undefined
    this.webview = undefined
  }

  post(message: unknown): void {
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
