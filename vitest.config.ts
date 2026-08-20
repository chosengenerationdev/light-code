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
    /*
     * Bounded worker pool, because an unbounded one is flaky on this machine.
     *
     * The default spawns a fork per core and the suite intermittently died with "Failed to
     * start forks worker" / "Timeout waiting for worker to respond" — never a test failure,
     * always start-up contention, and it blocked the release gate twice. Several of these
     * files pay jsdom's start-up cost, which makes the first seconds the busiest.
     *
     * Capped rather than serialised: the suite still runs in parallel and takes about the same
     * wall time, because the bottleneck was never CPU.
     */
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    /* A worker that is genuinely wedged should fail the file, not the whole run. */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
