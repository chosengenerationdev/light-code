import { describe, expect, it } from 'vitest'

import type { AtlassianProductId, AtlassianProductStatus, AtlassianSettingsView, AutosysGatewaySettings } from '../agent/protocol.js'
import { ALWAYS_ASK_TOOLS } from '../approval/policy.js'
import { NEVER_AVAILABLE_TO_SCHEDULES } from '../schedule/runner.js'
import { createAskUserFormTool } from './askUserForm.js'
import { basicHeaderValue, createDevopsSetupTool, type DevopsSetupDeps } from './devopsSetup.js'
import type { FormAnswer } from './askUserForm.js'
import type { ToolExecutionContext } from './types.js'

const blank = (): AtlassianProductStatus => ({ settings: { enabled: false, baseUrl: '', caFile: '', rejectUnauthorized: true, readOnly: false, defaults: {} }, hasToken: false })

function fakeDeps(): DevopsSetupDeps & { saved: { product: AtlassianProductId; settings: AtlassianSettingsView; token?: string | undefined; gateway?: { settings: AutosysGatewaySettings; clientSecret?: string; passphrase?: string; basicValue?: string } | undefined }[] } {
  const saved: ReturnType<typeof fakeDeps>['saved'] = []
  const status = { confluence: blank(), jira: blank(), bitbucket: blank(), jenkins: blank(), autosys: blank() } as Record<AtlassianProductId, AtlassianProductStatus>
  return {
    saved,
    status: async () => status,
    save: async (product, settings, token, gateway) => {
      saved.push({ product, settings, token, gateway })
      status[product] = { ...status[product], settings, hasToken: token !== undefined }
      return undefined
    },
    test: async () => ({ ok: true, detail: 'Connected as svc-batch.' }),
  }
}

function contextAnswering(values: Record<string, string>, asked: { fields: { name: string; secret?: boolean }[] }[] = []): ToolExecutionContext {
  return {
    requestForm: async (request: { fields: { name: string; secret?: boolean }[] }): Promise<FormAnswer> => {
      asked.push(request)
      return { submitted: true, values }
    },
  } as unknown as ToolExecutionContext
}

