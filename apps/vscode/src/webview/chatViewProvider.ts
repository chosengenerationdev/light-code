import crypto from 'node:crypto'
import * as vscode from 'vscode'
import type { WebviewTransport } from '../platform/transport.js'

export class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly transport: WebviewTransport,
    /** Creates the bridge if this is the first thing to need it. Returns it either way. */
    private readonly ensureBridge: () => { resync: () => void },
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    }
    webviewView.webview.html = renderHtml(webviewView.webview, this.context.extensionUri)

    /*
     * The view attaches to the bridge rather than owning it.
     *
     * Owning it meant the schedule timer died with the panel — see `WebviewTransport`. The
     * bridge now lives as long as the extension does, so a torn-down view detaches and a new
     * one attaches and asks for the transcript back.
     */
    this.transport.attach(webviewView.webview)
    const bridge = this.ensureBridge()
    bridge.resync()

    webviewView.onDidDispose(() => this.transport.detach())
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'))
  const nonce = crypto.randomBytes(16).toString('base64')

  // No `style-src` entry is needed: React's `style` prop sets properties via the
  // CSSOM directly rather than through inline `style=""` attributes or `<style>`
  // tags, so it isn't subject to CSP at all. No remote assets, ever (invariant 4).
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "img-src 'none'",
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Light Code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`
}
