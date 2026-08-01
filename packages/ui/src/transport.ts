import type { Transport } from '@light-code/core'

interface VsCodeApi {
  postMessage(message: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

/**
 * The one file in packages/ui allowed to touch a host-specific global
 * (`acquireVsCodeApi`, injected by the VS Code webview runtime). Everything else in
 * this package talks to the `Transport` interface only, so the same components work
 * unmodified behind a WebSocket for the future Node host (§14).
 */
export class VsCodeTransport implements Transport {
  private readonly vscode = acquireVsCodeApi()
  private readonly listeners = new Set<(message: unknown) => void>()

  constructor() {
    window.addEventListener('message', (event: MessageEvent<unknown>) => {
      for (const listener of this.listeners) listener(event.data)
    })
  }

  post(message: unknown): void {
    this.vscode.postMessage(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
