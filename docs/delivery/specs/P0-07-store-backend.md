---
spec_id: P0-07
title: Store backend (Supabase schema, auth, storage, edge functions)
phase: P0
blocked_by: [P0-01]
requirements: [R-0701, R-0702, R-0703, R-0704, R-0705]
---

# P0-07 Store backend (Supabase schema, auth, storage, edge functions)

## Problem Statement

Publishers have nowhere to put a Harness where other people can find it, and Users have nowhere to get one from. Without a hosted Store there is no catalogue, no immutable Harness Versions, no Publisher identity behind a Harness ID, and no download counts. Everything downstream (publishing, browsing, installing, reporting) needs a backend that validates what it accepts with the same rules the desktop app uses, keeps packages private until requested, and never learns anything about a User's models or conversations.

## Solution

A Supabase project (Auth, Postgres, Storage, Edge Functions) that is the single source of truth for Harnesses, Harness Versions, Publishers, Reports and download counts, as specified in `docs/tech/data-model.md` and `docs/tech/api.md`. Reads go through PostgREST under row-level security; every write goes through an Edge Function that authenticates the caller, validates with the shared Manifest package, and enforces immutability and ownership. GitHub OAuth is the only sign-in and only Publishers ever sign in. Packages live in a private bucket and are handed out through short-lived signed URLs by a `download` function that also records the download. A local development stack with seed data lets every other P0 spec be built and tested without touching production.

## User Stories

1. As a Publisher, I want to sign in with GitHub, so that my GitHub login becomes the publisher segment of my Harness IDs without any extra identity setup.
2. As a Publisher, I want my profile (login, display name, avatar) created automatically on first sign-in, so that I can publish immediately.
3. As a Publisher, I want to upload a Harness Package and have the Store validate it with exactly the rules the desktop app applied, so that a package that passed locally never fails server-side for a different reason.
4. As a Publisher, I want the Store to reject a package whose `id` publisher segment is not my login, so that nobody can publish under my name and I cannot accidentally publish under someone else's.
5. As a Publisher, I want the Store to reject a version that is not greater than every version I already published, so that version history is monotonic.
6. As a Publisher, I want a published Harness Version to be immutable, so that Users who installed it can trust that what they reviewed is what they run.
7. As a Publisher, I want to Unpublish a version, so that I can withdraw a bad release without breaking existing installs.
8. As a Publisher, I want the Store to keep serving my Harness's previous published version after I Unpublish the latest, so that Unpublishing is not a takedown.
9. As a Publisher, I want a clear structured error (field path, code, message) when my package is rejected, so that I can fix it without guessing.
10. As a Publisher, I want a rate limit that stops runaway scripts from publishing hundreds of versions a day, so that a mistake in my CI does not flood the Store.
11. As a User, I want to browse and search the Store without an account, so that I am never asked to sign up just to look.
12. As a User, I want to download a Harness Package without an account, so that installing has no registration wall.
13. As a User, I want the Store to only ever show me active Harnesses and published versions, so that unpublished or taken-down content never appears in lists, search or detail pages.
14. As a User, I want the download endpoint to give me the checksum and size along with the URL, so that my app can verify integrity before unpacking.
15. As a User, I want the download endpoint to refuse a platform the version does not support, so that I do not download something that cannot run.
16. As a User, I want the download endpoint to resolve "latest published version" for me when I do not name one, so that install and update logic on the client stays simple.
17. As a User, I want my downloads counted without my identity or IP being stored, so that Publishers get numbers and I keep my privacy.
18. As a User, I want to report a Harness anonymously, so that I do not need an account to flag something harmful.
19. As a User, I want repeated reports from the same source rate-limited, so that the reports queue is not spammable.
20. As a Store administrator, I want to take down a version or a whole Harness, so that harmful content disappears from lists, search and download immediately.
21. As a Store administrator, I want takedown to resolve the related open Reports, so that the queue reflects reality.
22. As a Store administrator, I want to mark a Harness as Featured with an explicit rank, so that the Store home can show a curated row.
23. As a Store administrator, I want RLS to prevent any anon or Publisher key from writing to catalogue tables directly, so that the only write path is a validated Edge Function.
24. As a developer on the desktop app, I want a `search_harnesses` RPC that returns ranked results with everything a list card needs, so that the client does not join tables itself.
25. As a developer on the desktop app, I want a `latest_versions` RPC that returns, for a batch of installed Harness IDs, the latest published version plus its permissions and Entry kind, so that the client can decide whether an update needs re-consent without downloading the package.
26. As a developer, I want a Supabase local stack with migrations and seed data (at least three Harnesses with published versions, one Unpublished version, one Featured), so that every downstream spec has realistic data to develop and test against.
27. As a developer, I want the Edge Functions to import the shared Manifest package rather than reimplementing validation, so that the rules cannot drift.
28. As a developer, I want the Store to return a consistent `{ error: { code, message } }` shape and documented HTTP statuses, so that the client can map errors to translated UI copy by code.
29. As a security reviewer, I want packages in a private bucket and assets in a public read-only bucket, so that only the intended files are ever publicly reachable.
30. As a security reviewer, I want signed download URLs to expire quickly, so that a leaked URL is worthless within a minute.

## Implementation Decisions

