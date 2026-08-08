import type { HttpClient } from '../platform/http.js'
import { ApigeeMtlsAuthStrategy } from './auth/apigeeMtls.js'
import { type AuthStrategyContext, createAuthStrategy, createCertLoader } from './auth/factory.js'
import { listModels } from './models.js'
import type { ProviderProfile } from './types.js'

export type TestStepName = 'certificates' | 'token' | 'models'

export interface TestStepResult {
  step: TestStepName
  status: 'ok' | 'failed' | 'skipped'
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
      steps.push({ step: 'token', status: 'ok', detail: 'Credential resolved from secure storage.' })
    } catch (error) {
      steps.push({ step: 'token', status: 'failed', detail: messageOf(error) })
      steps.push({ step: 'models', status: 'skipped', detail: 'Not attempted — no credential.' })
      return finish()
    }
  }

  const result = await listModels(http, profile, auth, signal)
  if (result.ids.length > 0) {
    steps.push({ step: 'models', status: 'ok', detail: `Gateway returned ${result.ids.length} model(s).` })
  } else {
    // A gateway that does not publish a catalogue is normal and not a failure — the model
    // id is typed by hand in that case (§9).
    steps.push({ step: 'models', status: 'failed', detail: result.warning ?? 'No models returned.' })
  }
  return finish()
}
