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
    // The sole exemption to invariant 2: HttpClient's own implementation.
    files: ['packages/core/src/platform/http.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },
  eslintConfigPrettier,
)
