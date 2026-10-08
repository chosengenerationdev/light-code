/**
 * Which model-request failures are worth sending again, and how long to wait first.
 *
 * Reported: "we should have something to retry if we face any API connectivity issues". A dropped
 * connection, a gateway answering 502 while it restarts, a 429 or Anthropic's 529 "overloaded" all
 * ended the turn, and the user's only move was to type "continue" and hope - for a failure that a
 * second attempt a few seconds later almost always gets past.
 *
 * Deliberately narrow in what it calls transient. Retrying a 401 is a lockout risk, a 400 or a
 * too-long conversation fails identically every time, and a certificate the machine does not
 * trust is a configuration fault - each retry of those only delays the message that says what to
 * fix. A wrong "no" costs the user one click; a wrong "yes" costs them a minute of waiting for an
 * error they could have read straight away.
 */

/** HTTP statuses that mean "try again shortly", not "your request is wrong". */
const TRANSIENT_STATUS = /HTTP (408|409|425|429|500|502|503|504|520|521|522|523|524|529)\b/

/** Transport failures: the connection itself went away or never came up in time. */
const TRANSIENT_TRANSPORT =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ECONNABORTED|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|other side closed|terminated|fetch failed|network error|UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|CLOSED)|No reply from .* within/i

/** Provider-reported overload, from inside an otherwise healthy stream. */
const TRANSIENT_PROVIDER = /overloaded|rate.?limit|too many requests|temporarily unavailable|service unavailable|RESOURCE_EXHAUSTED|UNAVAILABLE|try again later|server_error|internal server error/i

/** Never retried, whatever else the message says - each would fail the same way again. */
const PERMANENT =
  /HTTP (400|401|403|404|405|413|422)\b|certificate|self[- ]signed|unable to verify|CERT_|key (does not|doesn't) match|passphrase|credential missing|context.{0,20}(length|window|limit)|too many tokens|prompt is too long/i

export function isTransientError(message: string): boolean {
  if (PERMANENT.test(message)) return false
  return TRANSIENT_STATUS.test(message) || TRANSIENT_TRANSPORT.test(message) || TRANSIENT_PROVIDER.test(message)
}

/**
 * Waits grow so a gateway that is restarting gets time to come back, and are capped so a person
 * watching is never left wondering whether anything is happening. Jittered a little, so several
 * Fire Code chats that failed together do not all knock again on the same second.
 */
export function retryDelayMs(retryNumber: number, random: () => number = Math.random): number {
  const base = [2_000, 5_000, 12_000, 25_000][Math.min(retryNumber - 1, 3)] as number
  return Math.round(base * (0.85 + random() * 0.3))
}

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
export function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
