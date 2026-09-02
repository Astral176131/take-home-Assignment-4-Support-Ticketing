import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount anything a test rendered, so one test's DOM can't be found by the next.
// Mock call history is cleared by `clearMocks` in vitest.config.ts.
afterEach(cleanup);
