# @harness-store/store

The backend of the **Store**: a Supabase project ([ADR-0006](../../docs/adr/0006-supabase-for-the-store.md)) that is the source of truth for Harnesses, **Harness Versions**, **Publishers**, **Reports** and download counts. Spec: [`P0-07`](../../docs/delivery/specs/P0-07-store-backend.md); schema: [`data-model.md`](../../docs/tech/data-model.md) §1; HTTP contract: [`api.md`](../../docs/tech/api.md).

## Layout

| Path                           | What                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/config.toml`         | Local stack settings (Supabase CLI). The GitHub provider's client id, secret and URL come from the environment (`supabase/.env.example`).                                                                                        |
| `supabase/migrations/`         | The schema: tables, enums, triggers, row-level security, Storage buckets. Migrations are the only way it changes.                                                                                                                |
| `supabase/functions/_shared/`  | Plain TypeScript modules with relative imports only, used by the Deno Edge Functions, the seed script and the unit tests (storage paths, README storage, HTTP errors, publish rules). Also `manifest.js`, generated (see below). |
| `supabase/functions/<name>/`   | The Deno Edge Functions (`Deno.serve` entry files, not type-checked by `tsc`; the store tests exercise them over HTTP): `publish`.                                                                                               |
| `supabase/functions/deno.json` | The functions' imports: supabase-js, pinned as an `npm:` specifier.                                                                                                                                                              |
| `scripts/bundle-manifest.ts`   | Bundles `@harness-store/manifest` (and its npm dependencies) into `supabase/functions/_shared/manifest.js` (gitignored); `pnpm build` runs it.                                                                                   |
| `scripts/seed.ts`              | Seeds the local stack from the `packages/manifest` fixture packages.                                                                                                                                                             |
| `scripts/supabase.ts`          | Runs the pinned Supabase CLI with the env(...) values of config.toml filled in (`node dist/scripts/supabase.js start`).                                                                                                          |
| `test/`                        | Fast checks with no Docker (`pnpm test`): the shared modules and static rules every migration follows.                                                                                                                           |
| `test-store/`                  | The Store seam: tests over HTTP against a running local stack (`pnpm test:store`).                                                                                                                                               |

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
- Internal SQL functions are not RPCs: EXECUTE is revoked from `public`, `anon` and `authenticated`.

## Edge Functions

An Edge Function only sees the files under `supabase/functions`, both when served and when deployed, so it cannot import the workspace's `@harness-store/manifest`. `pnpm build` bundles that package's pure main entry into `supabase/functions/_shared/manifest.js` with Vite; `db:start`, `functions:serve` and CI build first. Each function checks its own caller (`verify_jwt = false` in config.toml) and follows [`api.md`](../../docs/tech/api.md):

- `publish` (P0-07.3): validates an uploaded Harness Package with `validatePackage()`, stores it and its assets, and records the Harness Version through the `publish_version()` SQL function.

CI runs all of this in the `store` job of [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
