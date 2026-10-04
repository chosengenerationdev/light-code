import { describe, expect, it, vi } from 'vitest'
import { describeShareFailure, sendWithRetry } from './shareWithSun.js'

vi.mock('vscode', () => ({}))
vi.mock('./platform/secrets.js', () => ({}))


const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

describe('sharing keys with Fire Code', () => {
  it('retries a connection Windows refused while Fire Code was between callers', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(failure('EPERM'))
      .mockRejectedValueOnce(failure('EPIPE'))
      .mockResolvedValueOnce({ ok: true, stored: ['a'] })
    await expect(sendWithRetry('pipe', {}, send, [0, 0, 0])).resolves.toEqual({ ok: true, stored: ['a'] })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('gives up after the last retry and reports the real code', async () => {
    const send = vi.fn().mockRejectedValue(failure('EPERM'))
    await expect(sendWithRetry('pipe', {}, send, [0, 0])).rejects.toMatchObject({ code: 'EPERM' })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('does not retry when Fire Code is simply not running', async () => {
    const send = vi.fn().mockRejectedValue(failure('ENOENT'))
    await expect(sendWithRetry('pipe', {}, send, [0, 0])).rejects.toMatchObject({ code: 'ENOENT' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('names what to do instead of an errno', () => {
    expect(describeShareFailure(failure('ENOENT'))).toContain('not running')
    expect(describeShareFailure(failure('EPERM'))).toContain('administrator')
    expect(describeShareFailure(failure('EPERM'))).toContain('Credentials page')
    expect(describeShareFailure(failure('EPIPE'))).toContain('Credentials page')
    expect(describeShareFailure(new Error('boom'))).toContain('boom')
  })
})
