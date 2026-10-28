# Store API

The Store exposes data through Supabase PostgREST (reads) and Edge Functions (writes and anything needing the service role). The desktop app uses the anon key for reads and the User's session JWT for Publisher actions. All responses are JSON; errors are `{ "error": { "code", "message" } }`.

## Reads (PostgREST, anon)

Row-level security decides what is visible (see [`data-model.md`](./data-model.md) §1, RLS summary): a Harness is readable only when it is active and has a published version, and a Harness Version only when it is published and its Harness is active. Reads therefore never repeat those filters. `profiles` exposes only its public columns, so reads of it name their columns (a `select=*` is refused); reads of `harnesses` for lists name theirs too, so the `search` vector is not sent.

| Purpose | Call |
|---|---|
| Featured (home) | `harnesses?featured_rank=not.is.null&order=featured_rank&limit=12&select=<list columns>` |
| Most downloaded (home) | `harnesses?order=download_count.desc,harness_id&limit=12&select=<list columns>` |
| New (home) | `harnesses?order=latest_published_at.desc,harness_id&limit=12&select=<list columns>` |
| Search | RPC `search_harnesses(q text, tags text[], platform text, limit int, offset int)` (`POST rpc/search_harnesses` with a JSON body) → ranked rows `{ harness_id, publisher_login, name, summary, icon_path, tags, platforms, download_count, latest_version, latest_published_at }`, see below |
| Harness detail | `harnesses?harness_id=eq.<id>&select=*,profiles(github_login,display_name,avatar_url),harness_versions(version,changelog,published_at,platforms,status,download_count)` (published versions only via RLS) |
| Version manifest | `harness_versions?harness_id=eq.<uuid>&version=eq.<v>&select=manifest,readme,package_sha256,package_size,screenshot_paths` |
| Publisher page | `profiles?github_login=eq.<login>&select=github_login,display_name,avatar_url,bio,created_at,harnesses(<list columns>)&harnesses.order=download_count.desc,harness_id` |
| Update check | RPC `latest_versions(harness_ids text[])` (`POST rpc/latest_versions` with `{ "harness_ids": [...] }`) → `[{ harness_id, store_status, latest_version, manifest }]`, see below |

`<list columns>` is `harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at`. `icon_path` is relative to the `harness-assets` bucket: the client shows `<Store base URL>/storage/v1/object/public/harness-assets/<icon_path>`. The home rows (P0-07.5) and the Publisher page need no filter of their own: row-level security leaves only active Harnesses with a published version, in Featured, Most downloaded, New and in the Publisher's nested `harnesses` alike (a Publisher with none still has their profile row, with `harnesses: []`). `harness_id` breaks ties so the order is stable. The indexes behind them: the unique constraint on `featured_rank`, and `harnesses (download_count desc)` and `harnesses (latest_published_at desc)`.

