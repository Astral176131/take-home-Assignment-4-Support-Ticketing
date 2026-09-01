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
  },
});
