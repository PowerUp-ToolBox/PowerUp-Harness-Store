import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Several checks spawn pnpm; leave headroom for slow CI runners.
    testTimeout: 30_000,
  },
});
