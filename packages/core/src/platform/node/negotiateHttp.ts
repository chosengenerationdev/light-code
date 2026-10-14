import { spawn } from 'node:child_process'

import type { NegotiateRequest, RawResponse } from '../../tools/http.js'

/**
 * One HTTP request with Kerberos/NTLM ("Negotiate") as the signed-in Windows user, for `http_request`.
 *
 * Node has no Negotiate: it needs SSPI, which only the operating system has. .NET's HttpClient with
 * `UseDefaultCredentials` does it - SPNEGO, the NTLM handshake on one connection, Kerberos tickets from
 * the logon session - and Windows PowerShell 5.1 is on every Windows machine. So the request goes there.
 * This is the one place outbound traffic leaves outside `HttpClient` (invariant 2), recorded in
 * CLAUDE.md; it exists because the capability cannot be had any other way.
 *
 * Model-written text never reaches a command line (§16): the request is JSON on stdin, the script is
 * fixed and pure ASCII (Windows PowerShell reads a BOM-less script as ANSI - §12c), and the answer comes
 * back behind a marker so nothing the .NET stack prints can be mistaken for it. Server trust is the
 * Windows certificate store; a client certificate must be a .pfx.
 */
export const NEGOTIATE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$req = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  'try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]3072 -bor [Net.SecurityProtocolType]12288 } catch { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]3072 }',
  'Add-Type -AssemblyName System.Net.Http',
  '$handler = New-Object System.Net.Http.HttpClientHandler',
  '$handler.UseDefaultCredentials = $true',
  '$handler.PreAuthenticate = $true',
  // Settings -> Network's proxy when one is set, with its login; otherwise Windows' own proxy settings.
  'if ($req.proxy) {',
  '  $proxy = New-Object System.Net.WebProxy([string]$req.proxy)',
  '  if ($req.proxyUser) { $proxy.Credentials = New-Object System.Net.NetworkCredential([string]$req.proxyUser, [string]$req.proxyPassword) } else { $proxy.UseDefaultCredentials = $true }',
  '  $handler.Proxy = $proxy',
  '  $handler.UseProxy = $true',
  '}',
  'if ($req.pfxFile) {',
  '  $flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet',
  '  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($req.pfxFile, [string]$req.passphrase, $flags)',
  '  [void]$handler.ClientCertificates.Add($cert)',
  '}',
  '$client = New-Object System.Net.Http.HttpClient($handler)',
  '$client.Timeout = [TimeSpan]::FromSeconds([double]$req.timeoutSec)',
  '$message = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($req.method)), [string]$req.url)',
  '$contentType = $null',
  'foreach ($p in $req.headers.PSObject.Properties) {',
  "  if ($p.Name -ieq 'Content-Type') { $contentType = [string]$p.Value; continue }",
  '  [void]$message.Headers.TryAddWithoutValidation($p.Name, [string]$p.Value)',
  '}',
  'if ($req.body -ne $null) {',
  '  $message.Content = New-Object System.Net.Http.StringContent([string]$req.body, [Text.Encoding]::UTF8)',
  '  if ($contentType) { $message.Content.Headers.Remove("Content-Type") | Out-Null; [void]$message.Content.Headers.TryAddWithoutValidation("Content-Type", $contentType) }',
  '}',
  'try {',
  '  $response = $client.SendAsync($message).GetAwaiter().GetResult()',
  '  $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()',
  '  $headers = @{}',
  '  foreach ($h in $response.Headers) { $headers[$h.Key] = ($h.Value -join ", ") }',
  '  foreach ($h in $response.Content.Headers) { $headers[$h.Key] = ($h.Value -join ", ") }',
  '  $out = @{ status = [int]$response.StatusCode; headers = $headers; body = [Convert]::ToBase64String($bytes) }',
  '} catch {',
  '  $e = $_.Exception',
  '  $text = $e.Message',
  '  while ($e.InnerException) { $e = $e.InnerException; $text = $text + " -> " + $e.Message }',
  '  $out = @{ error = $text }',
  '}',
  "Write-Output ('LC-HTTP:' + ($out | ConvertTo-Json -Compress -Depth 5))",
].join('\r\n')

export function negotiateRequest(request: NegotiateRequest, signal?: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(NEGOTIATE_SCRIPT, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), (request.timeoutSec + 30) * 1000)
    signal?.addEventListener('abort', () => child.kill(), { once: true })
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`Could not start Windows PowerShell for the negotiate request: ${error.message}`))
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.split(/\r?\n/).find((l) => l.startsWith('LC-HTTP:'))
      if (line === undefined) {
        reject(new Error(`The negotiate request gave no answer${err.trim().length > 0 ? `: ${err.trim().split(/\r?\n/)[0] ?? ''}` : '.'}`))
        return
      }
      const answer = JSON.parse(line.slice('LC-HTTP:'.length)) as { status?: number; headers?: Record<string, string>; body?: string; error?: string }
      if (answer.error !== undefined) {
        reject(new Error(`Could not reach ${new URL(request.url).host} with negotiate: ${answer.error}`))
        return
      }
      resolve({ status: answer.status ?? 0, headers: answer.headers ?? {}, body: Buffer.from(answer.body ?? '', 'base64') })
    })
    child.stdin.end(JSON.stringify(request))
  })
}
