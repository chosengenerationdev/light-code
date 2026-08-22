# @chosengeneration/light-code

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
