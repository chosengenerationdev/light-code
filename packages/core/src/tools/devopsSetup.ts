import { z } from 'zod'

import type { AtlassianProductId, AtlassianProductStatus, AtlassianSettingsView, AutosysGatewaySettings } from '../agent/protocol.js'
import { ATLASSIAN_PRODUCTS, atlassianProduct } from '../atlassian/products.js'
import type { FormField } from './askUserForm.js'
import type { Tool, ToolExecutionContext, ToolPreview, ToolResult } from './types.js'

/**
 * Setting up a DevOps connection (Confluence, Jira, Bitbucket, Jenkins, AutoSys) with the assistant's help.
 *
 * Asked for: "when user wants to setup a config, he can ask agents help, which can show a form and take inputs from
 * user and setup the config accordingly, if a config is technical agent can handle the technical part, ex: in autosys
 * config, svc:pwd basic string is needed for auth, agent can create that string based on user input".
 *
 * ## Secrets never pass through the model
 *
 * The assistant gathers and proposes the ordinary settings (it may use `ask_user_form` for them), and the approval
 * shows exactly those. Passwords, tokens and client secrets are typed by the user into a password box this tool shows
 * *after* approval; they go straight to secret storage and the result says only that they were stored (invariant 7).
 * Values derived from a secret - the `Basic <base64 of user:password>` header an API gateway wants - are made here, from
 * the approved username and the typed password, by `basicHeaderValue`, so the model never sees or composes them.
 *
 * ## The same save as the panel
 *
 * It saves through the bridge's `saveAtlassianSettings` and tests through `testAtlassian` - the functions the DevOps
 * tab's Save and Test connection call - so nothing set up here can be stored differently from a panel save. Settings
 * it was not asked about are carried over from what is saved now. `edit`, always asks, never in a scheduled run (it
 * changes where credentials go, and needs somebody to type them).
 */

export interface DevopsSetupDeps {
  status(): Promise<Record<AtlassianProductId, AtlassianProductStatus>>
  save(
    product: AtlassianProductId,
    settings: AtlassianSettingsView,
    token: string | undefined,
    gateway?: { settings: AutosysGatewaySettings; clientSecret?: string; passphrase?: string; basicValue?: string },
  ): Promise<string | undefined>
  test(product: AtlassianProductId): Promise<{ ok: boolean; detail: string }>
}

const PRODUCTS = ['confluence', 'jira', 'bitbucket', 'jenkins', 'autosys'] as const

const gatewaySchema = z.object({
  tokenUrl: z.string().optional().describe('Where the gateway issues tokens, e.g. https://gateway.example.com/oauth/token'),
  clientId: z.string().optional().describe('The gateway client id (Apigee: consumer key). Not a secret; the client secret is typed by the user.'),
  scope: z.string().optional().describe('OAuth scope, when the gateway wants one.'),
  grantType: z.string().optional().describe('OAuth grant type. Default client_credentials.'),
  clientAuthentication: z.enum(['body', 'header']).optional().describe('Send the client id and secret as form fields (body, default) or as an HTTP Basic header on the token request.'),
  tokenHeaderName: z.string().optional().describe('The header the gateway token goes in. Default Authorization; must differ from signInHeader when both are sent.'),
  tokenHeaderPrefix: z.string().optional().describe('Put before the token, e.g. "Bearer". Default Bearer.'),
  certFile: z.string().optional().describe('Client certificate file for the gateway, when it needs mutual TLS. Must be outside the workspace.'),
  keyFile: z.string().optional().describe('Its private key file.'),
  pfxFile: z.string().optional().describe('Or a .pfx bundle instead of certificate and key.'),
})

