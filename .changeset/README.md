# Changesets

Version bumps and the changelog for the published extension.

`pnpm changeset` to record a user-visible change. Pick the bump, and write the line as
someone reading a release note would want it — what changed for them, not which file moved.

Only `light-code-vscode` is versioned. `@light-code/core` and `@light-code/ui` are private
workspace packages bundled into the extension, never published separately, so they are on
the `ignore` list — otherwise every release would try to publish them to npm.

Internal refactors and test-only changes need no changeset.

See the [Changesets docs](https://github.com/changesets/changesets) for the full format.