- **Tables, enums, triggers and buckets** are exactly those in `docs/tech/data-model.md` §1. Migrations are checked into the Store app and applied with the Supabase CLI; there is no manual schema editing.
- **Profile creation**: a trigger on new auth users inserts a `profiles` row with `github_login` taken from the OAuth identity, lower-cased. If the login changes on GitHub, the profile keeps the original login in P0 (Harness IDs must stay stable); a later phase may handle renames.
- **Immutability**: an UPDATE trigger on `harness_versions` raises an error if any column other than `status`, `download_count`, `unpublished_at` changes once `status = published`. DELETE is denied to everyone except the service role in a migration.
- **Denormalisation**: after every publish/unpublish/takedown, the function recomputes on `harnesses`: `latest_version` (highest published version by `semver_key`), `name`, `summary`, `tags`, `icon_path` (from that version), and `download_count` (sum of versions). A Harness with no published version keeps `status = active` but has `latest_version = null` and is excluded from search and Featured rows.
- **Semver ordering** uses a stored integer array key `[major, minor, patch, prereleaseFlag]` where a pre-release sorts below the same release; comparison "greater than all published versions" includes Unpublished and taken-down versions so a withdrawn version number can never be reused.
- **Search** is Postgres full-text over the generated `search` column using `websearch_to_tsquery('simple', q)` (language-neutral so Chinese names and tags match on exact tokens), ranked by `ts_rank` then `download_count` desc then `published_at` desc. Empty query returns most downloaded. Tag filter is an array containment; platform filter checks the latest version's `platforms`. Page size default 24, max 60.
- **RLS**: anon and authenticated roles can SELECT `harnesses` where `status = active`, `harness_versions` where `status = published` and the parent is active, public columns of `profiles`. Publishers can UPDATE their own `profiles` row (display name, bio). No INSERT/UPDATE/DELETE policies on catalogue tables for any JWT role; the functions use the service role. Admins are recognised by `profiles.is_admin = true` looked up inside functions (not by a JWT claim, to keep P0 simple).
- **Edge Function contracts** follow `docs/tech/api.md`. Additional pinned behaviours:
  - `publish` streams the zip to a temp location, enforces the 500 MB and 20 000-file limits while reading, and rejects symlinks, absolute paths and `..` segments before validation. On success it uploads the package first, then assets, then inserts rows in one transaction; on any failure after upload it deletes uploaded objects.
  - `publish` rate limit: 20 successful publishes per Publisher per rolling 24 h, checked by counting `harness_versions.published_at`.
  - `download` inserts a `download_events` row and increments `harness_versions.download_count` and `harnesses.download_count` atomically; it returns the full Manifest so the client can render the consent dialog before unpacking. Signed URL expiry is 60 seconds.
  - `unpublish` is idempotent; unpublishing an already-unpublished version returns success.
  - `report` accepts anonymous calls; rate limit 5 per hour per IP using an in-memory counter per function instance plus a best-effort table check (`reports` by `client_info.install_id` when present). Not perfectly strict by design.
  - `admin/takedown` requires an authenticated caller with `is_admin`; without `version` it sets the Harness `status = taken_down` and all its versions to `taken_down`; with `version` only that version. It sets `status = resolved` with the note on open Reports for the affected Harness.
- **Featured** is set by administrators directly in the database (Supabase Studio) in P0; no function. `featured_rank` unique among non-null values.
- **Storage paths**: `harness-packages/<publisher>/<slug>/<version>.zip`; `harness-assets/<publisher>/<slug>/<version>/icon.png` and `.../screenshots/<n>.<ext>`. Asset bucket is public read, no listing.
- **Environment**: functions read the Store's own service key from function secrets; nothing Provider-related exists anywhere in the Store.
- **Local development**: `supabase start` plus a seed script that publishes the two reference Harnesses from P0-06 (when available; until then, fixture packages from P0-01) and one synthetic third Harness, marks one Featured, and Unpublishes one version, so lists, detail pages and update checks all have data.

## Testing Decisions

- **Seam**: the Store seam (architecture §8, item 4): run the Supabase local stack and exercise Edge Functions and PostgREST over HTTP. Tests never call internal function helpers; they observe HTTP responses and subsequent HTTP reads.
- **Good tests** assert externally visible behaviour: a publish with a mismatched publisher segment returns 403 with code `publisher_mismatch` and no rows appear; a second publish with an equal version returns 409; after Unpublish the detail read no longer lists that version but the previous one is `latest_version`; a download for an unsupported platform returns 4xx and does not increment counters; an anon UPDATE against `harnesses` via PostgREST is rejected; a signed URL fetched after 61 seconds fails.
- **Fixtures**: fixture packages from P0-01 (valid, each failure class, oversized, zip-slip); a test GitHub identity is simulated by creating auth users directly with the service role and minting JWTs, so tests do not hit GitHub.
- **Search tests** use seeded rows with English and Chinese names and check ranking order and filters.
- **Prior art**: none in the repo yet; this spec establishes the pattern (a `store-test` harness that boots the local stack once per test run).

## Out of Scope

- The Publish UI, local validation UX and metadata form (P0-08).
- Store browsing UI and detail page rendering (P0-09).
- Client download, verification, consent and install (P0-10).
- Report UI and admin tooling beyond the takedown function (P0-12).
- Payments, entitlements, reviews, telemetry tables, organisations (P1/P2; reserved names listed in the data model).
- Handling GitHub login renames.

## Further Notes

- Keep the functions thin; business rules that can live in SQL (immutability trigger, semver key, denormalisation) should, so they hold regardless of which function writes.
- The same `packages/manifest` code runs in Deno (Edge Functions) and Node (desktop); the package must stay free of Node-only APIs.

## Blocked by

- P0-01 Monorepo scaffold and Manifest package
