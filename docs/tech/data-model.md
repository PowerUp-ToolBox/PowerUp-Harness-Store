# Data Model

Two stores: the **Store** database (Supabase Postgres, shared) and the **local store** on each User's machine (SQLite in the app data directory). Neither holds conversation content; that lives in each Harness's Data Directory.

## 1. Store (Postgres)

Conventions: `uuid` primary keys, `timestamptz` timestamps, snake_case, RLS on every table. The schema lives in `apps/store/supabase/migrations`; migrations are the only way it changes.

### `profiles`
One row per signed-in Publisher, created by a trigger on `auth.users` (after insert, and after Auth writes the app metadata) when `raw_app_meta_data->>'provider' = 'github'`, which users cannot set: `github_login` = lower(`user_name`), `display_name` from `full_name` (else `name`), `avatar_url` from `avatar_url`, all from `raw_user_meta_data`. An existing profile is never changed by the trigger (a GitHub rename keeps the original login in P0). Email signup is off, so nobody can claim a login through signup metadata.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | = `auth.users.id`; `on delete cascade` |
| `github_login` | text unique not null | lower-cased; forms the `publisher` segment of Harness IDs. Becomes nullable in P2-03 for non-Publisher accounts; publishing still requires it |
| `display_name` | text | |
| `avatar_url` | text | |
| `bio` | text | ≤ 500 chars, editable |
| `is_admin` | bool | default false; set manually |
| `created_at` | timestamptz | |

### `harnesses`
One row per Harness (the thing with an ID); versions live in `harness_versions`.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `publisher_id` | uuid FK profiles | `on delete restrict` |
| `slug` | text | unique per publisher |
| `harness_id` | text unique | `github_login || '/' || slug`, set by a trigger on every write (a generated column cannot read `profiles`), denormalised for lookups |
| `name`, `summary` | text | copied from the latest published version |
| `tags` | text[] | from the latest published version; GIN index |
| `icon_path` | text | path in `harness-assets` of the latest published version's icon, `<publisher>/<slug>/<version>/icon.png` |
| `latest_version` | text null | highest published version by `semver_key` (ties: latest `published_at`); null when none is published |
| `latest_published_at` | timestamptz null | `published_at` of `latest_version`; indexed, for the "New" home row and the search tiebreak (PostgREST cannot order by an embedded column) |
| `status` | enum `active` \| `taken_down` | |
| `featured_rank` | int null | non-null = Featured; ascending order; unique among non-null values |
| `download_count` | bigint | denormalised sum of versions |
| `search` | tsvector | set by a trigger (it reads `harness_versions`, which a generated column cannot): `simple` configuration, weights name A, tags B, summary C, the first 50 K characters of the README D; GIN index |
| `created_at`, `updated_at` | timestamptz | |

`refresh_harness(id)` recomputes `latest_version`, `latest_published_at`, `name`, `summary`, `tags`, `icon_path`, `search` and `download_count` from the versions. An `after insert` and an `after update of status` trigger on `harness_versions` call it, so the fields hold whoever writes. With no published version left, only `latest_version` and `latest_published_at` become null; the last listing fields stay (the Harness is hidden by RLS anyway). It locks the `harnesses` row (`for update`) before reading the versions, so two writers of different versions of one Harness (an Unpublish and a Takedown, a download and an Unpublish) cannot leave a latest version or download count read before the other one committed.

