# Store API

The Store exposes data through Supabase PostgREST (reads) and Edge Functions (writes and anything needing the service role). The desktop app uses the anon key for reads and the User's session JWT for Publisher actions. All responses are JSON; errors are `{ "error": { "code", "message" } }`.

## Reads (PostgREST, anon)

Row-level security decides what is visible (see [`data-model.md`](./data-model.md) §1, RLS summary): a Harness is readable only when it is active and has a published version, and a Harness Version only when it is published and its Harness is active. Reads therefore never repeat those filters. `profiles` exposes only its public columns, so reads of it name their columns (a `select=*` is refused); reads of `harnesses` for lists name theirs too, so the `search` vector is not sent.

| Purpose | Call |
|---|---|
| Featured list | `harnesses?featured_rank=not.is.null&order=featured_rank&select=harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at` |
| Search | RPC `search_harnesses(q text, tags text[], platform text, limit int, offset int)` → ranked rows with `harness_id, name, summary, icon_url, tags, download_count, latest_version, publisher_login` |
| Harness detail | `harnesses?harness_id=eq.<id>&select=*,profiles(github_login,display_name,avatar_url),harness_versions(version,changelog,published_at,platforms,status,download_count)` (published versions only via RLS) |
| Version manifest | `harness_versions?harness_id=eq.<uuid>&version=eq.<v>&select=manifest,readme,package_sha256,package_size,screenshot_paths` |
| Publisher page | `profiles?github_login=eq.<login>&select=github_login,display_name,avatar_url,bio,created_at,harnesses(harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at)` |
| Update check | RPC `latest_versions(harness_ids text[])` → `[{ harness_id, latest_version, permissions, entry_kind }]` |

Search is Postgres full-text (`websearch_to_tsquery`) over the `search` column (maintained by `refresh_harness`, not generated), ranked by `ts_rank` then `download_count`. `platform` filters `harness_versions.platforms @> ARRAY[platform]` on the latest version.

## Publisher sign-in (Supabase Auth)
GitHub is the only sign-in, and only Publishers sign in (P0-07.2). The desktop app's Runtime runs the OAuth PKCE flow itself, against Supabase Auth's GitHub provider; the renderer never sees a token. Every call carries `apikey: <anon key>`.

1. The Runtime makes a PKCE verifier (32 random bytes, base64url) and opens the User's default browser (never a window of the app) on `GET /auth/v1/authorize?provider=github&redirect_to=harnessstore://auth-callback&code_challenge=<base64url(sha256(verifier))>&code_challenge_method=s256`. Auth sends the browser to GitHub's consent screen, then back to `/auth/v1/callback`, then to `harnessstore://auth-callback?code=<auth code>` (or `?error=…&error_description=…`). `harnessstore://auth-callback` is in config.toml's `additional_redirect_urls`; the app registers the scheme with the OS.
2. `POST /auth/v1/token?grant_type=pkce` with `{ auth_code, code_verifier }` → `{ access_token, refresh_token, expires_in, expires_at, user: { id, … }, provider_token }`. The app keeps the access and refresh token, `expires_at` and `user.id`, encrypted (`secrets` row `store:session`, data-model.md §2); `provider_token`, GitHub's own token, is dropped.
3. The profile: `profiles?id=eq.<user.id>&select=github_login,display_name,avatar_url` with `authorization: Bearer <access_token>`. The row comes from the profile trigger (§1); without it the sign-in fails.
4. An access token that expires within 60 s is refreshed first: `POST /auth/v1/token?grant_type=refresh_token` with `{ refresh_token }` (refresh tokens rotate; the new session is stored encrypted again). A 4xx answer other than 429 ends the session (the app signs out and reports `session_expired`); no answer, a 429 or a 5xx keeps it.
5. Sign-out deletes the stored session, then `POST /auth/v1/logout?scope=local` with the access token (best effort), which revokes the refresh token.

## Edge Functions

### `POST /functions/v1/publish` (Publisher JWT)
Multipart: `package` (zip), `metadata` (JSON: `changelog?`). Steps: authenticate → unzip in memory (streaming, size limits) → `validatePackage()` from `packages/manifest` → check `id.publisher == profile.github_login` → check version greater than existing → upload package and assets → insert `harness_versions` (and `harnesses` if first version) → update denormalised columns. Returns `{ harness_id, version, url }`. Errors: `401`, `413 package_too_large`, `422 invalid_manifest` (with `problems[]`), `409 version_not_greater`, `403 publisher_mismatch`.

### `POST /functions/v1/download` (anon)
Body `{ harness_id, version?, platform, app_version }`. Resolves the version (latest published if omitted), checks the platform is supported, inserts a `download_events` row, increments counters, returns `{ url (signed, 60 s), sha256, size, manifest }`.

### `POST /functions/v1/unpublish` (Publisher JWT)
Body `{ harness_id, version }`. Marks the version `unpublished`, recomputes `latest_version`; if none remain the Harness stays `active` but is hidden from search (no latest version).

### `POST /functions/v1/report` (anon or JWT)
Body `{ harness_id, version?, reason, details, client_info }`. Rate limit: 5 per hour per IP (in-function, best-effort). Returns `{ id }`.

### `POST /functions/v1/admin/takedown` (admin JWT)
Body `{ harness_id, version?, note }`. Sets `taken_down` on the version or the whole Harness; resolves related reports.

## Desktop ↔ Runtime IPC (for completeness)
The renderer never calls the Store or Providers directly. It calls Runtime methods over typed IPC: `store.search`, `store.detail`, `installs.list/install/update/uninstall`, `launch.start/stop`, `providers.list`, `connections.list/add/update/test/testDraft/models/detectLocal/remove`, `bindings.getGlobal/setGlobal` (P0-03; `bindings.getForHarness/setOverride/clearOverride/resolveAll` follow with Model Overrides), `auth.signIn/signOut/whoami` (P0-07.2), `usage.query`, `publish.validateFolder/publish`, `settings.get/set`. Each method returns `{ ok, data } | { ok: false, error }`. Decrypted API keys and Store tokens never cross IPC: the renderer sees only a masked key (its last 4 characters) and the signed-in identity. Progress (downloads, uploads) is streamed as events.

The Store sign-in (§ Publisher sign-in above), in the Runtime:
- `auth.signIn` → `{ signedIn: true, githubLogin, displayName, avatarUrl }` once the browser came back and the session is stored. Errors: `encryption_unavailable` (no OS encryption; checked before the browser opens, and nothing is ever stored in plaintext), `sign_in_timeout` (no callback within 5 minutes), `sign_in_cancelled` (a newer `auth.signIn` or an `auth.signOut` replaced it), `sign_in_failed` (an `error` in the callback, a refused code, no profile, or no browser), `store_unreachable`.
- `auth.whoami` → `{ signedIn: false }` or the signed-in identity, with the profile read from the Store now (the stored copy while the Store does not answer).
- `auth.signOut` → `{ signedIn: false }`; also cancels a sign-in still waiting for its browser.
- Event `auth.changed`: the new state plus `reason`: `signed_in`, `signed_out` or `session_expired` (a refused refresh, a Store call answering 401, or a profile that no longer exists). The screen in use reacts to `session_expired` by asking to sign in again without losing its work (P0-08).
