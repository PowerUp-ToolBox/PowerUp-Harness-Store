# @harness-store/store

The backend of the **Store**: a Supabase project ([ADR-0006](../../docs/adr/0006-supabase-for-the-store.md)) that is the source of truth for Harnesses, **Harness Versions**, **Publishers**, **Reports** and download counts. Spec: [`P0-07`](../../docs/delivery/specs/P0-07-store-backend.md); schema: [`data-model.md`](../../docs/tech/data-model.md) §1; HTTP contract: [`api.md`](../../docs/tech/api.md).

## Layout

| Path                          | What                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/config.toml`        | Local stack settings (Supabase CLI).                                                                                                                      |
| `supabase/migrations/`        | The schema: tables, enums, triggers, row-level security, Storage buckets. Migrations are the only way it changes.                                         |
| `supabase/functions/_shared/` | Plain TypeScript modules with relative imports only, used by the Deno Edge Functions, the seed script and the unit tests (storage paths, README storage). |
| `scripts/seed.ts`             | Seeds the local stack from the `packages/manifest` fixture packages.                                                                                      |
| `test/`                       | Fast checks with no Docker (`pnpm test`): the shared modules and static rules every migration follows.                                                    |
| `test-store/`                 | The Store seam: tests over HTTP against a running local stack (`pnpm test:store`).                                                                        |

## Local stack

Needs Docker. The Supabase CLI is the pinned `supabase` devDependency, so nothing is installed globally. From this folder:

```sh
pnpm db:start        # build, then `supabase start`: applies every migration to an empty database
pnpm db:reset        # build, `supabase db reset` (migrations from empty again), then the seed
pnpm test:store      # the store tests (they seed again first)
pnpm functions:serve # build, then serve the Edge Functions
pnpm db:stop
```

The seed and the tests read the stack's URL and keys from `supabase status`, never from the environment, so they cannot reach a hosted project. Test Publishers are auth users created through the Auth admin API with the metadata a GitHub sign-in gives (`app_metadata.provider = github`, `user_metadata.user_name`); their session JWTs are minted with the local JWT secret, so no test reaches GitHub.

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

CI runs all of this in the `store` job of [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
