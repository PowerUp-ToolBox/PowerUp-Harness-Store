# Data Model

Two stores: the **Store** database (Supabase Postgres, shared) and the **local store** on each User's machine (SQLite in the app data directory). Neither holds conversation content; that lives in each Harness's Data Directory.

## 1. Store (Postgres)

Conventions: `uuid` primary keys, `timestamptz` timestamps, snake_case, RLS on every table.

### `profiles`
One row per signed-in Publisher, created by a trigger on `auth.users` insert.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | = `auth.users.id` |
| `github_login` | text unique | lower-cased; forms the `publisher` segment of Harness IDs. Becomes nullable in P2-03 for non-Publisher accounts; publishing still requires it |
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
| `publisher_id` | uuid FK profiles | |
| `slug` | text | unique per publisher |
| `harness_id` | text unique | generated `github_login || '/' || slug`, denormalised for lookups |
| `name`, `summary` | text | copied from the latest published version |
| `tags` | text[] | from the latest published version; GIN index |
| `icon_path` | text | storage path in `harness-assets` |
| `latest_version` | text null | highest published, non-unpublished version |
| `status` | enum `active` \| `taken_down` | |
| `featured_rank` | int null | non-null = Featured; ascending order |
| `download_count` | bigint | denormalised sum of versions |
| `search` | tsvector generated | from name, summary, tags, README of latest version |
| `created_at`, `updated_at` | timestamptz | |

### `harness_versions`
Immutable once `status = published` (an UPDATE trigger allows only `status`, `download_count` and `unpublished_at` to change).

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `harness_id` | uuid FK harnesses | |
| `version` | text | semver; unique per harness; `semver_key` (int[]) for ordering |
| `manifest` | jsonb | full validated Manifest |
| `readme` | text | contents of README.md |
| `changelog` | text null | |
| `platforms` | text[] | copied from manifest |
| `permissions` | jsonb | copied from manifest, for diffing on update |
| `package_path` | text | storage path in `harness-packages` |
| `package_sha256` | text | hex |
| `package_size` | bigint | bytes |
| `screenshot_paths` | text[] | |
| `status` | enum `published` \| `unpublished` \| `taken_down` | |
| `download_count` | bigint | |
| `published_at`, `unpublished_at` | timestamptz | |

### `reports`

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `harness_id` | uuid FK | |
| `version_id` | uuid FK null | |
| `reporter_id` | uuid FK profiles null | anonymous allowed |
| `reason` | enum `malware` \| `bypasses_gateway` \| `broken` \| `inappropriate` \| `spam` \| `other` | |
| `details` | text | ≤ 2000 chars |
| `client_info` | jsonb | app version, platform |
| `status` | enum `open` \| `resolved` \| `dismissed` | |
| `resolution_note` | text null | admin only |
| `created_at`, `resolved_at` | timestamptz | |

### `download_events` (append-only, for later analytics; P0 just inserts)

| column | type |
|---|---|
| `id` bigserial | |
| `version_id` uuid | |
| `platform` text | |
| `app_version` text | |
| `created_at` timestamptz | |

No IP or user identity stored.

### Added by P0 specs after this baseline
- `admin_actions` (audit log of takedowns and Featured changes) and `harness_versions.takedown_note` — P0-12.
- RLS: a Publisher can read their own `unpublished` versions — P0-08.

### Reserved for later phases (create in the phase that needs them)
`purchases`, `entitlements`, `payouts` (P1-01); `reviews` (P1-04); `telemetry_events` (P1-06); `channels` are a column on versions already; `organizations`, `org_members`, `harness_visibility` (P2-04); `subscriptions`, `credit_ledger` (P2-01/02).

### RLS summary
- `profiles`: public read of `github_login`, `display_name`, `avatar_url`, `bio`; owner update.
- `harnesses`: public read where `status = active`; insert/update by owner (via Edge Function only, service role) ; admins all.
- `harness_versions`: public read where `status = published` and parent active; writes via Edge Functions only.
- `reports`: insert by anyone (rate-limited in the function), read/update by admins.
- `download_events`: insert via function only; read by admins.

### Storage buckets
- `harness-packages` (private): `<harness_id>/<version>.zip`. Downloads only via signed URL from the `download` function (60 s expiry).
- `harness-assets` (public, read-only): `<harness_id>/<version>/icon.png`, `.../screenshots/<n>.png`.

## 2. Local store (SQLite, desktop)

| table | purpose | key columns |
|---|---|---|
| `installs` | installed Harnesses | `harness_id` PK, `version`, `manifest` json, `install_path`, `data_dir`, `installed_at`, `last_launched_at`, `last_workspace`, `consented_permissions` json, `available_version` (from update check) |
| `connections` | Provider Connections | `id` PK (`anthropic`, `openai-compatible:<name>` …), `provider_id`, `display_name`, `base_url`, `secret_ref` (row id in `secrets`), `enabled`, `last_tested_at`, `last_test_ok` |
| `secrets` | encrypted blobs | `id` PK, `ciphertext` blob (Electron safeStorage), `created_at` |
| `slot_bindings` | Slot Bindings | `scope` (`global` or `harness:<id>`), `slot`, `provider_id`, `model`; PK (`scope`, `slot`) |
| `usage_records` | Usage Records | as defined in gateway-protocol §7; index on (`harness_id`, `timestamp`) |
| `settings` | key/value | `locale`, `update_check_interval`, `store_base_url`, `onboarding_done` |
| `launches` | audit of launches | `launch_id`, `harness_id`, `version`, `started_at`, `ended_at`, `exit_code`, `token_revoked_at` |

Global Slot Bindings for `default` are the User's Default Model. Rows with scope `harness:<id>` are Model Overrides.

Install layout on disk (app data root):
```
harnesses/<publisher>/<slug>/<version>/   unpacked package (read-only intent)
data/<publisher>/<slug>/                  Data Directory (survives updates, deleted on uninstall)
downloads/                                temp
harness-store.sqlite
```
