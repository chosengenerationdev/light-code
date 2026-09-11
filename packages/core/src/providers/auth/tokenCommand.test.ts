import { describe, expect, it } from 'vitest'

import { TokenCommandAuthStrategy } from './tokenCommand.js'

/**
 * A token fetched by running a command, so a parent process keeps owning the credential.
 *
 * `env:` hands a token over once. This is the half that keeps working: a parent **cannot change a
 * running child's environment**, so a handed-over token cannot be refreshed and a session that
 * outlives it fails every request with no way back short of a restart.
 *
 * These run a real `node -e`, because what is being pinned is the spawning, the parsing and the
 * caching together — and a mocked `spawn` would agree with whatever the code does.
 */
const node = process.execPath

function printing(script: string): string[] {
  return [node, '-e', script]
}

describe('fetching a token by command', () => {
  it('uses the whole of stdout when no tokenPath is given', async () => {
    const strategy = new TokenCommandAuthStrategy({
      command: printing('process.stdout.write("tok-abc\\n")'),
    })
    await expect(strategy.resolveHeaders()).resolves.toEqual({ Authorization: 'Bearer tok-abc' })
  })

  it('reads a dotted path out of JSON, with the reported lifetime', async () => {
    const strategy = new TokenCommandAuthStrategy({
      command: printing('process.stdout.write(JSON.stringify({ data: { access_token: "tok-json", expires_in: 900 } }))'),
      tokenPath: 'data.access_token',
      expiresInPath: 'data.expires_in',
    })
    await expect(strategy.resolveHeaders()).resolves.toEqual({ Authorization: 'Bearer tok-json' })
  })

  it('caches, so a burst of requests spawns one process rather than one each', async () => {
    /*
     * Single-flight, the same property the Apigee strategy needed. Without it every concurrent
     * request starts its own subprocess — on a gateway that rate-limits token issuance that is a
     * self-inflicted outage.
     */
    const strategy = new TokenCommandAuthStrategy({
      command: printing('process.stdout.write("tok-" + Date.now() + "-" + Math.random())'),
    })
    const [first, second, third] = await Promise.all([
      strategy.resolveHeaders(),
      strategy.resolveHeaders(),
      strategy.resolveHeaders(),
    ])
    expect(second).toEqual(first)
    expect(third).toEqual(first)

    // And a later request reuses it rather than fetching again.
    await expect(strategy.resolveHeaders()).resolves.toEqual(first)
  })

  it('fetches again after invalidate, which is what a 401 retry needs', async () => {
    const strategy = new TokenCommandAuthStrategy({
      command: printing('process.stdout.write("tok-" + process.hrtime.bigint())'),
    })
    const first = await strategy.resolveHeaders()
    strategy.invalidate()
    expect(await strategy.resolveHeaders()).not.toEqual(first)
  })

  it('refuses output with whitespace in it rather than sending a banner as a token', async () => {
    /*
     * A token contains no whitespace, so multi-line output means the command printed something
     * else too — a warning, a log line. Saying so beats sending the warning as a bearer token and
     * reporting the 401 that follows.
     */
    const strategy = new TokenCommandAuthStrategy({
      command: printing('process.stdout.write("WARNING: using cache\\ntok-abc\\n")'),
    })
    await expect(strategy.resolveHeaders()).rejects.toThrow(/more than one line/)
  })

  it('says so when the command prints nothing', async () => {
    const strategy = new TokenCommandAuthStrategy({ command: printing('process.exit(0)') })
    await expect(strategy.resolveHeaders()).rejects.toThrow(/printed nothing/)
  })

  it('quotes stderr when the command fails', async () => {
    // The reason is the payload. Losing it to a console nobody is watching makes a broken
    // credential script indistinguishable from a broken gateway.
    const strategy = new TokenCommandAuthStrategy({
      command: printing('process.stderr.write("no kerberos ticket"); process.exit(3)'),
    })
    await expect(strategy.resolveHeaders()).rejects.toThrow(/no kerberos ticket/)
  })

  it('names the program when it does not exist', async () => {
    const strategy = new TokenCommandAuthStrategy({ command: ['lc-definitely-not-a-program'] })
    await expect(strategy.resolveHeaders()).rejects.toThrow(/was not found/)
  })

  it('refuses an empty command at construction rather than at the first request', async () => {
    expect(() => new TokenCommandAuthStrategy({ command: [] })).toThrow(/empty/)
  })

  it('honours a custom header name and prefix', async () => {
    const strategy = new TokenCommandAuthStrategy({
      command: printing('process.stdout.write("tok-abc")'),
      headerName: 'x-api-key',
      headerPrefix: '',
    })
    await expect(strategy.resolveHeaders()).resolves.toEqual({ 'x-api-key': 'tok-abc' })
  })

  it('says what it got when tokenPath finds nothing', async () => {
    const strategy = new TokenCommandAuthStrategy({
      command: printing('process.stdout.write(JSON.stringify({ error: "expired" }))'),
      tokenPath: 'access_token',
    })
    await expect(strategy.resolveHeaders()).rejects.toThrow(/expired/)
  })
})
