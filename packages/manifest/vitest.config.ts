import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The drift check and the browser bundle test spawn Node and run Vite.
    testTimeout: 60_000,
  },
});
