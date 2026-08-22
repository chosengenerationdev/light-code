# @chosengeneration/light-code

## 0.5.0

### Minor Changes

- A Variables tab, and user variables moved out of `config.json`.

  Both scopes in one panel: your own, and the administrator's that apply to everyone. Where a name
  collides the administrator's wins, and the row says so and shows the value that is actually in
  force — a user editing an overridden variable would otherwise change something that never takes
  effect with nothing to indicate it.

  The panel says, where a value is typed, that these are **not secret**: everything a session runs
  does so as the server's account, so another user's assistant can read them. API keys belong in
  Providers.

  Administrators can edit the administrator list from the interface, so adding a colleague no longer
  means a restart. `--admin-id` still wins at startup, which is the way back for someone who removes
  themselves.

  Fixes a data-loss bug before it shipped: user variables were kept in `config.json`, and the config
  schema strips keys it does not know — so they would have survived until the first unrelated save
  and then vanished silently. They now live in `variables.json`, and a test asserts the stripping so
  the reason is visible rather than a claim in a comment.

## 0.4.0

### Minor Changes

- Real users, and an administrator's URL. Node host only — the extension is untouched.

  `ProxyHeaderIdentity` reads the user from a header your reverse proxy sets, and believes it only
  from an address you name with `--trust-proxy`. The header is not the trust boundary: anything
  that can reach the port can type one, so the check is on the socket's peer address, which a
  client cannot choose. With no trusted proxy configured every request is refused — a deployment
  that refuses everyone is a support call, one that believes everyone is a breach.

  `/admin` serves the administrator's interface and `/` serves everyone's. Reaching `/admin` is
  assumed to be restricted upstream; the admin id list still decides who is actually treated as one.

  `--admin` is now a boolean that opens the admin URL. The old `--admin <id>` form is an **error**
  naming `--admin-id`, not silently reinterpreted — it would otherwise name nobody and open admin
  mode instead.

## 0.3.0

### Minor Changes

- First-run guide in the browser.

  `npx light-code` opened on an empty chat with no provider, no onboarding, and nothing to say that
  eleven settings tabs existed — VS Code had a fourteen-step tour and the browser had none of it.
  The tour now renders in-app, one step at a time, and each step about a settings tab has a button
  that opens it.

  The content is shared with the extension (`GUIDE_STEPS` in core) so the two cannot drift; only the
  rendering differs. The diagrams are served from this origin under `/guide`, from a fixed table
  derived from the step list rather than from the request path.

  Also fixes the `files` glob, which listed `.js`, `.html` and `.css` — so the diagrams were built,
  copied and served locally, and then left out of the published tarball. Every install from npm
  would have shown broken images. `pnpm verify:npm` now checks the packaged tarball for them, and
  that check was verified to fail without the fix.
