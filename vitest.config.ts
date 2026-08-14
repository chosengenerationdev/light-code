import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /*
     * Node by default, because almost everything here is. A component test opts into a DOM
     * per file with `// @vitest-environment jsdom`, rather than paying jsdom's startup cost
     * across six hundred tests that have no use for it.
     */
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      // `.tsx` was missing, which is a large part of why no React component in this repo had
      // ever been render-tested: a component test could not have run even if one existed.
      'packages/*/src/**/*.test.tsx',
      'apps/*/src/**/*.test.ts',
    ],
    passWithNoTests: true,
  },
})
