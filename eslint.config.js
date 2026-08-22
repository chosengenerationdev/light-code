import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import eslintConfigPrettier from 'eslint-config-prettier'

const httpClientMessage =
  'All outbound network traffic goes through the single HttpClient in packages/core/src/platform/http.ts — see CLAUDE.md invariant 2.'

const bannedNetworkImports = [
  { name: 'axios', message: httpClientMessage },
  { name: 'undici', message: httpClientMessage },
  { name: 'node-fetch', message: httpClientMessage },
  { name: 'node:http', message: httpClientMessage },
  { name: 'node:https', message: httpClientMessage },
  { name: 'http', message: httpClientMessage },
  { name: 'https', message: httpClientMessage },
]

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.vsix', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
  },
  {
    // Invariant 2: no direct network egress anywhere except HttpClient itself.
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: httpClientMessage },
      ],
      'no-restricted-imports': ['error', { paths: bannedNetworkImports }],
    },
  },
  {
    // Invariant 1: packages/core must never import vscode.
    files: ['packages/core/**/*.ts', 'packages/core/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message: 'packages/core must never import vscode — see CLAUDE.md invariant 1.',
            },
            ...bannedNetworkImports,
          ],
        },
      ],
    },
  },
  {
    // The sole exemption to invariant 2 for *outbound* traffic: HttpClient's own
    // implementation.
    files: ['packages/core/src/platform/http.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    /*
     * The Node host's listening socket. Invariant 2 governs egress — every request Light
     * Code *makes* must go through HttpClient, so that TLS material, proxies and the
     * no-default-endpoints rule are enforced in one place. A server socket is ingress:
     * nothing in these files calls out, and the model gateway is still reached only
     * through HttpClient.
     */
    files: [
      'apps/host/src/server.ts',
      'apps/host/src/security.ts',
      'apps/host/src/identity.ts',
      'apps/host/src/proxyIdentity.ts',
      'apps/host/src/security.test.ts',
      'apps/host/src/proxyIdentity.test.ts',
      /*
       * A local stand-in for the reverse proxy, so shared mode can be tried on one machine.
       * Invariant 2 governs what the *product* sends: this is a development script, never
       * published (the npm `files` list is `dist/**`), and it only ever talks to loopback.
       */
      'scripts/dev-proxy.mjs',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    /*
     * The browser client's transport. This `fetch` talks to the page's own origin and
     * nothing else — the CSP the server sends carries `connect-src 'self'`, so the browser
     * refuses any other destination. It cannot go through HttpClient, which is a Node
     * implementation over undici and does not exist in a browser bundle.
     *
     * Note this file is bundled into the *host's* client, never into the extension's
     * webview.js, so `scripts/check-no-external-urls.mjs` still holds: that check bans
     * network primitives in the webview bundle, and this is a different artifact.
     */
    files: ['apps/host/src/client/**/*.ts', 'apps/host/src/client/**/*.tsx'],
    rules: { 'no-restricted-globals': 'off' },
  },
  eslintConfigPrettier,
)
