# @harness-store/repo-checks

Contributor tooling, not part of the product. Its Vitest suite runs as part of the root `pnpm test` and guards the monorepo contract from [P0-01](../../docs/delivery/specs/P0-01-monorepo-and-manifest.md):

- **Layout**: `apps/`, `packages/` and `examples/` contain the seven P0 packages, each with a `package.json` and a `README.md` that describes its role in CONTEXT.md terms (Harness, Harness Package, Manifest, Runtime, Model Gateway, ...). The check is presence, not exactness: packages added later, and stray files such as `.DS_Store`, never fail it. Fixtures live inside the package that owns them.
- **Every workspace package**, including ones added later: a name in the `@harness-store/` scope, the root's `engines.node` value, a `test` script, and no local Prettier config. A package with a `tsconfig.json` is a TypeScript package and also extends `tsconfig.base.json` and the root ESLint config, and wires `lint`, `typecheck` and `test` to ESLint, `tsc` and Vitest.
- **Fan-out**: the root `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` reach every workspace package that defines the script. A scratch workspace built from the real root `package.json` and `pnpm-workspace.yaml` proves that a newly added package is picked up with no root edit, and that one failing package fails the root command. `pnpm lint` also runs ESLint on root-level JS files, which belong to no package.
- **Growth**: `test/new-package.test.ts` copies the checkout to a scratch directory, adds packages under `packages/`, `apps/` and `examples/` (plus stray files), and runs the real `test/layout.test.ts` against the copy through the `REPO_CHECKS_ROOT` environment variable. It stays green, and it goes red when a P0 package is missing.
- **Shared configuration**: every TypeScript package extends `tsconfig.base.json` (strict) and the root ESLint config, inherits the root Prettier config, and tests with Vitest. `apps/store` (Deno) stays out of the TypeScript project references graph.
- **Toolchain pins**: `.nvmrc` pins an LTS major, the floor of every `engines.node` is on that major, and the range admits no Node version that a root tool (ESLint, Vitest, Vite, ...) does not support by its own `engines.node`; `packageManager` pins pnpm.
- **CI parity**: `.github/workflows/ci.yml` runs on every push and pull request and runs exactly `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
- **ADR-0003**: no Rust or Python sources and no second UI framework.

When one of these checks fails after an intentional change to the layout or tooling, update the check in the same change. Adding a package that follows the per-package conventions above needs no change here.

## Scripts

| Command          | What it does                           |
| ---------------- | -------------------------------------- |
| `pnpm test`      | Runs the checks with Vitest            |
| `pnpm lint`      | ESLint with the shared root config     |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` |
