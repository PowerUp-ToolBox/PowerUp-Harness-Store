# Harness Store

A desktop platform (PowerUp) where you install and launch AI agent **Harnesses** as standalone local apps, and where publishers share them. Every Harness reaches language models only through the local **Model Gateway**, so any Harness runs on any model you have access to: Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Qwen, Kimi, GLM, MiniMax, Doubao, Ollama, LM Studio or any OpenAI-compatible endpoint.

Status: **design complete; P0 implementation has started** with the monorepo scaffold (see [Development](#development)). Everything else below is documentation.

## Start here
- [`CONTEXT.md`](./CONTEXT.md) — the glossary. Use these words and no others.
- [`docs/adr/`](./docs/adr) — decisions and why. ADR-0004 explains the whole shape.
- [`docs/product/prd.md`](./docs/product/prd.md) — PRD (with 中文摘要), [`requirements.md`](./docs/product/requirements.md), [`roadmap.md`](./docs/product/roadmap.md)
- [`docs/tech/`](./docs/tech) — [architecture](./docs/tech/architecture.md), [Manifest spec](./docs/tech/manifest-spec.md), [Gateway protocol](./docs/tech/gateway-protocol.md), [data model](./docs/tech/data-model.md), [API](./docs/tech/api.md), [security](./docs/tech/security.md)
- [`docs/ux/`](./docs/ux) — [principles](./docs/ux/design-principles.md), [flows](./docs/ux/flows.md), [screens](./docs/ux/screens.md)
- [`docs/delivery/specs/`](./docs/delivery/specs) — one spec per feature, mirrored to GitHub issues labelled `spec` + phase (`P0`, `P0.5`, `P1`, `P2`), ordered by ID and linked by "blocked by".

## Phases
- **P0** — launcher + Model Gateway + Store, end to end, for technical users with their own model accounts.
- **P0.5** — Python Harnesses, Python SDK, GitHub import.
- **P1** — paid Harnesses (one-time purchase), beta channel, ratings, analytics, telemetry (opt-in), scanning, background Harnesses.
- **P2** — platform subscription: cloud Gateway with credits, sync, private Harnesses.

## Working on it
Pick the lowest-numbered open issue in the current milestone whose "Blocked by" issues are all closed. Read the spec, the linked `docs/tech` pages and `CONTEXT.md` before writing code.

## Development
Prerequisites: **Node 22 LTS** (pinned in [`.nvmrc`](./.nvmrc); `nvm use` picks it up) and **pnpm 10.33.0** (pinned in `package.json#packageManager`; `corepack enable` provides it). Node 22 matches the Node the Runtime bundles for Harnesses (see [`manifest-spec.md`](./docs/tech/manifest-spec.md) §3). `engines.node` is `^22.13.0 || ^24.0.0 || >=26.0.0`, the Node versions both ESLint 10 and Vitest 5 support (so Node 24 LTS works too, odd-numbered releases do not); `pnpm install` refuses anything else.

```sh
pnpm install     # the only setup step; no environment variables needed
pnpm lint        # ESLint in every TypeScript package and on root-level JS, then Prettier --check
pnpm typecheck   # tsc --noEmit in every TypeScript package
pnpm test        # every package's test script (Vitest; apps/store has its own runner)
pnpm build       # tsc --build of every package that has a build script
```

CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs exactly these commands on every push and pull request.

To check a Harness Package (a folder or a zip) the way the Store will, build the Manifest package and run its CLI: `pnpm --filter @harness-store/manifest build`, then `node packages/manifest/bin/harness-manifest.js validate <path>`. See [`packages/manifest`](./packages/manifest/README.md#command-line-harness-manifest-validate) for its options, output and exit status.

Layout (pnpm workspaces, see [`pnpm-workspace.yaml`](./pnpm-workspace.yaml)):

| Path | Package | Role |
|---|---|---|
| `apps/desktop` | `@harness-store/desktop` | Electron app: the Runtime and the renderer |
| `apps/store` | `@harness-store/store` | Supabase project for the Store (Deno Edge Functions) |
| `packages/manifest` | `@harness-store/manifest` | Manifest schema and validators |
| `packages/gateway` | `@harness-store/gateway` | Model Gateway |
| `packages/sdk` | `@harness-store/sdk` | SDK for Node Harness authors |
| `examples/hello-web` | `@harness-store/hello-web` | Reference Harness, UI Kind `web` |
| `examples/hello-term` | `@harness-store/hello-term` | Reference Harness, UI Kind `terminal` |
| `tools/repo-checks` | `@harness-store/repo-checks` | Tests that guard this layout, the shared configs and CI |

Conventions:
- Every package defines a `test` script (Vitest for TypeScript packages; a package with no tests yet uses `vitest run --passWithNoTests`). TypeScript packages also define `lint`, `typecheck` and `build`. The root commands fan out with `pnpm --recursive run <script>`, so a new directory under `apps/`, `packages/` or `examples/` with those scripts is picked up without any root change. A new package also needs a name in the `@harness-store/` scope and the root's `engines.node` value; `tools/repo-checks` checks both.
- Shared configuration lives at the root and is extended, not copied: [`tsconfig.base.json`](./tsconfig.base.json) (strict), [`eslint.config.js`](./eslint.config.js) and [`.prettierrc.json`](./.prettierrc.json). Each TypeScript package has a `tsconfig.json` (type-check sources and tests), a `tsconfig.build.json` (emit `dist/`) and an `eslint.config.js` that imports the root config.
- The root [`tsconfig.json`](./tsconfig.json) is the TypeScript project references graph (`tsc --build` from the root builds everything). `apps/store` is excluded because its Edge Functions run on Deno. `pnpm build` does not use this file; list a new package's `tsconfig.build.json` there only for root `tsc --build` and cross-package editor navigation.
- Test fixtures live inside the package that owns them (e.g. `packages/manifest/fixtures/`), never at the repo root.
- Generated sources are checked in and guarded by a drift check: after editing the Manifest schema, run `pnpm --filter @harness-store/manifest generate` and commit `packages/manifest/src/manifest.generated.ts` (`pnpm typecheck` fails while it is stale).
