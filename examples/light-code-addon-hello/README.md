# light-code-addon-hello

An example add-on for Light Code and Fire Code. Copy this folder to start your own.

## What an add-on is

A Node package that runs an [MCP](https://modelcontextprotocol.io) server over stdio, with a label
in its `package.json`:

```json
"lightCode": {
  "addon": { "main": "server.js", "displayName": "Hello (example)", "description": "…" }
}
```

- `main` - the server script, inside the package. Defaults to the package's own `main`.
- `displayName`, `description` - what the Add-ons panel shows.
- `args` - optional extra arguments for the script.

Every tool the server registers reaches the agent as `addon-<name>__<tool>`, where `<name>` is the
package name without a scope or a `light-code-addon-` prefix. Tools go through Light Code's approval
prompt like any other; the MCP tab's Always / Ask / Never, timeouts and deny rules apply.

## Try it

```
cd examples/light-code-addon-hello
npm install
npm install -g .
```

Then **Settings → Add-ons → Enable**, read the program it will run, and confirm. Ask the agent
to "greet Ada with the hello add-on".

While writing one, you do not need to install it globally: add its folder under **Also look in
these folders** in the same panel.

## Rules

- **Nothing on stdout but the protocol.** Log with `console.error`; it shows under the add-on's Log on the Add-ons tab.
- **An update stays off until enabled again.** Bump `version` when you change it, then press
  *Enable this version* - Light Code will not run new code nobody has looked at.
- **It runs as the user.** Anything it does is done with their rights; it gets no Light Code
  secrets. If it needs a credential, take it from an environment variable set on the server in the
  MCP tab (`${secret:NAME}` values come from Light Code's secret storage).
- Inside VS Code it runs on the editor's own Node, so it must not need a newer Node than VS Code
  ships. In Fire Code and the Node host it runs on the same Node as Light Code.
