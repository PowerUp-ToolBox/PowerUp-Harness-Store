import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fails any test that opens a TCP connection beyond loopback.
    setupFiles: ['test/support/offline.ts'],
  },
});
