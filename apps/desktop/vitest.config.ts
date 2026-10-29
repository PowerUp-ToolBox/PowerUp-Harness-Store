import { defineConfig } from 'vitest/config';

// On Windows the Harnesses the tests run for real start, stop and leave their folders more slowly
// (ConPTY, taskkill, files locked for a moment after an exit; see
// test/support/harness-processes.ts), in a test or in the afterEach that quits the Runtime.
const WINDOWS = process.platform === 'win32';

// Main, preload and seam tests run under plain Node (no Electron); renderer component tests opt into
// jsdom per file with a `// @vitest-environment jsdom` comment.
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: WINDOWS ? 30_000 : 5000,
    hookTimeout: WINDOWS ? 30_000 : 10_000,
  },
});
