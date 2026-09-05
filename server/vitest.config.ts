import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      // Load test env vars
      NODE_ENV: 'test',
    },
    setupFiles: ['./src/test/setup.ts'],
    // Raised from 15s. `authenticate` now resolves the user against the database on every
    // request rather than trusting the token's claims, which is one extra round trip per
    // call — negligible against a co-located database, but this suite talks to a hosted
    // one where each round trip is a few hundred milliseconds. The tests that chain a
    // dozen requests (the full status walk, the authorization sweep) went from
    // comfortably inside 15s to just over it. Nothing about their behaviour changed, so
    // the timeout is what was wrong, not the tests.
    testTimeout: 30000,
    // Setup hooks hash passwords and seed fixtures against a remote database, which
    // comfortably exceeds the 10s default. A hook that times out is aborted mid-flight,
    // so its writes can land after cleanup has already run and leave rows behind.
    hookTimeout: 60000,
    // Every test file opens its own connection pool against a real Postgres database on
    // a direct (non-pooled) connection. Running files in parallel — Vitest's default —
    // multiplies that across several worker processes at once and exhausts the
    // database's connection limit, surfacing as an unrelated-looking 500 mid-suite.
    // Capping each pool's size (see lib/prisma.ts and every test file) helps, but
    // serializing files is what actually keeps this from recurring as more are added.
    fileParallelism: false,
  },
});
