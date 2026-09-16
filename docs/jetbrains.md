# Light Code for IntelliJ and PyCharm

A plugin for the IntelliJ-based IDEs. It does not reimplement Light Code — it **runs the Node host
and shows it**, so IntelliJ, PyCharm and the VS Code extension are the same product from the same
source.

**Status: written, never compiled.** There is no JVM toolchain in the repository this was authored
in, so nothing here has been built or run. Treat the first `./gradlew runIde` as the real test.

---

## Why it is built this way

`apps/host` already exists: a Node server running the same `packages/core` and the same React
`packages/ui` as the VS Code extension. It was built so the product would have a second home. This
plugin uses that second home rather than becoming a third implementation.

So the plugin's whole job is four things:

1. Start `light-code --workspace <project> --print-url`.
2. Read the line it prints saying where it went.
3. Show that URL in a JCEF (embedded Chromium) tool window.
4. Stop the process when the project closes.

Everything else — the chat, approvals with computed diffs, every settings tab, the agent team,
providers and auth, MCP, Python tools, skills, diagrams — arrives with the page and needs no work.

**The alternative was a Swing UI over a Kotlin core.** That is a second implementation of one
interface, which is the failure this repository has paid for more than any other. It would start
behind the VS Code extension and stay behind, and every feature would have to be built twice.

## What you get, and what you do not

**The same as the extension:** all of the above.

**Not yet, and each is an addition rather than a rewrite:**

- Opening a file at a line from the chat.
- IntelliJ's own diff viewer for an approval, instead of the built-in one.
- Following the IDE theme automatically — the page has its own light/dark control, so set it once.
- Secrets live in the host's own store rather than IntelliJ's credential store.

All four need a channel from the page back into Kotlin. `JBCefJSQuery` is that channel, and the
host already declares its capabilities per host (`offersOffice`, `expertMode`), so a `jetbrains`
host can say what it offers without branching the shared code.

## Requirements

- **Node.js on the machine.** The plugin runs `npx` by default. Bundling a runtime would add tens
  of megabytes per platform; requiring Node is reasonable for a development tool.
- **An IntelliJ-based IDE, 2023.2 or newer.** JCEF has shipped since 2020.2; the floor here is the
  Gradle plugin's, not the browser's.

## Building it

```bash
cd apps/intellij
./gradlew buildPlugin      # produces build/distributions/Light Code-<version>.zip
./gradlew runIde           # starts a sandbox IDE with the plugin installed
./gradlew verifyPlugin     # JetBrains' own compatibility checks — run before publishing
```

There is no Gradle wrapper checked in yet. Generate one once with `gradle wrapper`, or open
`apps/intellij` in IntelliJ and let it do so.

## Installing it by hand

**Settings → Plugins → ⚙ → Install Plugin from Disk…** and choose the built `.zip`. That is the
whole loop for internal distribution — no marketplace involved, which matters if this is for one
organisation rather than the public.

## Publishing it

JetBrains requires every plugin to be **signed**, which is the part that differs most from the VS
Code marketplace.

### Once

1. **Make a signing certificate.** A self-signed chain is accepted:

   ```bash
   openssl genpkey -aes-256-cbc -algorithm RSA -out private.pem -pkeyopt rsa_keygen_bits:4096
   openssl req -key private.pem -new -x509 -days 3650 -out chain.crt
   ```

   Keep `private.pem` and its passphrase somewhere a backup reaches. Losing them means a new
   certificate, and the marketplace treats that as a different signer.

2. **Get a marketplace token.** <https://plugins.jetbrains.com> → your profile → **My Tokens**.

3. **Reserve the plugin id** by uploading the first version through the web form. The id in
   `plugin.xml` — `dev.chosengeneration.lightcode` — is permanent and cannot be changed later.

### Every release

```bash
export JETBRAINS_CERTIFICATE_CHAIN="$(cat chain.crt)"
export JETBRAINS_PRIVATE_KEY="$(cat private.pem)"
export JETBRAINS_PRIVATE_KEY_PASSWORD='…'
export JETBRAINS_MARKETPLACE_TOKEN='…'

cd apps/intellij
./gradlew verifyPlugin
./gradlew publishPlugin
```

**Nothing reads a credential from a file in this repository.** The Gradle build takes all four from
the environment, for the reason §15 gives for everything else here: a token in a checked-in
properties file is a token in every clone and in the history for ever.

`publishPlugin` sends to the stable channel. Add `-Pchannel=eap` to publish to a pre-release
channel instead, which subscribers opt into.

### What to expect

- **The first upload is reviewed by a person** and takes a few days. Later versions of an approved
  plugin publish automatically.
- **Version numbers are the plugin's own**, in `gradle.properties`. They do not have to track the
  extension or the npm package, and trying to keep three in step is more trouble than it saves.
- `pluginUntilBuild` caps which IDE builds accept it. Raise it when a new IDE ships, or the plugin
  silently stops being offered to people who upgraded.

## Deciding whether it is worth it

The code is small. The apparatus around it is not: a JVM toolchain, Gradle, a signing certificate,
a separate marketplace and a review queue. If the audience is one organisation, **Install Plugin
from Disk** skips all of it, and the only thing you lose is automatic updates.