const setupSchema = z.object({
  product: z.enum(PRODUCTS).describe('Which connection: confluence, jira, bitbucket, jenkins or autosys.'),
  action: z.enum(['show', 'setup', 'test']).describe('show: what is set up now (changes nothing; secrets only as stored or not). setup: save settings and ask the user for the secrets. test: Test connection.'),
  site: z.string().optional().describe('The site address (for example https://jira.example.com), and for AutoSys up to the web services prefix (for example https://autosys.example.com:9443/AEWS)'),
  enabled: z.boolean().optional().describe('Switch the connection on (default true when setting up).'),
  readOnly: z.boolean().optional().describe('Give the assistant read access only: the tools that change things on this site are left out.'),
  settings: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'The product\'s own fields by key. confluence: defaultSpace. jira: defaultProject. bitbucket: defaultProject, defaultRepo. ' +
        'jenkins: username, defaultJob. autosys: username, defaultPattern, testJob. Not for passwords or tokens.',
    ),
  caFile: z.string().optional().describe('A certificate authority file, when the site uses an internal CA. Most machines need none.'),
  verifyCertificates: z.boolean().optional().describe('Leave unset. false switches off certificate checks for this site - only when the user asks and understands the risk.'),
  autosysSignIn: z
    .enum(['password', 'gateway', 'gatewayWithPassword', 'gatewayWithHeaderValue'])
    .optional()
    .describe(
      'AutoSys only. password: the username and password as HTTP Basic, straight to AutoSys. gateway: through an API gateway (Apigee) token only. ' +
        'gatewayWithPassword: gateway token, plus the AutoSys username and password in signInHeader. gatewayWithHeaderValue: gateway token, plus a ready-made ' +
        'sign-in value in signInHeader that this tool builds from the username and the password the user types (e.g. "Basic <base64 of svc:pwd>").',
    ),
  signInHeader: z.string().optional().describe('AutoSys through a gateway: the header the AutoSys sign-in goes in. Default Authorization.'),
  headerValueFormat: z
    .enum(['basic', 'base64', 'plain'])
    .optional()
    .describe('For gatewayWithHeaderValue: "Basic <base64(user:password)>" (basic, default), the base64 alone (base64), or user:password as typed (plain).'),
  gateway: gatewaySchema.optional().describe('AutoSys through an API gateway: its non-secret settings.'),
  test: z.boolean().optional().describe('Run Test connection after saving (default true).'),
})

type SetupParams = z.infer<typeof setupSchema>

/** The sign-in value a gateway forwards to AutoSys, made from the username and the password typed into the form. */
export function basicHeaderValue(username: string, password: string, format: 'basic' | 'base64' | 'plain' = 'basic'): string {
  const plain = `${username}:${password}`
  if (format === 'plain') return plain
  const encoded = Buffer.from(plain, 'utf8').toString('base64')
  return format === 'base64' ? encoded : `Basic ${encoded}`
}

/** The secrets a setup will ask the user to type, by form field. */
export function secretsNeeded(params: SetupParams, current: AtlassianProductStatus): FormField[] {
  const info = atlassianProduct(params.product)
  const keep = (stored: boolean): string => (stored ? ' Leave empty to keep the one stored.' : '')
  if (params.product !== 'autosys') {
    return [{ name: 'token', label: info.tokenLabel, type: 'string', secret: true, required: !current.hasToken, description: `${info.tokenHint}${keep(current.hasToken)}` }]
  }
  const mode = params.autosysSignIn ?? (current.gateway?.enabled === true ? 'gateway' : 'password')
  const fields: FormField[] = []
  if (mode === 'password' || mode === 'gatewayWithPassword') {
    fields.push({ name: 'password', label: 'AutoSys password', type: 'string', secret: true, required: !current.hasToken, description: `For the AutoSys user.${keep(current.hasToken)}` })
  }
  if (mode === 'gatewayWithHeaderValue') {
    fields.push({
      name: 'password',
      label: 'AutoSys password',
      type: 'string',
      secret: true,
      required: current.gateway?.hasBasicValue !== true,
      description: `Used once, here, to build the sign-in value the gateway forwards; only that value is stored.${keep(current.gateway?.hasBasicValue === true)}`,
    })
  }
  if (mode !== 'password') {
    const stored = current.gateway?.hasClientSecret === true
    fields.push({ name: 'clientSecret', label: 'Gateway client secret (Apigee: consumer secret)', type: 'string', secret: true, required: !stored, ...(stored ? { description: 'Leave empty to keep the one stored.' } : {}) })
    const certificate = params.gateway?.keyFile ?? params.gateway?.pfxFile ?? current.gateway?.keyFile ?? current.gateway?.pfxFile ?? ''
    if (certificate.trim() !== '') {
      fields.push({ name: 'passphrase', label: 'Passphrase of the client certificate key', type: 'string', secret: true, required: false, description: 'Only if the key or .pfx is protected by one.' })
    }
  }
  return fields
}

