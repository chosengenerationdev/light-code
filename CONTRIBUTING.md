# Contributing

Thanks for looking. A few things are worth knowing before you start, because this project
has more written-down opinions than most of its size.

## Read `CLAUDE.md` first

[CLAUDE.md](CLAUDE.md) is the durable record of every design decision and, more importantly,
**the reason behind it**. Several things that look like omissions are deliberate, and the
reasoning is recorded so it does not have to be rediscovered.

If a change conflicts with something in there, that is not automatically a no — but raise
the conflict in the issue rather than working around it, and expect to update that section
in the same pull request.

Some decisions that surprise people:

- **No fuzzy matching in `apply_diff`.** A rejected edit costs a retry; a misapplied edit
  costs data. This will not be reversed without a very good argument.
- **Command "always allow" is exact-match, with no patterns.** Pattern matching means
  tokenising shell grammar correctly, and a bug there auto-approves a chained destructive
  command.
- **Minimalism is the product.** "It would be easy to also add…" is usually a reason not to.

## The hard invariants

Two are enforced by ESLint and will fail CI:

1. **`packages/core` never imports `vscode`.** Platform-specific behaviour goes behind an
   interface in `packages/core/src/platform/`, implemented in `apps/vscode`.
2. **All outbound network traffic goes through the single `HttpClient` in core.** `fetch`,
   `axios`, `undici`, and `node:http`/`node:https` are banned everywhere else. This is why
   there are hand-written REST clients rather than vendor SDKs — an SDK carries its own HTTP
   stack, and then egress is no longer auditable in one place.

Others are enforced by review:

3. **No default endpoints.** Every URL is user-supplied. Presets prefill a field; they do
   not cause a connection.
4. **No telemetry, no update checks, no remote assets.** Not configurable-off. Absent.
5. Config keys that could let a hostile repository repoint credentials are **user-scope
   only**.
6. **Approval UI shows ground truth**, never the model's description of its intent.

## Layout

```
packages/core      Agent loop, tools, providers, auth, MCP, config, secrets.
                   Platform-agnostic.
packages/ui        React chat and settings. Imports only @light-code/core/browser,
                   never the bare package — the main barrel reaches node:fs.
apps/vscode        Thin host: activation, SecretStorage, terminal, webview plumbing.
```

## Working on it

```bash
pnpm install --ignore-scripts
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

<kbd>F5</kbd> launches an Extension Development Host.

Before opening a pull request, all four commands must pass. For anything touching the
webview, the approval flow, or a provider, also work through the relevant session of
[MANUAL_VERIFICATION.md](MANUAL_VERIFICATION.md) — automated tests cannot reach those, and
several real bugs have only ever been caught there.

## Tests

Vitest. The bar is not coverage, it is **whether the test would have caught the bug**.

Tests that assert a security property should say so and name the attack. `scopes.test.ts`
has one named for the hostile-repo pre-approval hole it exists to prevent; that is the model
to follow.

Prefer tests against real material over fixtures where it is affordable. The certificate
tests generate genuine X.509 with OpenSSL, because an earlier version passed against a
truncated fake PEM — for the wrong reason.

## Commits

Conventional commits. Explain *why* in the body, not just what; the diff already says what.

## Changesets

User-visible changes need a changeset:

```bash
pnpm changeset
```

Pick the bump, write a line aimed at someone reading a release note. Internal refactors and
test-only changes do not need one.

## Reporting bugs

Include your VS Code version, your OS, the wire format and model, and whatever is in the
**Light Code** output channel. If it involves the webview, its developer console too
(`Developer: Open Webview Developer Tools`).

Please do not paste an API key, a token, or a certificate. If you think output contains one,
that is itself a bug worth reporting — [privately](SECURITY.md).