describe('devops_setup', () => {
  it('stores a typed token without the model ever seeing it', async () => {
    const deps = fakeDeps()
    const asked: { fields: { name: string; secret?: boolean }[] }[] = []
    const result = await createDevopsSetupTool(deps).execute(
      { product: 'jira', action: 'setup', site: 'https://jira.example.com', settings: { defaultProject: 'ABC' } },
      contextAnswering({ token: 'pat-SECRET-123' }, asked),
    )
    expect(result.isError).toBeUndefined()
    expect(asked[0]?.fields).toEqual([expect.objectContaining({ name: 'token', secret: true })])
    expect(deps.saved[0]).toMatchObject({ product: 'jira', token: 'pat-SECRET-123', settings: { enabled: true, baseUrl: 'https://jira.example.com', defaults: { defaultProject: 'ABC' } } })
    expect(result.content).not.toContain('pat-SECRET-123')
    expect(result.content).toContain('Stored in secure storage: Personal access token')
    expect(result.content).toContain('Test connection: passed')
  })

  it('builds the gateway\'s Basic sign-in value from the username and the typed password, and keeps only that', async () => {
    const deps = fakeDeps()
    const result = await createDevopsSetupTool(deps).execute(
      {
        product: 'autosys',
        action: 'setup',
        site: 'https://autosys.example.com:9443/AEWS',
        settings: { username: 'svc-batch' },
        autosysSignIn: 'gatewayWithHeaderValue',
        signInHeader: 'x-autosys-auth',
        gateway: { tokenUrl: 'https://api.example.com/oauth/token', clientId: 'consumer-key', tokenHeaderName: 'Authorization' },
      },
      contextAnswering({ password: 'p@ss:w0rd', clientSecret: 'consumer-SECRET' }),
    )
    expect(result.isError).toBeUndefined()
    const saved = deps.saved[0]!
    expect(saved.gateway?.basicValue).toBe(`Basic ${Buffer.from('svc-batch:p@ss:w0rd').toString('base64')}`)
    expect(saved.gateway?.clientSecret).toBe('consumer-SECRET')
    expect(saved.gateway?.settings).toMatchObject({ enabled: true, sendBasic: true, basicHeaderName: 'x-autosys-auth', tokenUrl: 'https://api.example.com/oauth/token', clientId: 'consumer-key' })
    // The password itself is not stored as the AutoSys token in this mode.
    expect(saved.token).toBeUndefined()
    for (const secret of ['p@ss:w0rd', 'consumer-SECRET', Buffer.from('svc-batch:p@ss:w0rd').toString('base64')]) expect(result.content).not.toContain(secret)
  })

  it('refuses a credential passed as a setting, before anything is asked or saved', async () => {
    const deps = fakeDeps()
    const asked: { fields: { name: string }[] }[] = []
    const result = await createDevopsSetupTool(deps).execute({ product: 'autosys', action: 'setup', settings: { username: 'svc', password: 'oops' } }, contextAnswering({}, asked))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('looks like a credential')
    expect(asked).toEqual([])
    expect(deps.saved).toEqual([])
  })

  it('refuses a setting the product does not have', async () => {
    const result = await createDevopsSetupTool(fakeDeps()).execute({ product: 'jira', action: 'setup', settings: { defaultSpace: 'X' } }, contextAnswering({}))
    expect(result.content).toContain('Jira has no setting "defaultSpace"')
  })

  it('saves nothing when the credentials form is closed', async () => {
    const deps = fakeDeps()
    const context = { requestForm: async (): Promise<FormAnswer> => ({ submitted: false, values: {} }) } as unknown as ToolExecutionContext
    const result = await createDevopsSetupTool(deps).execute({ product: 'jenkins', action: 'setup', site: 'https://ci.example.com' }, context)
    expect(result.content).toContain('Nothing was saved')
    expect(deps.saved).toEqual([])
  })

  it('shows in the approval what will be saved, what will be asked for, and the header it will build', async () => {
    const preview = await createDevopsSetupTool(fakeDeps()).preview!(
      { product: 'autosys', action: 'setup', site: 'https://a.example.com/AEWS', settings: { username: 'svc-batch' }, autosysSignIn: 'gatewayWithHeaderValue', gateway: { tokenUrl: 'https://t.example.com/token', clientId: 'ck', tokenHeaderName: 'x-apigee-token' } },
      {} as ToolExecutionContext,
    )
    const text = (preview as { text: string }).text
    expect(text).toContain('svc-batch:<password>')
    expect(text).toContain('Gateway client secret')
    expect(text).toContain('The assistant never sees them')
  })

  it('always asks and never runs unattended', () => {
    expect(ALWAYS_ASK_TOOLS).toContain('devops_setup')
    expect(NEVER_AVAILABLE_TO_SCHEDULES).toContain('devops_setup')
  })

  it('makes the three header formats', () => {
    expect(basicHeaderValue('svc', 'pwd')).toBe('Basic c3ZjOnB3ZA==')
    expect(basicHeaderValue('svc', 'pwd', 'base64')).toBe('c3ZjOnB3ZA==')
    expect(basicHeaderValue('svc', 'pwd', 'plain')).toBe('svc:pwd')
  })
})

describe('a secret field in ask_user_form', () => {
  it('tells the model only whether it was entered', async () => {
    const result = await createAskUserFormTool().execute(
      { title: 'Sign in', fields: [{ name: 'user', label: 'User', type: 'string' }, { name: 'pwd', label: 'Password', type: 'string', secret: true }] },
      contextAnswering({ user: 'svc', pwd: 'hunter2' }),
    )
    expect(result.content).toContain('svc')
    expect(result.content).not.toContain('hunter2')
    expect(result.content).toContain('(entered - not shown)')
  })
})
