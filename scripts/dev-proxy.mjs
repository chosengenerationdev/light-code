#!/usr/bin/env node
/**
 * A stand-in for the reverse proxy, so shared mode can be tried on one machine.
 *
 * Shared mode identifies users from a header that a proxy sets, and a browser cannot set one. So
 * without something in front there is no way to see the feature at all — every request is refused,
 * correctly, and the screen stays empty. This is the smallest thing that closes that gap.
 *
 * **It is not a deployment.** It authenticates nobody: it stamps whichever user you name on the
 * command line onto every request. That is exactly what a real proxy must never do, and it is fine
 * here only because it binds loopback and you started it yourself. Do not put it in front of
 * anything that matters, and do not copy its shape into an nginx config — see `docs/hosting.md`
 * for the real one, where the point is that the proxy *strips* an inbound header rather than
 * trusting it.
 *
 *   node scripts/dev-proxy.mjs --port 8080 --to 8751 --user alice
 */
import http from 'node:http'

const args = process.argv.slice(2)
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

const listenPort = Number.parseInt(valueOf('--port', '8080'), 10)
const targetPort = Number.parseInt(valueOf('--to', '8751'), 10)
const user = valueOf('--user', 'dev-user')
const displayName = valueOf('--name', user)

if (Number.isNaN(listenPort) || Number.isNaN(targetPort)) {
  process.stderr.write('dev-proxy: --port and --to must be numbers\n')
  process.exit(2)
}

const server = http.createServer((request, response) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: targetPort,
      path: request.url,
      method: request.method,
      headers: {
        ...request.headers,
        /*
         * Replaced, never appended. A real proxy must do the same: appending leaves any header the
         * client sent sitting beside the real one, and Light Code refuses a doubled header rather
         * than guessing which is which.
         */
        'x-forwarded-user': user,
        'x-forwarded-display-name': displayName,
        // The server checks Host and Origin. Rewritten so they match what it actually bound.
        host: `127.0.0.1:${String(targetPort)}`,
        ...(request.headers.origin !== undefined ? { origin: `http://127.0.0.1:${String(targetPort)}` } : {}),
      },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    },
  )
  upstream.on('error', (error) => {
    response.writeHead(502, { 'Content-Type': 'text/plain' })
    response.end(`dev-proxy: cannot reach 127.0.0.1:${String(targetPort)} — ${error.message}\n`)
  })
  request.pipe(upstream)
})

server.listen(listenPort, '127.0.0.1', () => {
  process.stdout.write(
    `dev-proxy: http://127.0.0.1:${String(listenPort)} -> 127.0.0.1:${String(targetPort)} as "${user}"\n` +
      `  users          http://127.0.0.1:${String(listenPort)}/\n` +
      `  administrators http://127.0.0.1:${String(listenPort)}/admin\n\n` +
      'This authenticates nobody. It is for trying shared mode on one machine.\n',
  )
})
