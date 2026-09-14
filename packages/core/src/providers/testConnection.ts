import type { HttpClient } from '../platform/http.js'
import { ApigeeMtlsAuthStrategy } from './auth/apigeeMtls.js'
import { type AuthStrategyContext, createAuthStrategy, createCertLoader } from './auth/factory.js'
import { listModels } from './models.js'
import type { ProviderProfile } from './types.js'

export type TestStepName = 'certificates' | 'token' | 'models'

export interface TestStepResult {
  step: TestStepName
  /**
   * `note` is a step that did not succeed and is not a problem.
   *
   * Added because the catalogue step had no way to say so: plenty of gateways serve chat
   * completions and no `/models` at all, §9 has always said the dropdown must never be a hard
   * dependency, and the code nevertheless reported a red failure with a comment beside it saying
   * this was normal. A connection that works must not be shown as broken.
   */
  status: 'ok' | 'failed' | 'skipped' | 'note'
  /** One line, safe to show verbatim. Never contains a token or key (§15). */
  detail: string
}

export interface TestConnectionResult {
  ok: boolean
  steps: TestStepResult[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * How long the whole check may take before it reports rather than waits.
 *
 * Reported from real use: Test Connection sat on "Testing…" for ever against a gateway that
 * answered chat completions perfectly well. Two causes, and this is the one that made it
 * *unreportable* — the signal parameter below is optional and the one caller never passed one, so
 * there was no deadline anywhere and a host that drops packets rather than refusing them left the
 * request waiting on the kernel. §14 states the rule this broke: a request with no deadline cannot
 * fail, and something that cannot fail cannot report.
 *
 * Defaulted here rather than required of the caller, because "the caller must remember" is how it
 * came to be missing. A caller with its own signal still wins.
 */
export const TEST_CONNECTION_TIMEOUT_MS = 20_000

/**
 * Runs load-certs → get-token → list-models and reports **which step failed** (§10).
 * The point is diagnosis: "the handshake worked but the token endpoint 401'd" is a
 * completely different fix from "the CA is not trusted", and a single pass/fail hides that.
 *
 * Each step short-circuits the rest, because a later step cannot succeed without it.
 */
export async function testConnection(
  profile: ProviderProfile,
  context: AuthStrategyContext,
  http: HttpClient,
  signal?: AbortSignal,
): Promise<TestConnectionResult> {
  const steps: TestStepResult[] = []
  const finish = (): TestConnectionResult => ({ ok: steps.every((step) => step.status !== 'failed'), steps })

  /*
   * A deadline of its own, so no caller can leave the button spinning by forgetting one.
   * Composed with the caller's signal rather than replacing it: cancelling must still work.
   */
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), TEST_CONNECTION_TIMEOUT_MS)
  const onOuterAbort = (): void => deadline.abort()
  signal?.addEventListener('abort', onOuterAbort)
  const bounded = deadline.signal
  const release = (): void => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }

  if (profile.auth.type === 'apigeeMtls') {
    try {
      // Expiry is reported through a callback, so it is intercepted here to fold into the
      // step's detail line rather than only firing whatever notification the host wired up.
      let expiryNote = ''
      const loaded = await createCertLoader(profile.auth, {
        ...context,
        onExpiryWarning: (warning) => {
          expiryNote = ` ${warning.message}`
          context.onExpiryWarning?.(warning)
        },
      })()
      steps.push({
        step: 'certificates',
        status: 'ok',
        detail: `Loaded ${loaded?.pfx !== undefined ? 'PFX bundle' : 'client certificate and key'}.${expiryNote}`,
      })
    } catch (error) {
      release()
      steps.push({ step: 'certificates', status: 'failed', detail: messageOf(error) })
      steps.push({ step: 'token', status: 'skipped', detail: 'Not attempted — certificates failed to load.' })
      steps.push({ step: 'models', status: 'skipped', detail: 'Not attempted — certificates failed to load.' })
      return finish()
    }
  } else {
    steps.push({
      step: 'certificates',
      status: 'skipped',
      detail: 'This profile does not use mutual TLS.',
    })
  }

  const auth = createAuthStrategy(profile.auth, context)

  if (auth instanceof ApigeeMtlsAuthStrategy) {
    try {
      // resolveHeaders performs the handshake and the client_credentials grant. Only the
      // fact of success is reported — never the token itself.
      await auth.resolveHeaders()
      steps.push({ step: 'token', status: 'ok', detail: 'Access token acquired.' })
    } catch (error) {
      steps.push({ step: 'token', status: 'failed', detail: messageOf(error) })
      steps.push({ step: 'models', status: 'skipped', detail: 'Not attempted — no access token.' })
      return finish()
    }
  } else {
    try {
      await auth.resolveHeaders()
      /*
       * Says where the credential came from, because the three sources fail in different places
       * and "resolved from secure storage" is simply untrue for two of them — which makes a
       * passing test unhelpful for the person whose script is the thing they want to check.
       */
      steps.push({
        step: 'token',
        status: 'ok',
        detail:
          profile.auth.type === 'tokenCommand'
            ? 'The token command ran and returned a token.'
            : profile.auth.type === 'apiKey' && profile.auth.apiKeyRef.startsWith('env:')
              ? `Key read from ${profile.auth.apiKeyRef.slice('env:'.length)}.`
              : 'Credential resolved from secure storage.',
      })
    } catch (error) {
      release()
      steps.push({ step: 'token', status: 'failed', detail: messageOf(error) })
      steps.push({ step: 'models', status: 'skipped', detail: 'Not attempted — no credential.' })
      return finish()
    }
  }

  const result = await listModels(http, profile, auth, bounded)
  release()
  if (result.ids.length > 0) {
    steps.push({ step: 'models', status: 'ok', detail: `Gateway returned ${result.ids.length} model(s).` })
  } else if (deadline.signal.aborted && signal?.aborted !== true) {
    /*
     * Named as a timeout rather than as "no models". The distinction is the whole value of this
     * panel: a catalogue this gateway does not serve is nothing to fix, and a request that never
     * came back is the only real finding here.
     */
    steps.push({
      step: 'models',
      status: 'failed',
      detail: `No response within ${String(Math.round(TEST_CONNECTION_TIMEOUT_MS / 1000))}s. The address resolved and the connection was accepted, but nothing came back — check the base URL path and whether anything is filtering this route.`,
    })
  } else {
    /*
     * Not a failure, and the comment here used to say so while the code reported red anyway.
     *
     * Many gateways serve chat completions and no `/models`; §9 has said since Phase 6 that the
     * dropdown must never be a hard dependency, and a connection that works must not be presented
     * as broken. Type the model id by hand.
     */
    steps.push({
      step: 'models',
      status: 'note',
      detail: `${result.warning ?? 'No catalogue returned.'} This does not by itself mean the connection is broken — plenty of gateways serve chat completions without publishing /models. Type the model id by hand.`,
    })
  }
  return finish()
}