function gatewaySettingsFrom(params: SetupParams, current: AtlassianProductStatus): AutosysGatewaySettings {
  const view = current.gateway
  const base: AutosysGatewaySettings = {
    enabled: view?.enabled ?? false,
    tokenUrl: view?.tokenUrl ?? '',
    clientId: view?.clientId ?? '',
    scope: view?.scope ?? '',
    grantType: view?.grantType ?? '',
    clientAuthentication: view?.clientAuthentication ?? 'body',
    tokenPath: view?.tokenPath ?? '',
    expiresInPath: view?.expiresInPath ?? '',
    tokenHeaderName: view?.tokenHeaderName ?? '',
    tokenHeaderPrefix: view?.tokenHeaderPrefix ?? '',
    extraHeaders: view?.extraHeaders ?? '',
    extraTokenParams: view?.extraTokenParams ?? '',
    sendBasic: view?.sendBasic ?? false,
    basicHeaderName: view?.basicHeaderName ?? '',
    certFile: view?.certFile ?? '',
    keyFile: view?.keyFile ?? '',
    pfxFile: view?.pfxFile ?? '',
    useGlobalClientCertificate: view?.useGlobalClientCertificate ?? true,
  }
  const mode = params.autosysSignIn
  const g = params.gateway ?? {}
  return {
    ...base,
    ...(mode !== undefined ? { enabled: mode !== 'password', sendBasic: mode === 'gatewayWithPassword' || mode === 'gatewayWithHeaderValue' } : {}),
    ...(g.tokenUrl !== undefined ? { tokenUrl: g.tokenUrl } : {}),
    ...(g.clientId !== undefined ? { clientId: g.clientId } : {}),
    ...(g.scope !== undefined ? { scope: g.scope } : {}),
    ...(g.grantType !== undefined ? { grantType: g.grantType } : {}),
    ...(g.clientAuthentication !== undefined ? { clientAuthentication: g.clientAuthentication } : {}),
    ...(g.tokenHeaderName !== undefined ? { tokenHeaderName: g.tokenHeaderName } : {}),
    ...(g.tokenHeaderPrefix !== undefined ? { tokenHeaderPrefix: g.tokenHeaderPrefix } : {}),
    ...(g.certFile !== undefined ? { certFile: g.certFile } : {}),
    ...(g.keyFile !== undefined ? { keyFile: g.keyFile } : {}),
    ...(g.pfxFile !== undefined ? { pfxFile: g.pfxFile } : {}),
    ...(params.signInHeader !== undefined ? { basicHeaderName: params.signInHeader } : {}),
  }
}

function settingsFrom(params: SetupParams, current: AtlassianProductStatus): AtlassianSettingsView {
  return {
    enabled: params.enabled ?? true,
    baseUrl: params.site ?? current.settings.baseUrl,
    caFile: params.caFile ?? current.settings.caFile,
    rejectUnauthorized: params.verifyCertificates ?? current.settings.rejectUnauthorized,
    readOnly: params.readOnly ?? current.settings.readOnly === true,
    defaults: { ...current.settings.defaults, ...(params.settings ?? {}) },
  }
}

/** Fields the product does not have, and secrets put where settings go - refused before anything is shown. */
export function settingsProblem(params: SetupParams): string | undefined {
  const info = atlassianProduct(params.product)
  const allowed = info.defaults.map((field) => field.key)
  for (const key of Object.keys(params.settings ?? {})) {
    if (/pass|secret|token|pwd|key$/i.test(key)) return `"${key}" looks like a credential. Credentials are never passed as settings: the user types them into the password box this tool shows after approval.`
    if (!allowed.includes(key)) return `${info.label} has no setting "${key}". Its settings: ${allowed.join(', ')}.`
  }
  if (params.product !== 'autosys' && (params.autosysSignIn !== undefined || params.gateway !== undefined || params.signInHeader !== undefined)) {
    return 'autosysSignIn, gateway and signInHeader are for AutoSys only.'
  }
  const mode = params.autosysSignIn
  if (mode === 'gatewayWithHeaderValue' || mode === 'password' || mode === 'gatewayWithPassword') {
    const username = params.settings?.['username']
    if (username !== undefined && username.includes(':')) return 'An AutoSys username cannot contain ":" - it separates the user from the password in a Basic sign-in.'
  }
  return undefined
}

