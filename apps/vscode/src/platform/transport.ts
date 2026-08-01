import * as vscode from 'vscode'
import type { Transport } from '@light-code/core'

export class WebviewTransport implements Transport {
  constructor(private readonly webview: vscode.Webview) {}

  post(message: unknown): void {
    void this.webview.postMessage(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    const disposable = this.webview.onDidReceiveMessage(listener)
    return () => disposable.dispose()
  }
}
