import type { HttpClient, HttpRequestOptions, HttpResponse } from '@light-code/core'

/**
 * How long to wait for response *headers* before giving up.
 *
 * Generous on purpose. A corporate gateway behind mutual TLS and a proxy can take a while to
 * answer, and a deadline that fired on a slow-but-working link would be worse than none. What
 * this has to beat is the operating system's own connect timeout, which is measured in minutes.
 */
export const HEADERS_DEADLINE_MS = 45_000

/**
 * Puts a deadline on getting a reply, without putting one on the reply itself.
 *
 * ## The reported failure
 *
 * On a Linux server, refreshing the model list said "Loading…" indefinitely and Test Connection
 * said "Testing…", with no error ever arriving. Neither is a hang in Light Code: it is a TCP
 * connect to a host that is **dropping** packets rather than refusing them, which waits for the
 * kernel's own timeout. A request with no deadline cannot fail, and something that cannot fail
 * cannot report — so the UI waits with it, forever, showing the one state that means "working".
 *
 * ## Why headers and not the whole exchange
 *
 * A streamed completion legitimately takes minutes, so a deadline on the *complete* response
 * would cancel long generations — a far worse bug than the one being fixed. `request` resolves
 * as soon as the response headers arrive; the body streams afterwards. So the timer is cleared
 * the moment that promise settles, and the body is never raced.
 *
 * ## Why it lives in the host rather than in core's client
 *
 * Because the extension is not asking for it. Core builds its own client when a host supplies
 * none, so nothing changes for a host that does not want this.
 */
export function withHeadersDeadline(inner: HttpClient, budgetMs = HEADERS_DEADLINE_MS): HttpClient {
  return {
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      const deadline = new AbortController()
      const expire = setTimeout(() => deadline.abort(), budgetMs)

      /*
       * Composed with the caller's signal rather than replacing it. Cancelling a turn has to
       * still cancel the request underneath it, and a caller that already aborted must not be
       * given a fresh un-aborted one.
       */
      const forward = (): void => deadline.abort()
      options.signal?.addEventListener('abort', forward, { once: true })
      if (options.signal?.aborted === true) forward()

      try {
        return await inner.request(url, { ...options, signal: deadline.signal })
      } catch (error) {
        // Only when *we* gave up. A user cancelling reads as a cancellation, not as a timeout.
        if (deadline.signal.aborted && options.signal?.aborted !== true) {
          throw new Error(
            `No reply from ${hostOf(url)} within ${String(Math.round(budgetMs / 1000))}s. ` +
              'That machine may be unreachable from this server, or a firewall may be dropping ' +
              'the connection rather than refusing it — a refused connection fails immediately, ' +
              'a dropped one looks exactly like this. Check the base URL, and whether this ' +
              'server can reach that host at all.',
            // Kept, because undici puts the real transport reason on `cause` — sometimes nested
            // twice — and discarding it here would repeat the mistake `describeTlsError` fixed.
            { cause: error },
          )
        }
        throw error
      } finally {
        clearTimeout(expire)
        options.signal?.removeEventListener('abort', forward)
      }
    },
  }
}

/** The host alone, so the message names a machine rather than repeating a long URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
