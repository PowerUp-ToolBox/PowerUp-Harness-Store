# @harness-store/manifest

> Status: placeholder (P0-01.1). The package exists so the workspace layout is in place; its contents arrive in P0-01.2 to P0-01.4.

The single source of truth for the **Manifest**, the declarative `manifest.json` at the root of every **Harness Package**. The Publish flow in the desktop app, the Store's `publish` Edge Function and the **Runtime**'s installer all import this package instead of re-implementing the rules, so a Publisher gets the same answer everywhere.

## What it will contain

- `manifestSchema`: the JSON Schema (draft 2020-12) for `manifest.json`, versioned by `manifestVersion`.
- `Manifest`: the TypeScript type generated from the schema and checked in.
- `validateManifest(input, options?)`: checks a parsed Manifest (Harness ID, Entry, UI Kind, Model Slots and Model Requirements, Recommended Models, Declared Permissions) and returns every problem at once, each with a JSON path, a stable code, an English message and an i18n message key.
- `validatePackage(source, options?)`: validates a whole Harness Package from a directory or a zip archive (required files, icon dimensions, screenshots, archive safety limits) without extracting it to disk.
- `diffForReconsent(previous, next)`: decides whether a Harness Version update widens Declared Permissions or changes the Entry or runtime kind, and therefore needs the User's consent again.
- `PROBLEM_CODES` and an English message table.
- A `harness-manifest validate <path>` CLI so a Publisher can check a Harness folder or zip before publishing.
- `fixtures/`: fixture Harness Packages for the valid cases and every problem code, owned by this package.

The validators are pure functions with no network or Electron dependency: they must run in the desktop renderer, in Node and in Deno (Supabase Edge Functions). Anything that needs `node:fs` lives behind a separate Node-only subpath export.

Normative reference: [`docs/tech/manifest-spec.md`](../../docs/tech/manifest-spec.md). Spec: [`P0-01`](../../docs/delivery/specs/P0-01-monorepo-and-manifest.md).

## Scripts

| Command          | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `pnpm test`      | Vitest (`--passWithNoTests` until the first test lands)    |
| `pnpm lint`      | ESLint with the shared root config                         |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` (sources and tests) |
| `pnpm build`     | Emits `dist/` from `tsconfig.build.json`                   |