function describe(status: AtlassianProductStatus, product: AtlassianProductId): string {
  const info = atlassianProduct(product)
  const s = status.settings
  const lines = [
    `${info.label}: ${s.enabled ? 'on' : 'off'}${s.readOnly === true ? ', read access only' : ''}`,
    `  site: ${s.baseUrl === '' ? '(not set)' : s.baseUrl}`,
    ...info.defaults.map((field) => `  ${field.key}: ${s.defaults[field.key] === undefined || s.defaults[field.key] === '' ? '(not set)' : s.defaults[field.key] ?? ''}`),
    `  ${info.tokenLabel.toLowerCase()}: ${status.hasToken ? 'stored' : 'not stored'}`,
  ]
  if (s.caFile !== '') lines.push(`  CA file: ${s.caFile}`)
  if (!s.rejectUnauthorized) lines.push('  certificate checks: OFF')
  const g = status.gateway
  if (product === 'autosys' && g !== undefined) {
    lines.push(
      g.enabled
        ? `  sign-in: through an API gateway (token from ${g.tokenUrl || '(no token URL)'}, client ${g.clientId || '(no client id)'}, client secret ${g.hasClientSecret ? 'stored' : 'not stored'})${g.sendBasic ? `, plus the AutoSys sign-in in ${g.basicHeaderName || 'Authorization'} (${g.hasBasicValue === true ? 'a stored header value' : 'username and password'})` : ''}`
        : '  sign-in: username and password, as HTTP Basic',
    )
  }
  return lines.join('\n')
}

