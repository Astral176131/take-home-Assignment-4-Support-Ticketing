import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // A fake DOM so components can render and be queried the way a person sees them.
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Wipe recorded calls between tests. Without this, a mock declared at module scope
    // carries one test's calls into the next and assertions quietly read stale history.
    clearMocks: true,
  },
});
