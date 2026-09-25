// Test runner for apps/store, wired into the root `pnpm test` through this
// package's `test` script.
//
// apps/store is a Supabase project whose Edge Functions run on Deno, so it is
// not part of the Node/TypeScript project graph and does not use Vitest.
// Until P0-07 there are no migrations, policies or Edge Functions to test, so
// this runner is a stub that always succeeds. P0-07 replaces its body with the
// real Deno/Supabase test command; the root wiring stays the same.
console.log(
  'apps/store: no Store tests yet; the Supabase project and its Deno tests arrive in P0-07.',
);
