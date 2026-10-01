import type { AutosysGatewaySettings, AutosysGatewayView } from '../agent/protocol.js'
import type { autosysAuthSchema } from '../config/schema.js'
import type { z } from 'zod'
import type { ConnectionAuth } from './rest.js'

/**
 * AutoSys behind an API gateway: the form's view of `autosys.auth`, and back.
 *
 * Kept out of the bridge so both directions can be tested, and so the stored block and the panel
 * cannot disagree about a field — the panel renders this view and the host saves only what
 * `gatewayFromSettings` returns.
 */

export type AutosysAuth = z.infer<typeof autosysAuthSchema>

/**
 * The gateway's token plus AutoSys's own Basic sign-in, for a gateway that checks its token and
 * passes the username and password through to AutoSys. Basic is added after the token headers;
 * `gatewayFromSettings` has already refused the two sharing a header.
 */
export function withBasicCredentials(
  auth: ConnectionAuth,
  headerName: string,
  username: string,
  password: string,
): ConnectionAuth {
  const basic = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
  return {
    resolveHeaders: async () => ({ ...(await auth.resolveHeaders()), [headerName]: basic }),
    onUnauthorized: () => auth.onUnauthorized(),
  }
}

/** Secret storage keys. Namespaced, so clearing AutoSys clears these too. */
export const AUTOSYS_CLIENT_SECRET_REF = 'autosys:clientSecret'
export const AUTOSYS_PASSPHRASE_REF = 'autosys:certPassphrase'

function linesFrom(map: Record<string, string> | undefined, separator: string): string {
  return Object.entries(map ?? {})
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n')
}

export function gatewayView(auth: AutosysAuth | undefined, hasClientSecret: boolean, hasPassphrase: boolean): AutosysGatewayView {
  return {
    enabled: auth?.type === 'apigee',
    tokenUrl: auth?.tokenUrl ?? '',
    clientId: auth?.clientId ?? '',
    scope: auth?.scope ?? '',
    grantType: auth?.grantType ?? '',
    clientAuthentication: auth?.clientAuthentication ?? 'body',
    tokenPath: auth?.tokenPath ?? '',
    expiresInPath: auth?.expiresInPath ?? '',
    tokenHeaderName: auth?.tokenHeaderName ?? '',
    tokenHeaderPrefix: auth?.tokenHeaderPrefix ?? '',
    extraHeaders: linesFrom(auth?.extraHeaders, ': '),
    extraTokenParams: linesFrom(auth?.extraTokenParams, '='),
    sendBasic: auth?.sendBasic === true,
    basicHeaderName: auth?.basicHeaderName ?? '',
    certFile: auth?.certFile ?? '',
    keyFile: auth?.keyFile ?? '',
    pfxFile: auth?.pfxFile ?? '',
    useGlobalClientCertificate: auth?.useGlobalClientCertificate !== false,
    hasClientSecret,
    hasPassphrase,
  }
}