### `harness_versions`
Immutable: an UPDATE trigger allows only `status`, `download_count`, `unpublished_at` and `takedown_note` to change, whatever the row's status (rows are only ever inserted as published). `status` only moves forward: `published` → `unpublished`, any status → `taken_down`. A new row whose `semver_key` sorts below an existing version of the same Harness is refused (a backstop: the full semver check, pre-release included, is validatePackage's `publishedVersions` option in `publish`).

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `harness_id` | uuid FK harnesses | |
| `version` | text | semver; unique per harness |
| `semver_key` | bigint[] generated | `[major, minor, patch, release flag]`, flag 0 for a pre-release and 1 for a release, so 1.1.0-beta.1 < 1.1.0. Pre-releases of one MAJOR.MINOR.PATCH share a key; since every publish is greater than all earlier versions, publish order is semver order, so `order by semver_key, published_at` sorts versions |
| `manifest` | jsonb | full validated Manifest |
| `readme` | text | README.md, at most 1 MiB kept (cut at a UTF-8 character boundary, NUL characters dropped); a long README is only a warning, never rejected |
| `changelog` | text null | |
| `platforms` | text[] | copied from manifest |
| `permissions` | jsonb | copied from manifest, for diffing on update |
| `package_path` | text | path in `harness-packages`, `<publisher>/<slug>/<version>.zip` |
| `package_sha256` | text | hex |
| `package_size` | bigint | bytes |
| `screenshot_paths` | text[] | paths in `harness-assets`, `<publisher>/<slug>/<version>/screenshots/<n>.<ext>`; at most five (see Storage buckets) |
| `status` | enum `published` \| `unpublished` \| `taken_down` | |
| `download_count` | bigint | |
| `published_at`, `unpublished_at` | timestamptz | |
| `takedown_note` | text null | ≤ 2000 chars; the administrator's note, copied by `admin/takedown` onto every version it changes; only ever set on a `taken_down` version (check constraint), readable by the owning Publisher only (P0-07.6) |

### `reports`

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `harness_id` | uuid FK | |
| `version_id` | uuid FK null | |
| `reporter_id` | uuid FK profiles null | anonymous allowed |
| `reason` | enum `malware` \| `bypasses_gateway` \| `broken` \| `inappropriate` \| `spam` \| `other` | |
| `details` | text | ≤ 2000 chars |
| `client_info` | jsonb | `install_id`, `app_version`, `platform` only (the `report` function drops anything else); never an IP address. Indexed on `install_id` for the rate limit |
| `status` | enum `open` \| `resolved` \| `dismissed` | |
| `resolution_note` | text null | admin only; set to the takedown's note when `admin/takedown` resolves the Report, or to the administrator's note when the admin CLI's `reports dismiss` dismisses it (P0-12.2) |
| `created_at`, `resolved_at` | timestamptz | |

Written only by `submit_report(...)` (service role only, called by the `report` function), which also checks the per-install rate limit (5 per hour) under an advisory lock per install id. `take_down(...)` resolves every `open` Report of the Harness it takes down. The admin CLI (P0-12.2, `apps/store/scripts/admin.ts`) reads them and dismisses an `open` one with the service role (`status = dismissed`, `resolution_note`, `resolved_at`); a dismissal is not logged in `admin_actions`.

### `admin_actions` (append-only audit log; P0-07.6)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `admin_id` | uuid FK profiles null | the administrator; `on delete set null`, so the log outlives the account |
| `action` | enum `takedown_harness` \| `takedown_version` | Featured changes are made in Supabase Studio and not logged in P0 |
| `target_harness_id` | uuid FK harnesses | `on delete cascade` (no function deletes a Harness) |
| `target_version_id` | uuid FK harness_versions null | set for `takedown_version` only (check constraint) |
| `note` | text | 1 to 2000 chars |
| `created_at` | timestamptz | |

One row per `admin/takedown` call, written by `take_down(...)` (service role only) in the same transaction as the status changes, also when what it names was already taken down.

### `download_events` (append-only, for later analytics; P0 just inserts)

| column | type |
|---|---|
| `id` bigserial | |
| `version_id` uuid | |
| `platform` text | |
| `app_version` text | |
| `created_at` timestamptz | |

No IP or user identity stored: no column could hold one, and its only reference is to the Harness Version. `record_download(version_id, platform, app_version)` (service role only, called by the `download` function) inserts the row and adds one to `harness_versions.download_count` and `harnesses.download_count` in one transaction, after checking under the row locks that the version is still published and its Harness still visible (version row locked first, Harness row second, as every writer does).

### Added by P0 specs after this baseline
- `admin_actions` (audit log of takedowns), `harness_versions.takedown_note` and the owner read policy on `harness_versions` (a Publisher reads their own versions in any status, with the note) — P0-07.6. P0-08 ("My Harnesses") and P0-12 (Report and takedown) use them and add no schema of their own.

### Reserved for later phases (create in the phase that needs them)
`purchases`, `entitlements`, `payouts` (P1-01); `reviews` (P1-04); `telemetry_events` (P1-06); `channels` are a column on versions already; `organizations`, `org_members`, `harness_visibility` (P2-04); `subscriptions`, `credit_ledger` (P2-01/02).

