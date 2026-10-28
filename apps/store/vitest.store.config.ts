import { defineConfig } from 'vitest/config';

// The Store seam (docs/tech/architecture.md §8, item 4): tests against a running local Supabase
// stack (`pnpm db:start`, or `supabase start`), over HTTP only. The files share one database and
// the seed test rewrites the whole catalogue, so they run one at a time.
export default defineConfig({
  test: {
    include: ['test-store/**/*.test.ts'],
    globalSetup: ['test-store/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
