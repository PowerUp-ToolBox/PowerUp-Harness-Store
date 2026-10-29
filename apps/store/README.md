# @harness-store/store

The backend of the **Store**: a Supabase project ([ADR-0006](../../docs/adr/0006-supabase-for-the-store.md)) that is the source of truth for Harnesses, **Harness Versions**, **Publishers**, **Reports** and download counts. Spec: [`P0-07`](../../docs/delivery/specs/P0-07-store-backend.md); schema: [`data-model.md`](../../docs/tech/data-model.md) §1; HTTP contract: [`api.md`](../../docs/tech/api.md).

## Layout

| Path                           | What                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/config.toml`         | Local stack settings (Supabase CLI). The GitHub provider's client id, secret and URL come from the environment (`supabase/.env.example`).                                                                                                                         |
| `supabase/migrations/`         | The schema: tables, enums, triggers, row-level security, Storage buckets. Migrations are the only way it changes.                                                                                                                                                 |
| `supabase/functions/_shared/`  | Plain TypeScript modules with relative imports only, used by the Deno Edge Functions, the seed script and the unit tests (storage paths, README storage, HTTP errors, the caller, the request rules of each function). Also `manifest.js`, generated (see below). |
| `supabase/functions/<name>/`   | The Deno Edge Functions (`Deno.serve` entry files, not type-checked by `tsc`; the store tests exercise them over HTTP): `publish`, `download`, `unpublish`, `report`, `admin`.                                                                                    |
| `supabase/functions/.env`      | The local Edge Functions' environment (committed, no secrets): `STORE_PUBLIC_URL`, and the test-only `DOWNLOAD_URL_TTL_SECONDS`.                                                                                                                                  |
| `supabase/functions/deno.json` | The functions' imports: supabase-js, pinned as an `npm:` specifier.                                                                                                                                                                                               |
| `scripts/bundle-manifest.ts`   | Bundles `@harness-store/manifest` (and its npm dependencies) into `supabase/functions/_shared/manifest.js` (gitignored); `pnpm build` runs it.                                                                                                                    |
| `scripts/seed.ts`              | Seeds the local stack from the `packages/manifest` fixture packages.                                                                                                                                                                                              |
| `scripts/admin.ts`             | The administrator's CLI (P0-12.2): list and dismiss Reports, take down a version or a Harness. See [Admin CLI](#admin-cli).                                                                                                                                       |
| `scripts/supabase.ts`          | Runs the pinned Supabase CLI with the env(...) values of config.toml filled in (`node dist/scripts/supabase.js start`).                                                                                                                                           |
| `test/`                        | Fast checks with no Docker (`pnpm test`): the shared modules and static rules every migration follows.                                                                                                                                                            |
| `test-store/`                  | The Store seam: tests over HTTP against a running local stack (`pnpm test:store`).                                                                                                                                                                                |

## Local stack

Needs Docker. The Supabase CLI is the pinned `supabase` devDependency, so nothing is installed globally. From this folder:

```sh
pnpm db:start        # build, then `supabase start`: applies every migration to an empty database
pnpm db:reset        # build, `supabase db reset` (migrations from empty again), then the seed
pnpm test:store      # the store tests (they seed again first)
pnpm functions:serve # build (with the manifest bundle), then serve the Edge Functions
pnpm db:stop
```

The package scripts and CI run the CLI through `scripts/supabase.ts`, which takes each variable of `supabase/.env.example` that neither the environment nor `supabase/.env` (gitignored, read by the CLI itself) sets. Those dummy values point Auth's GitHub provider at `http://fake-github:8080`, the fake GitHub of the sign-in tests, so nothing needs configuring. To sign in with real GitHub, copy `.env.example` to `supabase/.env`, put an OAuth app's client id and secret in it (callback `http://127.0.0.1:54321/auth/v1/callback`), leave the URL empty, and restart the stack. config.toml allows `harnessstore://auth-callback`, the desktop app's sign-in callback, as a redirect.

