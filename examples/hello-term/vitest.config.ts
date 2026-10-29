import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The tests run the pack script, the harness-manifest CLI and the built Entry in child processes.
    testTimeout: 30_000,
  },
});
