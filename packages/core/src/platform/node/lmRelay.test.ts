import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostModelProvider, listHostModels, testHostModels, type HostLanguageModels } from '../../providers/hostModels.js'
import type { StreamChunk } from '../../providers/types.js'
import { createRelayLanguageModels, NO_VSCODE_WINDOW, startLmRelay } from './lmRelay.js'

/**
 * GitHub Copilot from Fire Code and the Node host, through a VS Code window. Driven over a real pipe:
 * every claim here is about two processes and a socket, which no fake of the socket would test.
 */

const fakeVsCode = (seen: unknown[] = []): HostLanguageModels => ({
  label: 'VS Code',
  async listModels() {
    return [
      { id: 'gpt-4.1', name: 'GPT-4.1', vendor: 'copilot', maxInputTokens: 111_000 },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', vendor: 'copilot', maxInputTokens: 80_000 },
      { id: 'local', name: 'A local model', vendor: 'ollama' },
    ]
  },
  async *chat(request) {
    seen.push(request)
    yield { type: 'text', text: 'Hello ' }
    yield { type: 'text', text: 'there' }
    if (request.tools !== undefined) yield { type: 'toolCall', toolCall: { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' } }
  },
})

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

function serve(models: HostLanguageModels): { dir: string; pipe: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lm-relay-'))
  const relay = startLmRelay(models, { dir })
  disposers.push(() => relay.dispose())
  return { dir, pipe: relay.pipe }
}

async function waitForFile(dir: string): Promise<void> {
  for (let i = 0; i < 100 && readdirSync(dir).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('the Copilot relay', () => {
  it('lists VS Code models and streams a chat, tool calls included, over the pipe', async () => {
    const seen: unknown[] = []
    const { dir } = serve(fakeVsCode(seen))
    await waitForFile(dir)
    const relayed = createRelayLanguageModels({ dir })

    const listed = await listHostModels(relayed)
    expect(listed.ids).toEqual(['claude-sonnet-4', 'gpt-4.1', 'local'])
    expect(listed.windows).toEqual({ 'gpt-4.1': 111_000, 'claude-sonnet-4': 80_000 })

    const chunks: StreamChunk[] = []
    const provider = new HostModelProvider(relayed, 'gpt-4.1')
    for await (const chunk of provider.streamChat([{ role: 'user', content: 'hi' }], { tools: [{ name: 'read_file', description: 'Read', parameters: {} }] })) {
      chunks.push(chunk)
    }
    expect(chunks).toEqual([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'there' },
      { type: 'toolCall', toolCall: { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' } },
      { type: 'done' },
    ])
    expect(seen[0]).toMatchObject({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }] })
  })

  it('answers nothing to a caller without the token', async () => {
    const { dir, pipe } = serve(fakeVsCode())
    await waitForFile(dir)
    const reply = await new Promise<string>((resolve) => {
      let text = ''
      const socket = connect(pipe, () => socket.write(`${JSON.stringify({ token: 'guess', op: 'list' })}\n`))
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => (text += chunk))
      socket.on('close', () => resolve(text))
      socket.on('error', () => resolve(text))
    })
    expect(reply).toBe('')
  })

  it('records the pipe and token only in the user-private file, and removes it on close', async () => {
    const { dir } = serve(fakeVsCode())
    await waitForFile(dir)
    const [file] = readdirSync(dir)
    expect(JSON.parse(readFileSync(path.join(dir, file!), 'utf8'))).toMatchObject({ pipe: expect.any(String), token: expect.stringMatching(/^[0-9a-f]{64}$/) })
    disposers.pop()?.()
    expect(readdirSync(dir)).toEqual([])
  })

  it('says to open VS Code when no window is serving, and clears a dead window left behind', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lm-relay-'))
    writeFileSync(path.join(dir, '99999.json'), JSON.stringify({ pipe: process.platform === 'win32' ? '\\\\.\\pipe\\light-code-lm-gone' : path.join(dir, 'gone.sock'), token: 'x', pid: 99999, startedAt: 0 }))
    const relayed = createRelayLanguageModels({ dir })
    expect(await listHostModels(relayed)).toMatchObject({ ids: [], warning: NO_VSCODE_WINDOW })
    expect(readdirSync(dir)).toEqual([])
  })

  it('carries an error from VS Code, such as consent being refused, as the chat error', async () => {
    const { dir } = serve({
      ...fakeVsCode(),
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('Light Code may not use GitHub Copilot: the permission was refused in VS Code.')
      },
    })
    await waitForFile(dir)
    const chunks: StreamChunk[] = []
    for await (const chunk of new HostModelProvider(createRelayLanguageModels({ dir }), 'gpt-4.1').streamChat([{ role: 'user', content: 'hi' }])) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'error', error: expect.stringContaining('permission was refused') }])
  })
})

describe('a Copilot profile where VS Code cannot be reached', () => {
  it('fails with a sentence saying where Copilot comes from, in chat and in Test Connection', async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of new HostModelProvider(undefined, 'gpt-4.1').streamChat([{ role: 'user', content: 'hi' }])) chunks.push(chunk)
    expect(chunks[0]).toMatchObject({ type: 'error', error: expect.stringContaining('through VS Code') })
    const test = await testHostModels(undefined, 'gpt-4.1')
    expect(test.ok).toBe(false)
  })

  it('Test Connection names a model VS Code does not offer', async () => {
    const test = await testHostModels(fakeVsCode(), 'gpt-9')
    expect(test.ok).toBe(false)
    expect(test.steps.at(-1)?.detail).toContain('not "gpt-9"')
    expect((await testHostModels(fakeVsCode(), 'gpt-4.1')).ok).toBe(true)
  })
})
