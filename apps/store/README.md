# @harness-store/store

> Status: placeholder (P0-01.1). The Supabase project arrives in P0-07.

The backend of the **Store**: a Supabase project ([ADR-0006](../../docs/adr/0006-supabase-for-the-store.md)) that is the source of truth for Harnesses, **Harness Versions**, **Publishers**, **Reports** and download counts.

## What it will contain

- Postgres migrations, row-level security policies and seed data ([`data-model.md`](../../docs/tech/data-model.md)).
- Storage buckets: private `harness-packages` for **Harness Packages**, public `harness-assets` for icons and screenshots.
- Edge Functions ([`api.md`](../../docs/tech/api.md)): `publish` (re-validates the **Manifest** with the shared [`packages/manifest`](../../packages/manifest) code, stores the package and creates an immutable Harness Version), `download` (signed URL + counter) and `report`.
- GitHub OAuth as the only sign-in; only Publishers sign in.

## Tooling

Edge Functions run on **Deno**, not Node, so this package is deliberately:

- excluded from the TypeScript project references graph in the root [`tsconfig.json`](../../tsconfig.json);
- not linted or type-checked by the root `pnpm lint` / `pnpm typecheck` (Deno's own `deno lint` / `deno check` arrive with the code in P0-07);
- still wired into the root `pnpm test` through its own runner, [`scripts/test.mjs`](./scripts/test.mjs). It is a stub that exits 0 until P0-07 replaces it with the real Deno and local-Supabase test run. Nothing here requires Deno or the Supabase CLI yet.

Spec: [`P0-07`](../../docs/delivery/specs/P0-07-store-backend.md).
