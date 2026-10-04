import type { HttpClient, TlsOptions } from '../platform/http.js'
import type { DiagnosticsProvider } from '../lsp/manager.js'
import { JupyterClient } from './client.js'
import { KernelSession } from './kernel.js'
import { HubMirror } from './mirror.js'
import type { HubRuntime } from './tools.js'
import type { JupyterHubSpec } from './spec.js'

/** Everything a session needs for a JupyterHub codebase, built from its spec. */
export function createHubRuntime(options: {
  spec: JupyterHubSpec
  /** The local copy: the session's workspace. */
  root: string
  http: HttpClient
  token: () => Promise<string | undefined>
  tls: () => Promise<TlsOptions | undefined>
}): HubRuntime {
  const client = new JupyterClient(options.http, options.spec, options.token, options.tls)
  let host = options.spec.url
  try {
    host = new URL(options.spec.url).host
  } catch {
    // Validated by the schema; the raw text is a fine label either way.
  }
  return {
    spec: options.spec,
    mirror: new HubMirror(client, options.spec, options.root),
    kernel: new KernelSession(client, options.spec.kernel),
    label: `JupyterHub ${host} (${options.spec.user})`,
  }
}

/** What the model is told about a JupyterHub codebase, every turn. */
export function hubGuidance(runtime: HubRuntime): string {
  const folders = runtime.mirror.folders.map((f) => `- ${f.local}/ is ${f.remote.length > 0 ? f.remote : "the server's top folder"} on the hub`)
  return [
    `## This workspace is a copy of folders on ${runtime.label}`,
    ...folders,
    'Read and search the files here as usual. Your edits are saved back to the hub as soon as they are made (the edit',
    'result says so); a save is refused when the file changed on the hub meanwhile - then use hub_sync "hub_version" and',
    'ask the user how to merge. Changes made on the hub are fetched every few minutes, or now with hub_sync "pull".',
    'Some libraries exist ONLY on the hub. Run scripts, tests and Python there with hub_run, never with execute_command;',
    'look up a hub library\'s API with hub_inspect rather than guessing. The local language server cannot see those',
    'libraries, so "import could not be resolved" is not reported here - it says nothing about the hub.',
  ].join('\n')
}

/**
 * Hides the one diagnostic that is always wrong in a hub copy: an import of a library that is
 * installed on the hub and not on this machine. Everything else is passed through.
 */
export function withoutMissingImports(provider: DiagnosticsProvider): DiagnosticsProvider {
  const missing = /could not be resolved|No module named|unresolved import|reportMissingImports|reportMissingModuleSource|Cannot find module/i
  return {
    async diagnose(file) {
      const result = await provider.diagnose(file)
      if (result === undefined) return undefined
      return { ...result, diagnostics: result.diagnostics.filter((d) => !missing.test(`${d.message} ${d.code ?? ''}`)) }
    },
    status: () => provider.status(),
    dispose: () => provider.dispose(),
  }
}