`search_harnesses` (P0-07.5) is Postgres full-text search over the `search` column (maintained by `refresh_harness`, not generated: the `simple` configuration, with the name weighted A, the tags B, the summary C and the first 50 K characters of the latest version's README D):
- `q`: `websearch_to_tsquery('simple', q)` syntax (`"a phrase"`, `or`, `-word`); case does not matter, words are not stemmed. A null, blank or wordless `q` (only punctuation) means no text filter.
- `tags`: the Harness has every one of them (`tags @> …`); null or `[]` means no filter. `platform`: the latest version's `platforms` contains it; null means any, an unknown one matches nothing (no error).
- Order: `ts_rank` when there is a text query, then `download_count` desc, then `latest_published_at` desc, then `harness_id`. Without a text query that is most downloaded first.
- `limit`: 24 when null, clamped to 1…60; `offset`: 0 when null, a negative one is 0. Out-of-range values are clamped, never refused (only a value of the wrong type is a PostgREST `400`). There is no total count: a page shorter than `limit` is the last one ("Load more" stops).
- Call it with `POST` and a JSON body: in a `GET`, PostgREST would read `limit` and `offset` as its own paging parameters.
- `publisher_login` is the publisher segment of `harness_id`; `platforms` are the latest version's (for the platform badges).
- Chinese and other unsegmented scripts: the `simple` parser keeps a run of CJK characters as one token, so a whole name or word matches (`写作助手`) and a part of one does not (`写作`). Substring search in Chinese is not supported in P0. Manifest `tags` are a closed English list; the desktop app translates the tag chips.
- It is `SECURITY INVOKER`: row-level security decides what it can return, exactly as for every other read, and it repeats no visibility filter. The desktop app calls it with the anon key.

`latest_versions` (P0-07.4) answers one row per requested Harness ID, in the order given (duplicates included), at most 1000 IDs per call (more is `400`, SQLSTATE `22023`):
- `store_status`: `available` (active, with a published version), `unpublished` (no published version left), `taken_down` (the Harness was taken down) or `not_found` (no such Harness).
- `latest_version` and `manifest`: only when `available`, else `null`. `manifest` is the full stored Manifest of the latest published version, so it has everything `diffForReconsent(installed, latest)` compares (`permissions`, `runtime`, `entry`) and the `changelog`. Nothing of any other version, and nothing but the status of a Harness that is not available, is ever returned.
- It reports the Harness's status only: no version-level Takedown is reported in P0, not even one of the latest version, and the takedown note is never public. Taking down the latest version (or Unpublishing it) moves the Harness's `latest_version` back to the previous published version, so the row then says `available` with that earlier version, possibly lower than the one the User has installed, or `unpublished` when no published version is left. A client must offer an update only when `latest_version` is greater than the installed version, never because it differs.
- It is `SECURITY DEFINER` (row-level security would hide the taken-down and Unpublished-only Harnesses whose status it reports) and callable by anon and authenticated.

## Publisher sign-in (Supabase Auth)
GitHub is the only sign-in, and only Publishers sign in (P0-07.2). The desktop app's Runtime runs the OAuth PKCE flow itself, against Supabase Auth's GitHub provider; the renderer never sees a token. Every call carries `apikey: <anon key>`.

1. The Runtime makes a PKCE verifier (32 random bytes, base64url) and opens the User's default browser (never a window of the app) on `GET /auth/v1/authorize?provider=github&redirect_to=harnessstore://auth-callback&code_challenge=<base64url(sha256(verifier))>&code_challenge_method=s256`. Auth sends the browser to GitHub's consent screen, then back to `/auth/v1/callback`, then to `harnessstore://auth-callback?code=<auth code>` (or `?error=…&error_description=…`). `harnessstore://auth-callback` is in config.toml's `additional_redirect_urls`; the app registers the scheme with the OS.
2. `POST /auth/v1/token?grant_type=pkce` with `{ auth_code, code_verifier }` → `{ access_token, refresh_token, expires_in, expires_at, user: { id, … }, provider_token }`. The app keeps the access and refresh token, `expires_at` and `user.id`, encrypted (`secrets` row `store:session`, data-model.md §2); `provider_token`, GitHub's own token, is dropped.
3. The profile: `profiles?id=eq.<user.id>&select=github_login,display_name,avatar_url` with `authorization: Bearer <access_token>`. The row comes from the profile trigger (§1); without it the sign-in fails.
4. An access token that expires within 60 s is refreshed first: `POST /auth/v1/token?grant_type=refresh_token` with `{ refresh_token }` (refresh tokens rotate; the new session is stored encrypted again). A 4xx answer other than 429 ends the session (the app signs out and reports `session_expired`); no answer, a 429 or a 5xx keeps it.
5. Sign-out deletes the stored session, then `POST /auth/v1/logout?scope=local` with the access token (best effort, at most 5 s in all), which revokes the refresh token. Logout takes only an unexpired access token, so one that expires within 60 s is first exchanged as in step 4 (the new tokens are used for the logout only, never stored).
6. A session that does not decrypt (the OS keychain is locked or the prompt was denied) counts as signed out for that call but stays stored, so the next call or launch can read it; one that decrypts to something that is not a session is deleted. A Store call answering 401 ends the session (`session_expired`) only while the token it was made with is still the stored one.

## Edge Functions

### Errors of the Edge Functions
Every function answers an error with `{ "error": { "code", "message", ... } }`; `code` is stable and the desktop app maps it to translated copy, `message` is English for logs. Codes shared by the functions:

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | A body field is missing or malformed |
| 401 | `unauthenticated` | No JWT, an invalid or expired one, or a user with no `profiles` row (no GitHub login) |
| 403 | `forbidden` | Not the owner, or not an administrator |
| 404 | `not_found` | Unknown Harness or version, or one that is not visible |
| 405 | `method_not_allowed` | Anything but `POST` |
| 409 | `harness_taken_down` | `publish` or `unpublish` against a taken-down Harness or version |
| 422 | `platform_not_supported` | `download` for a platform the Harness Version does not declare |
| 429 | `rate_limited` | `publish` (20 per Publisher per 24 h) and `report` |
| 500 | `internal_error` | Anything unexpected (logged by the function) |

The functions check their own caller (config.toml `verify_jwt = false`): the Publisher and admin functions call Auth's `getUser` with the service role on the bearer token; `download` and `report` need no JWT. Only Auth's refusal of the token (a 401 or 403, or the codes `bad_jwt`, `no_authorization`, `user_not_found`, `session_not_found`, `session_expired`) is `401 unauthenticated`; Auth not answering (a network error, a 5xx, a 429) is `500 internal_error`, so the desktop app keeps the session and may retry. Every call still sends the anon key as `apikey`.

### `POST /functions/v1/publish` (Publisher JWT)
`multipart/form-data` with the Harness Package zip in the part `package`; other parts are ignored. Everything else comes from the Manifest (P0): the changelog is the Manifest's `changelog`.

Steps (P0-07.3):
1. Authenticate (`401 unauthenticated`).
2. Content-Length: none is `411 length_required`; over 500 MB plus 64 KB (multipart framing) is `413 package_too_large`, before the body is read. The exact limit is validatePackage's `archive_too_large`, on the zip itself.
3. Rate limit: 20 publishes per Publisher per rolling 24 hours, counted from `harness_versions.published_at`, any status (`429 rate_limited`).
4. Read the body into memory, open it with `ArchiveSource.open(bytes)` and run `validatePackage()` from `packages/manifest` with `publisher` (the caller's `github_login`) and `publishedVersions` (every version of that Harness, Unpublished and taken-down ones included), exactly what the desktop app runs. Nothing is reimplemented in the function.
5. A taken-down Harness gets no new version: `409 harness_taken_down`.
6. Read in full what the Store keeps besides the zip, before anything is uploaded: the icon, the screenshots and README.md (at most 1 MiB is kept). The Store keeps at most five screenshots, the first in package path order, and skips any over 2 MB: more, or larger, ones are only warnings for validatePackage, and the detail page shows up to five. An icon over 5 MB (the `harness-assets` limit per object; an honest 512×512 PNG is about 2 MB at most) is `413 package_too_large`. A full read checks each file's CRC-32 and size, which validatePackage does not (it reads only the start of the icon and the screenshots, and nothing of README.md): a file that cannot be read is `422 invalid_manifest` with an `archive_invalid` problem (`messageKey` `archive_invalid.entry`) at its path, built as validatePackage builds it.
7. Upload the package to `harness-packages/<publisher>/<slug>/<version>.zip`, then the icon and screenshots to `harness-assets` (paths in data-model.md), never overwriting: an object already there means another publish of this version (`409 version_not_greater`; it is not deleted).
8. `publish_version()` (SQL, service role only) inserts the Harness on its first version and the Harness Version in one transaction, under a per-Publisher lock, re-checking the rate limit and that no version was published since step 4 (else `409 version_not_greater`; a retry gives the up-to-date answer). Triggers refresh the Harness's listing fields.

On any failure after the first upload, the objects this request uploaded (and only those) are deleted, except when the outcome of step 8 is unknown: when the call to the database fails without an answer from PostgREST (a lost connection, a gateway timeout), its transaction may still commit, so the objects stay and the answer is `500 internal_error`.

`201` → `{ harness_id, version, url }`, where `url` is the in-app Store route `/store/h/<publisher>/<slug>` (there is no web Store page in P0).

When validatePackage refuses the package, the status comes from all its problems, in this order: `413 package_too_large` when any is `archive_too_large` or `archive_too_many_files`; else `422 invalid_manifest` when any is something other than `publisher_mismatch` and `version_not_greater` (archive safety included: symbolic links, `..` and absolute paths are `archive_symlink` and `archive_path_traversal` problems); else `403 publisher_mismatch`; else `409 version_not_greater`. Each of these bodies carries every problem, exactly as validatePackage returns them:

```json
{ "error": { "code": "invalid_manifest", "message": "…",
  "problems": [ { "path": "license", "code": "schema_required", "messageKey": "schema_required",
                  "params": { "key": "license" }, "message": "Required key \"license\" is missing." } ] } }
```

A `409 version_not_greater` from a publish that lost a race (step 7 or 8) has no `problems`. Other errors: `400 invalid_request` (not multipart, or no `package` part), `401`, `405`, `411`, `413` from the Content-Length or for an icon over 5 MB (no `problems`), `429`, `500`.

Known limitations (P0): the package is held in memory (an Edge Function has no disk to stream to), so publishing near the 500 MB limit needs more memory and a larger request than a hosted Edge Function allows; the gateway (and the local edge runtime) passes the Content-Length refusal on only once the whole body has arrived. A package object left by a crash between upload and commit, or kept because the database call's outcome was unknown, blocks that version number until it is removed by hand.

### `POST /functions/v1/download` (anon)
Body `{ harness_id, version?, platform, app_version }` (JSON). No account: the anon key is enough, and the function reads no `Authorization` header.

Steps (P0-07.4):
1. The body: `harness_id` a string; `version` absent, `null` or a string; `platform` one of the Manifest schema's platforms (`darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`); `app_version` a string of 1 to 64 characters. Anything else is `400 invalid_request`; other fields are ignored.
2. The version: the one named, else the Harness's `latest_version` (the latest published one). An unknown Harness, a taken-down one, one with no published version, and a named version that does not exist or is Unpublished or taken down are all `404 not_found`.
3. The platform: a version whose `platforms` does not include `platform` is `422 platform_not_supported`, before any URL is made and with nothing counted.
4. A signed URL to `harness-packages/<package_path>` that expires after 60 seconds, on the Store's public origin (the function's `STORE_PUBLIC_URL`, else `SUPABASE_URL`).
5. `record_download()` (SQL, service role only) counts the download in one transaction: a `download_events` row (`version_id`, `platform`, `app_version`, `created_at`; never an IP address or a user) and one more on `harness_versions.download_count` and `harnesses.download_count`. It checks under the row locks that the version is still published and its Harness still visible: an Unpublish or a Takedown that committed since step 2 is `404 not_found`, with nothing counted.

`200` → `{ url, sha256, size, manifest }`: the signed URL, the package's hex SHA-256 and size in bytes, and the version's stored Manifest. The Manifest is the `jsonb` the Store keeps, so its key order and whitespace are not those of the package's `manifest.json`: compare the two as JSON values (deep equality), not as bytes; the SHA-256 guards the package itself. Other errors: `405`, `500`.

The local stack sets `DOWNLOAD_URL_TTL_SECONDS` (supabase/functions/.env) to a few seconds so that the store tests can watch a URL expire; it only ever shortens the 60 s (1 to 60, anything else is 60), and a deployed Store does not set it.

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