### RLS summary
Every catalogue write uses the service role inside an Edge Function. anon and authenticated have no INSERT, UPDATE or DELETE privilege on any catalogue table and there is no write policy for them either, so an attempt fails with `42501 permission denied`. Internal SQL functions (`semver_key`, `refresh_harness`, the trigger functions, `publishes_remaining` and `publish_version`, which only the `publish` function calls, `record_download`, which only `download` calls, and `unpublish_version`, `submit_report` and `take_down`, which only `unpublish`, `report` and `admin` call) have EXECUTE revoked from `public`, `anon` and `authenticated`, so PostgREST does not expose them as RPCs. The public RPCs are granted to `anon` and `authenticated` explicitly: `latest_versions(harness_ids text[])` (P0-07.4) is `SECURITY DEFINER` with a fixed `search_path`, because it reports taken-down and Unpublished-only Harnesses that RLS hides; it returns only their status, and only the latest published version's `version` and `manifest` of an available one (api.md). `search_harnesses(q, tags, platform, limit, offset)` (P0-07.5) is `SECURITY INVOKER` (with a fixed `search_path`), so row-level security alone decides which Harnesses it returns; it returns the composite type `harness_search_result` (a list card's columns, api.md).
- `profiles`: anon and authenticated may SELECT only `id`, `github_login`, `display_name`, `avatar_url`, `bio`, `created_at` (column privileges; `is_admin` stays private, so a `select=*` is refused). The owner may UPDATE `display_name`, `bio` and `avatar_url` only (column privileges plus a row policy `auth.uid() = id`).
- `harnesses`: public read where `status = active and latest_version is not null`. This one rule hides taken-down and Unpublished-only Harnesses from Featured, home, search, detail and Publisher pages, with no query repeating the filter.
- `harness_versions`: public read where `status = published` and the parent is active. Owner read (authenticated, P0-07.6): a Publisher reads every version of their own Harnesses, any status, `takedown_note` included. Which Harnesses are theirs comes from `private.own_harness_ids()`, a `SECURITY DEFINER` function in the `private` schema (not exposed by PostgREST; EXECUTE for `authenticated` only): a subquery on `harnesses` in the policy would run under that table's RLS, which hides exactly the Unpublished-only and taken-down Harnesses. There is deliberately no owner policy on `harnesses`: it would put a Publisher's own hidden Harnesses into the home rows, search and Publisher page read with their session, which repeat no visibility filter.
- `reports`: no access for anon or authenticated; the `report` function inserts with the service role, administrators read and dismiss them with the admin CLI (service role) or in Studio.
- `admin_actions`: no access for anon or authenticated (RLS on, no policy); the `admin` function inserts with the service role, administrators read in Studio.
- `download_events`: no access for anon or authenticated; the `download` function inserts with the service role.

### Storage buckets
Created by a migration. Paths are relative to their bucket (no bucket prefix in any stored path). No policy on `storage.objects` mentions either bucket, so anon and authenticated can neither list nor write.
- `harness-packages` (private, 500 MiB per object, `application/zip`): `<publisher>/<slug>/<version>.zip`. Downloads only via signed URL from the `download` function (60 s expiry).
- `harness-assets` (public, read-only, 5 MiB per object, `image/png` and `image/jpeg`): `<publisher>/<slug>/<version>/icon.png`, `.../screenshots/<n>.<ext>`, where `n` is the 0-based index of the screenshots in package path order and `ext` the original extension, lower-cased. Only what the Store shows is kept: at most five screenshots, the first in package path order, skipping any over 2 MB (validatePackage only warns about more or larger ones). `publish` refuses an icon over 5 MiB.

## 2. Local store (SQLite, desktop)

