---
status: accepted
date: 2026-09-20
---

# The Store runs on Supabase (Auth, Postgres, Storage, Edge Functions)

P0 Store logic is small: GitHub sign-in for Publishers, a few tables, package storage, search and download counting. We decided to build it on Supabase rather than a hand-rolled Node API, so authentication, object storage, row-level security and hosting come for free and the shared `packages/manifest` validation runs unchanged in Edge Functions (Deno/TypeScript).

## Considered Options

- Node API (Hono) + Postgres + S3 on Fly/Railway: full control, but three services to operate before there is any traffic.
- Cloudflare Workers + D1 + R2: cheap, but D1 lacks the Postgres features (full-text search, RLS, triggers) the data model relies on.

## Consequences

- Reads go straight from the desktop app to PostgREST under RLS; writes go through Edge Functions with the service role.
- If P1 payments or P2 cloud Gateway outgrow Edge Functions, a dedicated API service can be added beside Supabase without migrating data.
