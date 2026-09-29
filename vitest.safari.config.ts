import { defineConfig } from 'vitest/config';

// Gate runner for Safari.app through safaridriver (spec vpa-001 §2.6).
export default defineConfig({
  test: {
    include: ['test/e2e/safari.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