export function createDevopsSetupTool(deps: DevopsSetupDeps): Tool<SetupParams> {
  return {
    name: 'devops_setup',
    group: 'edit',
    description:
      'Set up, show or test a DevOps connection - Confluence, Jira, Bitbucket, Jenkins or AutoSys - for the user. Gather the ordinary ' +
      'settings first (the site address, username, default project...; use ask_user_form for several), then call this with action ' +
      '"setup". NEVER ask for passwords, tokens or secrets yourself: after the user approves, this tool shows them a password box and ' +
      'stores what they type in secure storage - you only learn whether it was stored. It builds technical values itself, such as the ' +
      '"Basic <base64 of user:password>" sign-in an API gateway forwards to AutoSys (autosysSignIn "gatewayWithHeaderValue"). It saves ' +
      'exactly as Settings → DevOps does, then runs Test connection and reports who signed in or why not. Use action "show" first to see ' +
      'what is already set up.',
    parametersSchema: setupSchema,

    async preview(params): Promise<ToolPreview> {
      const info = atlassianProduct(params.product)
      if (params.action === 'show') return { kind: 'text', text: `Show how ${info.label} is set up. Changes nothing; secrets are shown only as stored or not.` }
      if (params.action === 'test') return { kind: 'text', text: `Run Test connection for ${info.label}. Changes nothing.` }
      const problem = settingsProblem(params)
      if (problem !== undefined) return { kind: 'text', text: `This will be refused: ${problem}` }
      const current = (await deps.status())[params.product]
      const next = settingsFrom(params, current)
      const lines = [`Set up ${info.label}:`, `  switched ${next.enabled ? 'on' : 'off'}${next.readOnly === true ? ', read access only' : ''}`, `  site: ${next.baseUrl === '' ? '(not set)' : next.baseUrl}`]
      for (const field of info.defaults) {
        const value = next.defaults[field.key] ?? ''
        const before = current.settings.defaults[field.key] ?? ''
        if (value !== '' || before !== '') lines.push(`  ${field.label}: ${value === '' ? '(not set)' : value}${value !== before ? `   (was ${before === '' ? 'not set' : before})` : ''}`)
      }
      if (next.caFile !== '') lines.push(`  CA file: ${next.caFile}`)
      if (!next.rejectUnauthorized) lines.push('  CERTIFICATE CHECKS SWITCHED OFF for this site: anything on the network path could read and change the traffic, credentials included.')
      if (params.product === 'autosys') {
        const gateway = gatewaySettingsFrom(params, current)
        if (!gateway.enabled) lines.push('  sign-in: username and password, sent to AutoSys as HTTP Basic')
        else {
          lines.push(`  sign-in: API gateway token from ${gateway.tokenUrl || '(no token URL)'} with client ${gateway.clientId || '(no client id)'}, in ${gateway.tokenHeaderName || 'Authorization'}`)
          if (gateway.certFile !== '' || gateway.pfxFile !== '') lines.push(`  gateway client certificate: ${gateway.pfxFile || gateway.certFile}`)
          if (params.autosysSignIn === 'gatewayWithHeaderValue') {
            const format = params.headerValueFormat ?? 'basic'
            lines.push(
              `  plus, in ${gateway.basicHeaderName || 'Authorization'}: ${format === 'basic' ? '"Basic " and the base64 of' : format === 'base64' ? 'the base64 of' : ''} ${next.defaults['username'] || '(username)'}:<password>, built here from the password typed below; only that value is stored`,
            )
          } else if (gateway.sendBasic) lines.push(`  plus the AutoSys username and password in ${gateway.basicHeaderName || 'Authorization'}`)
        }
      }
      const secrets = secretsNeeded(params, current)
      if (secrets.length > 0) {
        lines.push('', 'Then you will be asked, in a password box, for:', ...secrets.map((field) => `  - ${field.label}${field.required === false ? ' (optional)' : ''}`))
        lines.push('They go straight to secure storage. The assistant never sees them.')
      }
      if (params.test !== false) lines.push('', 'Then Test connection runs.')
      return { kind: 'text', text: lines.join('\n') }
    },

    async execute(params, context: ToolExecutionContext): Promise<ToolResult> {
      const info = atlassianProduct(params.product)
      try {
        if (params.action === 'show') return { content: describe((await deps.status())[params.product], params.product) }
        if (params.action === 'test') {
          const result = await deps.test(params.product)
          return { content: `Test connection for ${info.label}: ${result.ok ? 'passed' : 'FAILED'} - ${result.detail}` }
        }

        const problem = settingsProblem(params)
        if (problem !== undefined) return { content: problem, isError: true }
        const current = (await deps.status())[params.product]
        const settings = settingsFrom(params, current)

        const fields = secretsNeeded(params, current)
        let typed: Record<string, string> = {}
        if (fields.length > 0) {
          if (context.requestForm === undefined) return { content: 'Nobody is here to type the credentials, so nothing was set up. Ask the user to run this from the chat.', isError: true }
          const answer = await context.requestForm({
            title: `${info.label} credentials`,
            description: 'Stored in secure storage on this machine, never in the settings file, and never shown to the assistant.',
            fields,
          })
          if (!answer.submitted) return { content: `The user closed the credentials form, so ${info.label} was not set up. Nothing was saved.` }
          typed = Object.fromEntries(Object.entries(answer.values).map(([key, value]) => [key, typeof value === 'string' ? value : '']))
        }
        const given = (name: string): string | undefined => (typed[name] !== undefined && typed[name].length > 0 ? typed[name] : undefined)

        let token: string | undefined
        let gateway: { settings: AutosysGatewaySettings; clientSecret?: string; passphrase?: string; basicValue?: string } | undefined
        const notes: string[] = []
        if (params.product !== 'autosys') token = given('token')
        else {
          const mode = params.autosysSignIn
          const gatewaySettings = gatewaySettingsFrom(params, current)
          const password = given('password')
          let basicValue: string | undefined
          if (mode === 'gatewayWithHeaderValue') {
            if (password !== undefined) {
              const username = (settings.defaults['username'] ?? '').trim()
              if (username === '') return { content: 'gatewayWithHeaderValue needs the AutoSys username (settings.username) to build the sign-in value. Nothing was saved.', isError: true }
              basicValue = basicHeaderValue(username, password, params.headerValueFormat ?? 'basic')
              notes.push(`Built the sign-in value for ${gatewaySettings.basicHeaderName || 'Authorization'} from ${username} and the password typed, and stored it; the password itself was not kept.`)
            }
          } else token = password
          const clientSecret = given('clientSecret')
          const passphrase = given('passphrase')
          gateway = {
            settings: gatewaySettings,
            ...(clientSecret !== undefined ? { clientSecret } : {}),
            ...(passphrase !== undefined ? { passphrase } : {}),
            ...(basicValue !== undefined ? { basicValue } : {}),
          }
        }

        const refused = await deps.save(params.product, settings, token, gateway)
        if (refused !== undefined) return { content: `${info.label} was not set up: ${refused}`, isError: true }

        const stored = fields.filter((field) => given(field.name) !== undefined).map((field) => field.label)
        const kept = fields.filter((field) => given(field.name) === undefined && field.required === false).map((field) => field.label)
        const lines = [`Saved ${info.label}.`, describe((await deps.status())[params.product], params.product)]
        if (stored.length > 0) lines.push(`Stored in secure storage: ${stored.join(', ')}.`)
        if (kept.length > 0) lines.push(`Left as it was: ${kept.join(', ')}.`)
        lines.push(...notes)
        if (params.test !== false) {
          const result = await deps.test(params.product)
          lines.push('', `Test connection: ${result.ok ? 'passed' : 'FAILED'} - ${result.detail}`)
          if (!result.ok) lines.push('Settings → DevOps → Test connection → Details shows every request and answer, credentials masked.')
        }
        return { content: lines.join('\n') }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

/** The products this tool offers, for the handbook and tests. */
export const DEVOPS_SETUP_PRODUCTS: readonly string[] = ATLASSIAN_PRODUCTS.map((product) => product.id)
