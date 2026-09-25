# @harness-store/repo-checks

Contributor tooling, not part of the product. Its Vitest suite runs as part of the root `pnpm test` and guards the monorepo contract from [P0-01](../../docs/delivery/specs/P0-01-monorepo-and-manifest.md):

- **Layout**: `apps/`, `packages/` and `examples/` contain exactly the P0 packages, each with a `package.json` and a `README.md` that describes its role in CONTEXT.md terms (Harness, Harness Package, Manifest, Runtime, Model Gateway, ...). Fixtures live inside the package that owns them.
- **Fan-out**: the root `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` reach every workspace package that defines the script. A scratch workspace built from the real root `package.json` and `pnpm-workspace.yaml` proves that a newly added package is picked up with no root edit, and that one failing package fails the root command.
- **Shared configuration**: every TypeScript package extends `tsconfig.base.json` (strict) and the root ESLint config, inherits the root Prettier config, and tests with Vitest. `apps/store` (Deno) stays out of the TypeScript project references graph.
- **Toolchain pins**: `.nvmrc` and every `engines.node` agree on the Node LTS major; `packageManager` pins pnpm.
- **CI parity**: `.github/workflows/ci.yml` runs on every push and pull request and runs exactly `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
- **ADR-0003**: no Rust or Python sources and no second UI framework.

When one of these checks fails after an intentional change to the layout or tooling, update the check in the same change.

## Scripts

| Command          | What it does                           |
| ---------------- | -------------------------------------- |
| `pnpm test`      | Runs the checks with Vitest            |
| `pnpm lint`      | ESLint with the shared root config     |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` |
