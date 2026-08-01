const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi
const SK_STYLE_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g

const REDACTED = '[REDACTED]'

/**
 * The single redaction helper. Applied to every logging and error path, keyed on
 * known secret values plus patterns for `Bearer` tokens and `sk-`-style keys — HTTP
 * libraries love to echo request headers. See CLAUDE.md §15.
 */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let result = text

  for (const secret of knownSecrets) {
    if (secret.length === 0) continue
    result = result.split(secret).join(REDACTED)
  }

  result = result.replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`)
  result = result.replace(SK_STYLE_KEY_PATTERN, REDACTED)

  return result
}
