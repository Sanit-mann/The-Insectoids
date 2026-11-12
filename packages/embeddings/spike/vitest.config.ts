import { defineConfig } from 'vitest/config';

// Spike runs only on request (SPIKE=1): downloads approved models, evaluates them. Never part of `pnpm test`.
export default defineConfig({
  test: { include: ['spike/**/*.spike.ts'], environment: 'node', testTimeout: 1_800_000, hookTimeout: 1_800_000 },
});
