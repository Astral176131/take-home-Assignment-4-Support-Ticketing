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
  },
});