The seed and the tests read the stack's URL and keys from `supabase status`, never from the environment, so they cannot reach a hosted project. Test Publishers are auth users created through the Auth admin API with the metadata a GitHub sign-in gives (`app_metadata.provider = github`, `user_metadata.user_name`); their session JWTs are minted with the local JWT secret, so no test reaches GitHub. The sign-in test (`test-store/auth.test.ts`) instead goes through the real Auth: it starts the fake GitHub (`test-store/fake-github.ts`, a container on the stack's Docker network from the already pulled Storage image) and drives the desktop app's own auth module through the GitHub PKCE flow with a scripted browser.

### Seed catalogue

Re-running the seed first deletes every catalogue row and every object in both buckets, so it always gives the same catalogue:

| Harness               | State                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `alice/code-reviewer` | Featured (rank 1); versions 2.0.0 and 2.1.0-beta.3                              |
| `alice/hello-web`     | 0.1.0 published with two screenshots; 0.2.0 Unpublished, so 0.1.0 is the latest |
| `bob/xiezuo`          | Chinese name (写作助手)                                                         |
| `bob/retired-tool`    | Its only version is Unpublished: hidden                                         |
| `carol/bad-tool`      | Taken down: hidden                                                              |

## Access rules in short

- Every catalogue write uses the service role (Edge Functions). anon and authenticated have no INSERT, UPDATE or DELETE privilege on any catalogue table and no write policy, so an attempt fails with `42501 permission denied`.
- anon and authenticated read Harnesses that are `active` with a `latest_version`, published versions of active Harnesses, and the public columns of `profiles` (not `is_admin`, so a `select=*` on profiles is refused: name the columns). A Publisher may update their own `display_name`, `bio` and `avatar_url` only.
- `harness-packages` is private; `harness-assets` is served by public URL but cannot be listed or written.
- A Publisher also reads every version of their own Harnesses in any status, with the takedown note (the owner policy on `harness_versions`, through `private.own_harness_ids()`); never more `harnesses` rows than anon.
- Internal SQL functions are not RPCs: EXECUTE is revoked from `public`, `anon` and `authenticated`. `reports` and `admin_actions` are out of reach of anon and authenticated.

## Edge Functions

An Edge Function only sees the files under `supabase/functions`, both when served and when deployed, so it cannot import the workspace's `@harness-store/manifest`. `pnpm build` bundles that package's pure main entry into `supabase/functions/_shared/manifest.js` with Vite; `db:start`, `functions:serve` and CI build first. Each function checks its own caller (`verify_jwt = false` in config.toml) and follows [`api.md`](../../docs/tech/api.md):

- `publish` (P0-07.3): validates an uploaded Harness Package with `validatePackage()`, stores it and its assets, and records the Harness Version through the `publish_version()` SQL function.
- `download` (P0-07.4): anonymous; resolves a published Harness Version (the latest when none is named), refuses a platform it does not declare, and answers a signed package URL (60 s) with the checksum, size and Manifest. The `record_download()` SQL function counts the download without storing an IP address or a user. The URL is on `STORE_PUBLIC_URL` (supabase/functions/.env), because `SUPABASE_URL` inside the local edge runtime is the gateway's address on the Docker network; that file also shortens the URL's lifetime to 5 s (`DOWNLOAD_URL_TTL_SECONDS`, 1 to 60, test-only) so the store tests can watch it expire.

