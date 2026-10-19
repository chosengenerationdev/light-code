import fs from 'node:fs'
import * as esbuild from 'esbuild'

/**
 * One file, no runtime dependencies: `npm i -g` downloads this package and nothing else, which is
 * what an office behind a strict mirror can install. ssh2's two native speed-ups are left out - it
 * loads each inside a try and falls back to plain JavaScript - so there is no binary at all.
 */
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))

await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['cpu-features', './crypto/build/Release/sshcrypto.node'],
  // A .node file is a native binary; nothing here may need one.
  loader: { '.node': 'empty' },
  define: { __ADDON_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
  legalComments: 'none',
})
