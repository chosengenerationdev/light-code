import os from 'node:os'

/**
 * The names this machine can actually be reached by, for the `Host` allowlist.
 *
 * ## Why this exists
 *
 * The allowlist used to be derived from the *bind address*, which works for `127.0.0.1` and is
 * meaningless for `0.0.0.0` — nobody types `http://0.0.0.0:7100` into a browser. Measured against
 * the running server, `--bind 0.0.0.0` accepted `localhost` and refused everything else with 421:
 * not the machine's own hostname, not its LAN address, not even `127.0.0.1`. Binding publicly
 * therefore worked from nowhere except the one place binding publicly was not for.
 *
 * That was a bug rather than a defence, and the fix is not to stop checking. A wildcard bind means
 * "reachable as this machine", so the allowlist becomes the set of names this machine *has*.
 *
 * ## What it deliberately still refuses
 *
 * Anything that is not one of those names. **DNS rebinding is still blocked**, which is the whole
 * point of checking `Host` at all: the attack turns on a *foreign* domain resolving to this
 * machine's address, and a foreign domain is exactly what is absent from this list. `evil.example`
 * gets 421 before and after.
 *
 * An operator whose name is not derivable — a reverse proxy, a container alias, a DNS record
 * pointing here — declares it with `--allow-host`. Declared, not guessed, because a guess wide
 * enough to cover those would be wide enough to cover an attacker.
 */
export function reachableHosts(bindAddress: string, port: number, extra: readonly string[] = []): string[] {
  const names = new Set<string>()
  const add = (name: string): void => {
    const trimmed = name.trim().toLowerCase()
    if (trimmed.length === 0) return
    // Already carries a port — a proxy on a different one, say — so it is taken as written.
    names.add(trimmed.includes(':') && !trimmed.startsWith('[') ? trimmed : `${trimmed}:${String(port)}`)
  }

  add(`localhost`)
  add(`127.0.0.1`)

  const wildcard = bindAddress === '0.0.0.0' || bindAddress === '::' || bindAddress === ''
  if (!wildcard) {
    add(bindAddress)
  } else {
    /*
     * Every name this machine answers to, because a wildcard bind said "reach me however you can".
     *
     * The hostname matters as much as the addresses: on a corporate network people are given a
     * name, not an IP, and an allowlist of addresses alone would refuse the URL they were told to
     * use — which is the failure this whole function exists to fix, one step further along.
     */
    add(os.hostname())
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) continue
        // IPv6 goes in a browser's Host header wrapped in brackets.
        add(entry.family === 'IPv6' ? `[${entry.address}]` : entry.address)
      }
    }
  }

  for (const name of extra) add(name)
  return [...names]
}

/** The origins those hosts produce, plus anything declared outright. */
export function reachableOrigins(hosts: readonly string[], extra: readonly string[] = []): string[] {
  const origins = new Set<string>()
  // `http` only: this server does not terminate TLS. A proxy that does is a different origin and
  // has to be declared, which is what `--allow-origin` is for.
  for (const host of hosts) origins.add(`http://${host}`)
  for (const origin of extra) {
    const trimmed = origin.trim().toLowerCase().replace(/\/$/, '')
    if (trimmed.length > 0) origins.add(trimmed)
  }
  return [...origins]
}