| table | purpose | key columns |
|---|---|---|
| `installs` | installed Harnesses, one version per Harness | `harness_id` PK, `version`, `manifest` json, `install_path`, `data_dir`, `installed_at`, `last_launched_at`, `last_workspace`, `consented_permissions` json, `available_version` and `available_manifest` json (from the update check: the newer version the Store offers and its full Manifest, set only for a version greater (semver) than the installed one that declares this platform, else null; an install clears them), `store_status` (from the update check: `available`, `unpublished`, `not_found` stored as `unpublished`, or `taken_down`; null before the first check and for a local install), `source` (`store` or `local`: installed from a local folder with "Install this folder locally", never updated from the Store), `state` (`installed`, or a Store install under way: `downloading`, `verifying`, `awaiting_consent`, `unpacking`; written once the Store's `download` function answered, with that version's Manifest and Declared Permissions; a failed or cancelled install deletes its row, so there is no failed or cancelled state; only `installed` rows are installed Harnesses, and every other row is deleted at startup with the downloads of the installs the app stopped in), `takedown_acknowledged` (0 or 1, P0-12.2: the User confirmed "Launch anyway" for a `taken_down` install, so Launch asks once per Takedown; set back to 0 whenever the update check changes `store_status`, and when a local install replaces the row) |
| `connections` | Provider Connections | `id` PK (`anthropic`, `openai-compatible:<slug>` …), `provider_id`, `display_name`, `base_url` (NULL = the Provider's default), `secret_ref` (row id in `secrets`, NULL without a key), `key_hint` (last 4 characters of the key, `''` for a key under 12 characters, so the masked key is shown without decrypting), `enabled`, `last_tested_at` (ISO-8601 UTC), `last_test_ok`, `last_test_error` (the Provider's own text), `last_test_failure` (`provider_timeout` or `unexpected_response` when the last test failed without Provider text, else NULL), `test_model` (the model the User named for the last passed test, which later tests reuse; NULL for the catalogue's) |
| `secrets` | encrypted blobs | `id` PK (= the Connection id, or `store:session` for the Publisher's Store session: access and refresh token, user id, expiry and the last profile read, as JSON; never GitHub's own token), `ciphertext` blob (Electron safeStorage), `created_at` |
| `slot_bindings` | Slot Bindings | `scope` (`global` or `harness:<id>`), `slot`, `provider_id` (the Connection id, e.g. `openai-compatible:vllm`; no foreign key, removing a Connection deletes its rows in the same transaction), `model`; PK (`scope`, `slot`) |
| `usage_records` | Usage Records | as defined in gateway-protocol §7; indexes on (`harness_id`, `timestamp`) and on `timestamp` (the Usage page's periods over every Harness, P0-11.1). The Usage page aggregates it in SQL and Clear usage data deletes every row; nothing in it ever leaves the machine |
| `settings` | key/value | `locale`, `update_check_interval` (`1h`, `6h`, `24h` or `never`; absent means `6h`), `store_base_url` (an http(s) URL without a trailing slash; absent means the build's default Store, and setting the default removes it), `onboarding_done`, and main's own keys, which `settings.get` never answers: `window_state`, `install_id` (a random UUID made the first time a Report needs it, P0-12.1; sent only as the Report's `client_info.install_id`) and `report_history` (P0-12.1: Harness ID → the ISO-8601 times of this install's Reports of it that the Store took (201), for the client-side limit of 3 per Harness in 24 hours; entries older than 24 hours are dropped on every write) |
| `launches` | audit of launches | `launch_id` PK, `harness_id`, `version`, `started_at`, `ended_at`, `exit_code` (128 + the signal number for a process a signal ended; NULL when unknown), `token_revoked_at`; index on (`harness_id`, `started_at`). A row is written when the launch's Gateway Token is issued; rows a crash of the app left open are closed at the next start (`ended_at` and `token_revoked_at` set to that time, `exit_code` NULL) |

Global Slot Bindings for `default` are the User's Default Model. Rows with scope `harness:<id>` are Model Overrides.

Uninstalling a Harness deletes its install folder, then its Data Directory, then its `installs` row and its Model Overrides (`slot_bindings` of scope `harness:<id>`) in one transaction; its `launches` rows, Usage Records and launch logs are kept.

Install layout on disk (app data root: Electron's `userData` folder, which `HARNESS_STORE_USER_DATA_DIR` overrides):
```
harnesses/<publisher>/<slug>/<version>/   unpacked package (read-only intent)
data/<publisher>/<slug>/                  Data Directory (survives updates, deleted on uninstall)
logs/<publisher>/<slug>/<launchId>.log    launch logs, at most 10 MB each, the 20 newest per Harness (kept on uninstall, which writes its time to `uninstalled-at` beside them; at each start, those of a Harness no longer installed are deleted once both they and its uninstall are 30 days old)
downloads/                                temp: Store downloads (download-<jobId>.zip), install copies (install-*) before they are renamed into harnesses/, and a reinstalled version moved aside (replaced-*); what an interrupted install left is cleaned up at startup
harness-store.sqlite
```
