import * as vscode from 'vscode'
import type { Logger, Transport } from '@light-code/core'

export class WebviewTransport implements Transport {
  constructor(
    private readonly webview: vscode.Webview,
    private readonly logger?: Logger,
  ) {}

  post(message: unknown): void {
    this.webview.postMessage(message).then((delivered) => {
      if (!delivered) this.logger?.warn('postMessage was not delivered', JSON.stringify(message))
    })
  }

  onMessage(listener: (message: unknown) => void): () => void {
    const disposable = this.webview.onDidReceiveMessage(listener)
    return () => disposable.dispose()
  }
}
