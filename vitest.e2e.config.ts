import { defineConfig } from 'vitest/config';

/**
 * The end-to-end suite. It is separate from the unit tests: the scenarios
 * start the real CLI, and the live provider scenarios need a browser and a
 * logged-in profile (they are skipped unless `TEN_X_CHAT_E2E_PROVIDERS=1`).
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/e2e/**/*.e2e.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 5 * 60 * 1000,
    // The scenarios drive one browser and one CLI at a time.
    fileParallelism: false,
  },
});
