/**
 * The web globals Node gained in 18, installed on 17 if they are absent.
 *
 * ## Why this file exists
 *
 * The Node host supports Node 17 and upwards. Everything Light Code itself writes stays well
 * inside that — the one API newer than 17 anywhere in core is `structuredClone`, which landed in
 * 17.0 exactly. What does not is `@modelcontextprotocol/sdk`, which declares `>=18`, and the
 * reason it declares it is these globals: `fetch` for the Streamable HTTP transport, and the
 * stream and `Blob` types around it. Node 18 made all of them global; on 17 they exist, just not
 * on `globalThis`.
 *
 * So this is not a polyfill in the usual sense. Nothing is reimplemented — each value is the one
 * Node or undici already ships, moved to where a library written against Node 18 expects to find
 * it. On Node 18 and above every branch is skipped and this file does nothing at all.
 *
 * ## Why the fetch here is not a hole in invariant 2
 *
 * Invariant 2 sends *Light Code's* traffic through the single `HttpClient` in core, and that is
 * unchanged — nothing here is reachable from core, which cannot import from a host. This global
 * exists solely so that the MCP SDK's own transport works, and an MCP server's connection was
 * always the SDK's to make: §11 says explicitly not to hand-roll JSON-RPC, which means accepting
 * that the SDK opens its own socket. This changes where it finds `fetch` on one Node version, not
 * who is allowed to call out.
 *
 * ## Why it must be imported before anything else
 *
 * A module that reads a global at import time — rather than at call time — would capture the
 * absence. The entry point imports this first, and there is a test asserting it still does,
 * because the failure is a `ReferenceError` from inside a dependency that names nothing here.
 */

/** True when a global is missing and we have something real to put there. */
function absent(name: string): boolean {
  return (globalThis as Record<string, unknown>)[name] === undefined
}

function define(name: string, value: unknown): void {
  if (value === undefined) return
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}

export interface CompatReport {
  /** Which globals were supplied. Empty on Node 18 and above, which is the ordinary case. */
  installed: string[]
  nodeVersion: string
}

/**
 * Fills in the missing globals and reports what it did.
 *
 * Reported rather than silent: a session behaving oddly on an old Node should be diagnosable from
 * one log line, not by working out which runtime the user has.
 */
export function installNodeCompat(): CompatReport {
  const installed: string[] = []

  // Streams and Blob come from Node's own modules — the same objects, one import earlier.
  if (absent('ReadableStream') || absent('WritableStream') || absent('TransformStream')) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const web = require('node:stream/web') as Record<string, unknown>
      for (const name of ['ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy']) {
        if (absent(name) && web[name] !== undefined) {
          define(name, web[name])
          installed.push(name)
        }
      }
    } catch {
      // Nothing to install. The failure surfaces later, from the code that needed it, which is
      // more informative than a message here about a module the user has never heard of.
    }
  }

  if (absent('Blob')) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const buffer = require('node:buffer') as Record<string, unknown>
      if (buffer['Blob'] !== undefined) {
        define('Blob', buffer['Blob'])
        installed.push('Blob')
      }
    } catch {
      // As above.
    }
  }

  /*
   * `fetch` and its companions come from undici, which is already a dependency and is the same
   * implementation Node 18 made global — Node's global fetch *is* undici. So this is genuinely
   * the same code, not a substitute for it.
   */
  if (absent('fetch')) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-restricted-imports
      const undici = require('undici') as Record<string, unknown>
      for (const name of ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'File']) {
        if (absent(name) && undici[name] !== undefined) {
          define(name, undici[name])
          installed.push(name)
        }
      }
    } catch {
      // As above.
    }
  }

  return { installed, nodeVersion: process.version }
}