/** `Name: value` or `key=value` lines into a map; a malformed line is named, not dropped. */
function parseLines(text: string, separator: ':' | '=', what: string): Record<string, string> | string {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    const at = line.indexOf(separator)
    if (at <= 0) return `"${line}" in ${what} is not ${separator === ':' ? 'Name: value' : 'key=value'}.`
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

/**
 * What to store from what was typed. Returns an error sentence instead of guessing: a token URL
 * that is not a URL, or a header line with no name, would otherwise surface as a 401 from the
 * gateway — which reads as wrong credentials and sends somebody to check the secret.
 */
export function gatewayFromSettings(
  input: AutosysGatewaySettings,
  stored: { clientSecret: boolean; passphrase: boolean },
): { auth: AutosysAuth } | { error: string } {
  const text = (value: string): string | undefined => (value.trim().length > 0 ? value.trim() : undefined)
  const tokenUrl = text(input.tokenUrl)
  if (tokenUrl !== undefined && !/^https?:\/\/\S+$/i.test(tokenUrl)) {
    return { error: `"${tokenUrl}" is not a web address — the token URL should begin with https.` }
  }
  if (input.enabled) {
    if (tokenUrl === undefined) return { error: 'Enter the token URL before switching the gateway on.' }
    if (text(input.clientId) === undefined) return { error: 'Enter the client id before switching the gateway on.' }
    if (!stored.clientSecret) return { error: 'Enter the client secret before switching the gateway on.' }
  }
  const headers = parseLines(input.extraHeaders, ':', 'Extra headers')
  if (typeof headers === 'string') return { error: headers }
  const params = parseLines(input.extraTokenParams, '=', 'Extra token parameters')
  if (typeof params === 'string') return { error: params }
  /*
   * One header cannot carry both, and sending the second would silently replace the first — a 401
   * from whichever check lost, with nothing to say which. Refused with the way out instead.
   */
  const tokenHeader = (text(input.tokenHeaderName) ?? 'Authorization').toLowerCase()
  const basicHeader = (text(input.basicHeaderName) ?? 'Authorization').toLowerCase()
  if (input.sendBasic && tokenHeader === basicHeader) {
    return {
      error:
        `The gateway token and the AutoSys username and password would both go in the ${text(input.basicHeaderName) ?? 'Authorization'} header, and one header holds one value. ` +
        'Set the header the gateway reads its token from (Advanced → "Header the token is sent in", for example x-apigee-token), or the header AutoSys reads the username and password from — your gateway team knows which.',
    }
  }
  if (text(input.pfxFile) !== undefined && text(input.certFile) !== undefined) {
    return { error: 'Use either a PFX bundle or a certificate and key, not both.' }
  }
  if (text(input.certFile) !== undefined && text(input.keyFile) === undefined) {
    return { error: 'A client certificate needs its private key file too (or use a PFX bundle).' }
  }

  const optional = (key: keyof AutosysAuth, value: string | undefined): Partial<AutosysAuth> =>
    value === undefined ? {} : ({ [key]: value } as Partial<AutosysAuth>)
  return {
    auth: {
      type: input.enabled ? 'apigee' : 'basic',
      ...optional('tokenUrl', tokenUrl),
      ...optional('clientId', text(input.clientId)),
      ...(stored.clientSecret ? { clientSecretRef: AUTOSYS_CLIENT_SECRET_REF } : {}),
      ...optional('scope', text(input.scope)),
      ...optional('grantType', text(input.grantType)),
      // Stored only when it differs from the default, like the certificate switch.
      ...(input.clientAuthentication === 'header' ? { clientAuthentication: 'header' as const } : {}),
      ...optional('tokenPath', text(input.tokenPath)),
      ...optional('expiresInPath', text(input.expiresInPath)),
      ...optional('tokenHeaderName', text(input.tokenHeaderName)),
      /*
       * The prefix is joined to the token as typed, so "Bearer" without its space would send
       * "Bearerabc…" — a 401 nobody could see the reason for. A word-ending prefix gets the space.
       */
      ...(input.tokenHeaderPrefix.trim().length > 0
        ? { tokenHeaderPrefix: /[A-Za-z0-9]$/.test(input.tokenHeaderPrefix) ? `${input.tokenHeaderPrefix} ` : input.tokenHeaderPrefix }
        : {}),
      ...(Object.keys(headers).length > 0 ? { extraHeaders: headers } : {}),
      ...(Object.keys(params).length > 0 ? { extraTokenParams: params } : {}),
      ...(input.sendBasic ? { sendBasic: true } : {}),
      ...optional('basicHeaderName', text(input.basicHeaderName)),
      ...optional('certFile', text(input.certFile)),
      ...optional('keyFile', text(input.keyFile)),
      ...optional('pfxFile', text(input.pfxFile)),
      ...(stored.passphrase ? { passphraseRef: AUTOSYS_PASSPHRASE_REF } : {}),
      // Stored only when withheld, so the default stays the one every other connection has.
      ...(input.useGlobalClientCertificate ? {} : { useGlobalClientCertificate: false }),
    },
  }
}
