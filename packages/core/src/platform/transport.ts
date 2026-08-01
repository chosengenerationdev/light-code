/**
 * Bidirectional message passing between host and UI. The webview implementation
 * wraps `vscode.Webview.postMessage`/`onDidReceiveMessage`; the Node-host implementation
 * (Phase 10) will wrap a WebSocket. Secrets never cross this boundary toward the UI —
 * see CLAUDE.md invariant 7.
 */
export interface Transport {
  post(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
}