- `unpublish` (P0-07.6): the owning Publisher withdraws a version (idempotent); `unpublish_version()` refuses another Publisher's Harness (403) and a taken-down one (409), and the status trigger moves `latest_version` back.
- `report` (P0-07.6): anonymous; one of the six reasons, stored through `submit_report()`. Rate limit 5 an hour per IP address (in the worker's memory, best effort) and per `client_info.install_id` (checked against the stored Reports).
- `admin` (P0-07.6): serves `POST /functions/v1/admin/takedown` (a function's name cannot hold a `/`). Only a Publisher with `profiles.is_admin` (set by hand) may call it; `take_down()` takes down a version or the whole Harness, copies the note to `harness_versions.takedown_note`, resolves the open Reports and writes one `admin_actions` row per call.

The update check is the `latest_versions(harness_ids text[], installed_versions text[] default null)` RPC, which anon calls through PostgREST: for each ID its `store_status` (`available`, `unpublished`, `taken_down`, `not_found`), when available, the latest published version and its full Manifest, and, when the installed version at the same position is given, that version's `installed_version_status` (`published`, `unpublished`, `taken_down`), so a Takedown of only that version reaches the User.

Search is the `search_harnesses(q, tags, platform, limit, offset)` RPC (P0-07.5), which anon calls with `POST rpc/search_harnesses`: full-text over the `simple` configuration, which finds a whole Chinese word (`写作助手`) but not part of one; so a query with a CJK character also matches a name or summary that contains it as a substring (`ILIKE`, with `%`, `_` and `\` taken literally; P0-09.2, migration `20261028001000_search_cjk_substring.sql`). Tag and platform filters; ranked by the substring matches first (name, then summary), then relevance, then downloads, then date, 24 per page and never more than 60. It is `SECURITY INVOKER`, so row-level security alone hides what is not visible. The Store home rows (Featured, Most downloaded, New) and the Publisher page are plain PostgREST reads (api.md).

## Admin CLI

There is no admin UI in P0: a Store administrator (a profile whose `is_admin` was set by hand in the database) triages Reports and takes content down from their machine with `scripts/admin.ts`. From a fresh checkout, at the repository root:

```sh
pnpm install
pnpm --filter "@harness-store/store..." build   # the Store and the packages it imports (their dist/)
export STORE_URL=https://<project>.supabase.co   # the Store, without a trailing slash
export STORE_SERVICE_ROLE_KEY=...                # the project's service_role key
pnpm --filter @harness-store/store admin reports list --open
```

| Command                                                  | What it does                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reports list [--open]`                                  | Every Report, or only the open ones, newest first, grouped by Harness: the count and the count per reason, the latest Report's details, then one line per Report (ID, time, version or "all versions", reason, status, the first 120 characters of its details). Service-role reads of `reports`, a page at a time.                                                 |
| `reports dismiss <id> --note "..."`                      | Marks that open Report `dismissed` with the note and `resolved_at`; the Harness is untouched, and nothing is written to `admin_actions`. "No open Report <id>" when there is none.                                                                                                                                                                                  |
| `takedown <publisher/slug> [--version <v>] --note "..."` | Takes down that version, or without `--version` the whole Harness, through `POST /functions/v1/admin/takedown`: every open Report on the Harness is resolved with the note, which the owning Publisher reads on their versions (an appeal address can go in it), and one `admin_actions` row is written. Prints what it took down and how many Reports it resolved. |

`takedown` also needs `STORE_JWT_SECRET`, the project's HS256 JWT secret (Project Settings → API → JWT secret), and `STORE_ADMIN_LOGIN`, the administrator's GitHub login. Sign-in is GitHub OAuth only, so the CLI looks that profile up with the service role, refuses unless `is_admin` is set, and mints it a session JWT valid for 5 minutes to call the function as that administrator, who is recorded in `admin_actions`. Both keys give full access to the Store: keep them in the environment of your own shell only, never in a file in the repository. The CLI reads them from the environment alone, names a missing one and never prints a value. It exits 0 when done, 1 when the Store refused or did not answer (with the status and the API's code and message), and 2 for a usage error or a missing variable; `--help` prints the usage. Against the local stack, the values are those `node dist/scripts/supabase.js status` prints in `apps/store` (API URL, service_role key, JWT secret). `reports list` reads the Reports a page at a time, each after the last row of the one before, so PostgREST's `max_rows` (1000), which cuts a single answer short without saying so, never leaves the counts short.

The store tests run the CLI (`runAdmin`) against the local stack (`test-store/admin.test.ts`), including the Store home, search and Publisher page reads after a Takedown; its argument parsing and output are unit tests (`test/admin.test.ts`).

CI runs all of this in the `store` job of [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
