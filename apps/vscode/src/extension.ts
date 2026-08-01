import * as vscode from 'vscode'

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand('lightCode.openPanel', () => {
    const panel = vscode.window.createWebviewPanel(
      'lightCode.panel',
      'Light Code',
      vscode.ViewColumn.Beside,
      { enableScripts: false },
    )
    panel.webview.html = getHtml(panel.webview)
  })

  context.subscriptions.push(disposable)
}

export function deactivate(): void {}

function getHtml(webview: vscode.Webview): string {
  const csp = `default-src 'none'; style-src ${webview.cspSource};`
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Light Code</title>
</head>
<body>
</body>
</html>`
}
