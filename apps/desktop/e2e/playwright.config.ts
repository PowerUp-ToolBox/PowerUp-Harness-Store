import { defineConfig } from '@playwright/test';

/**
 * The Desktop E2E seam (docs/tech/architecture.md §8, item 5): Playwright for Electron over the
 * built app (`pnpm build` first). `pnpm e2e` runs every project; CI runs `smoke` on macOS, Windows
 * and Linux and `acceptance` on Linux (`e2e-smoke` and `acceptance` in .github/workflows/ci.yml).
 *
 * - `smoke`: the Store-less journey, needs nothing but the app.
 * - `acceptance`: the whole P0 journey; its dependency `store` starts the local Supabase stack in
 *   Docker once, and `store-teardown` stops it after.
 *
 * One worker: every journey's fake Ollama listens on the same port. A journey must finish in 10
 * minutes (its timeout); in CI a failed one is retried once, and passing on the retry marks it
 * flaky in the JSON report, which CI lists in the job summary (scripts/e2e-summary.mjs).
 */
export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'store', testMatch: 'store.setup.ts', teardown: 'store-teardown' },
    { name: 'store-teardown', testMatch: 'store.teardown.ts' },
    { name: 'smoke', testMatch: 'journey.spec.ts', grep: /@smoke/ },
    {
      name: 'acceptance',
      testMatch: 'journey.spec.ts',
      grep: /@acceptance/,
      dependencies: ['store'],
    },
  ],
});
