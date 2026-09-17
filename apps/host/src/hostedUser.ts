/**
 * Who the platform this server runs on says the user is.
 *
 * ## Why this exists
 *
 * Asked for directly: *"as we now have the way to find current user id, which we use to form the
 * url suffix, we can use the same to maintain current user configurations instead of needing an
 * identity parameter?"* — and then, plainly, to embed a way to find the current user.
 *
 * Yes, and it removes the need to write a Python function for the commonest case. `--identity-tool`
 * stays for a deployment whose own libraries are the only thing that knows who is logged in; it is
 * simply no longer the *only* answer.
 *
 * ## Where the name comes from, and why not the URL
 *
 * **From this process's own environment, never from a request.** JupyterHub spawns a single-user
 * server per person and sets `JUPYTERHUB_USER` in it, so the variable is a statement by the
 * platform about the account this process belongs to — not something a caller can choose.
 *
 * The URL suffix is the same name and is *not* the same fact. A path is supplied by whoever made
 * the request; reading identity from it would mean anyone who can reach the port can name
 * themselves, and §14 is explicit that identity resolution must not become a way past the door.
 * The hub enforces that `/user/ana/` reaches Ana's server — that enforcement lives in the hub, and
 * what reaches us from it is the environment, so that is what is read.
 *
 * ## What it does not change
 *
 * Nothing about authorisation. The bearer token still decides who gets in, exactly as before. This
 * decides which name the settings, secrets and history are filed under, which is why getting it
 * from a trustworthy place matters at all.
 */

/** Variables checked, in order. First one set and non-empty wins. */
const SOURCES = [
  /** JupyterHub's own, set in every single-user server it spawns. */
  'JUPYTERHUB_USER',
  /** Set by some deployments that front an app without the hub's spawner. */
  'JUPYTER_USER',
] as const

export interface HostedUser {
  id: string
  /** Which variable it came from, for the banner — a name from nowhere invites no trust. */
  source: string
}

/**
 * The user this process was started for, if the platform said.
 *
 * Deliberately narrow. It reads two variables that mean *this account*, and nothing that merely
 * correlates with it: `USER` and `USERNAME` are the account the **service** runs as, which on a
 * shared host is one name for everybody and would file every person's settings in the same place
 * while looking like it had worked.
 */
export function hostedUser(env: NodeJS.ProcessEnv = process.env): HostedUser | undefined {
  for (const source of SOURCES) {
    const value = env[source]?.trim()
    if (value !== undefined && value.length > 0) return { id: value, source }
  }
  return undefined
}
