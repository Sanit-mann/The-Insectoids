import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/desktop/src/main/**/*.test.ts'],
    environment: 'node',
    // End-to-end hive tests drive real git repositories; on Windows a single test can take several seconds.
    testTimeout: 30_000,
  },
});
