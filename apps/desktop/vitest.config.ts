import { defineConfig } from 'vitest/config';

// Main, preload and seam tests run under plain Node (no Electron); renderer component tests opt into
// jsdom per file with a `// @vitest-environment jsdom` comment.
export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
