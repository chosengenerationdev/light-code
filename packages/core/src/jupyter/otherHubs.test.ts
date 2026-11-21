import { describe, expect, it } from 'vitest'
import type { ToolExecutionContext } from '../tools/types.js'
import type { KernelSession, RunOutput } from './kernel.js'
import { createHubTools, type OtherHub } from './tools.js'

/*
 * Asked for: "can agent in 1st code base read about the libraries or files in 2nd named server?" Files were
 * readable already (hub_browse); hub_run and hub_inspect now take `hub`, so the other server's own kernel answers.
 */
function fakeKernel(ran: string[]): KernelSession {
  return {
    run: async (code: string): Promise<RunOutput> => {
      ran.push(code)
      return { text: 'acme_risk==2.4.1\n', freshKernel: false, kernelName: 'python3' }
    },
  } as unknown as KernelSession
}

const context = {} as ToolExecutionContext

describe("another codebase's hub", () => {
  it('inspects libraries in that server\'s kernel, and says where in the approval', async () => {
    const ran: string[] = []
    const other: OtherHub = { name: 'risk-models', label: "risk-models's hub (ann@hub, server gpu)", kernel: fakeKernel(ran) }
    const tools = createHubTools(undefined, [other])
    expect(tools.map((tool) => tool.name)).toEqual(['hub_run', 'hub_inspect'])
    const inspect = tools.find((tool) => tool.name === 'hub_inspect')!
    expect(inspect.description).toContain('"risk-models"')

    const preview = await inspect.preview!({ packages: 'acme', hub: 'Risk-Models' }, context)
    expect(preview).toMatchObject({ kind: 'command', cwd: expect.stringContaining('codebase "risk-models"') })
    const result = await inspect.execute({ packages: 'acme', hub: 'risk-models' }, context)
    expect(result.content).toContain('acme_risk==2.4.1')
    expect(result.content).toContain('server gpu')
    expect(ran).toHaveLength(1)
  })

  it('names the hubs there are when asked for one that does not exist, or for none without a hub of its own', async () => {
    const tools = createHubTools(undefined, [{ name: 'risk-models', label: 'x', kernel: fakeKernel([]) }])
    const inspect = tools.find((tool) => tool.name === 'hub_inspect')!
    expect((await inspect.execute({ packages: '' }, context)).content).toMatch(/Say which hub with "hub": "risk-models"/)
    expect((await inspect.execute({ packages: '', hub: 'nope' }, context)).content).toMatch(/No hub called "nope".*"risk-models"/)
  })

  it('runs code and shell there, from a folder on that server, but not a local file', async () => {
    const ran: string[] = []
    const run = createHubTools(undefined, [{ name: 'risk-models', label: 'x', kernel: fakeKernel(ran) }]).find((tool) => tool.name === 'hub_run')!
    expect((await run.execute({ shell: 'python check.py', cwd: 'projects/risk', hub: 'risk-models' }, context)).isError).toBeUndefined()
    expect(ran[0]).toContain('"projects/risk"')
    expect((await run.execute({ file: 'a.py', hub: 'risk-models' }, context)).content).toMatch(/use shell instead/)
    expect((await run.execute({ shell: 'ls', cwd: '../etc', hub: 'risk-models' }, context)).content).toMatch(/without "\.\."/)
  })
})
