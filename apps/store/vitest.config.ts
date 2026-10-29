import { defineConfig } from 'vitest/config';

// The fast checks `pnpm test` runs: no Docker, no Supabase stack. The store tests that need a
// running local stack are in test-store/ (vitest.store.config.ts, `pnpm test:store`).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
