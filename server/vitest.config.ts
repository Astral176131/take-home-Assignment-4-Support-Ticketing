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
    testTimeout: 15000,
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
