---
spec_id: P0-01
title: Monorepo scaffold and Manifest package
phase: P0
blocked_by: []
requirements: [R-0101, R-0102, R-0103, R-0104, R-0105]
---

# P0-01 Monorepo scaffold and Manifest package

## Problem Statement

Nothing exists yet. Before any Harness can be published, installed or launched, Publishers, the Store and the Runtime need to agree on exactly what a Harness Package is and how to tell a valid one from a broken one. Without a single shared validator, the Publish flow, the Store's `publish` function and the Runtime's installer will each drift into their own interpretation of the Manifest, and Publishers will get different answers from each. Developers building the rest of P0 also need a repository layout, tooling and test commands that every later spec can assume.

## Solution

A pnpm monorepo with the agreed layout and one command to test everything, plus `packages/manifest`: the single source of truth for the Manifest. It ships the JSON Schema, generated TypeScript types, `validateManifest()` for a parsed JSON object, `validatePackage()` for an archive or directory (schema + file presence + archive limits), stable problem codes, fixture packages for every failure class, and a small CLI a Publisher can run locally before publishing. Every other component imports this package instead of re-implementing rules.

## User Stories

1. As a developer joining the project, I want one clone-install-test command sequence, so that I can verify the repository works before touching any code.
2. As a developer, I want each app and package to have its own test script and a root script that runs them all, so that CI and local runs use the same entry point.
3. As a developer, I want shared TypeScript, ESLint and Prettier configuration at the root, so that every package follows the same rules without copy-paste.
4. As a developer, I want the workspace layout (`apps/desktop`, `apps/store`, `packages/manifest`, `packages/gateway`, `packages/sdk`, `examples/*`) created with placeholder READMEs, so that later specs have a known home.
5. As a Publisher, I want a JSON Schema for the Manifest published from the package, so that my editor can validate and autocomplete `manifest.json`.
6. As a Publisher, I want to run a CLI against my Harness folder and see every problem at once, so that I fix them in one pass instead of one publish attempt at a time.
7. As a Publisher, I want the CLI to accept either a directory or a zip archive, so that I can check the exact artifact I am about to upload.
8. As a Publisher, I want each problem to name the JSON path, a stable code and a human message, so that I understand what to change and where.
9. As a Publisher, I want the CLI to exit non-zero when problems exist, so that I can wire it into my own CI.
10. As a Publisher, I want unknown top-level Manifest keys rejected but `x-` prefixed keys ignored, so that I can keep private metadata without breaking validation.
11. As a Publisher, I want a clear error when my `id` publisher segment does not match my GitHub login, so that I fix it before uploading (the CLI accepts an optional `--publisher` flag to check this locally).
12. As a Publisher, I want `binary` Harnesses validated so that every declared platform has an entry and every entry file exists in the archive, so that I do not ship a package that cannot launch on a platform I claimed.
13. As a Publisher, I want `node` Harnesses validated so that `entry` is a string pointing at an existing `.js`/`.mjs`/`.cjs` file, so that the Runtime can start them.
14. As a Publisher, I want the required files (`manifest.json`, `README.md`, `assets/icon.png`) checked and the icon's dimensions verified as 512×512 PNG, so that my listing renders correctly.
15. As a Publisher, I want screenshot limits (count, size, type) enforced locally, so that I do not discover them after a long upload.
16. As a Publisher, I want a `default` Slot to be mandatory and Slot names, counts and recommended model id formats checked, so that the Gateway can always resolve my requests.
17. As a Publisher, I want all three permission keys required, so that I am forced to state filesystem, shell and network explicitly.
18. As a Store operator, I want the same `validatePackage()` to run server-side in the `publish` function, so that a tampered client cannot upload an invalid package.
19. As the Runtime, I want `validatePackage()` to reject archives with symlinks, absolute paths, `..` segments, more than 20 000 files or more than 500 MB compressed, so that unpacking is safe.
20. As the Runtime, I want a typed `Manifest` object after validation, so that Supervisor and installer code never reads raw JSON.
21. As a developer, I want a set of fixture packages covering the valid minimal case and each failure class, so that tests and other packages reuse them.
22. As a developer, I want validation to be a pure function with no network or Electron dependency, so that it runs in the browser renderer, in Node and in Deno (Supabase Edge Functions).
23. As a developer, I want problem messages to have message keys alongside English text, so that the desktop app can translate them to zh-CN.
24. As a developer, I want the schema versioned by `manifestVersion` so that a future `2` can coexist with `1`.
25. As a Publisher, I want `version` validated as strict semver and compared against an optional list of already-published versions passed to the validator, so that the "must be greater" rule is testable client-side too.
26. As a developer, I want a helper that diffs two Manifests' permissions and entry/runtime kind and reports whether re-consent is required, so that the update flow and the Store share one definition of "widened".

## Implementation Decisions

- **Monorepo**: pnpm workspaces; Node LTS pinned via `.nvmrc` and `engines`; TypeScript strict; Vitest for all packages; a root `test`, `lint`, `typecheck`, `build` script that fans out to workspaces. `apps/store` is a Supabase project (Deno for Edge Functions) and is excluded from the TypeScript project references but included in the root test script through its own runner.
- **Package contract**: `packages/manifest` exports `manifestSchema` (JSON Schema draft 2020-12), `Manifest` type (generated from the schema, checked in), `validateManifest(input: unknown, options?): ValidationResult`, `validatePackage(source: DirectorySource | ArchiveSource, options?): Promise<ValidationResult>`, `diffForReconsent(previous: Manifest, next: Manifest): ReconsentDiff`, and `PROBLEM_CODES`. Options: `{ publisher?: string; publishedVersions?: string[] }`.
- **ValidationResult** shape (decision-encoding snippet):
  ```ts
  type Problem = { path: string; code: string; message: string; messageKey: string; params?: Record<string, string | number> }
  type ValidationResult = { ok: true; manifest: Manifest; warnings: Problem[] } | { ok: false; problems: Problem[]; warnings: Problem[] }
  ```
  Warnings are non-blocking (e.g. README longer than 20 KB, no screenshots). Problems block.
- **Problem codes** are stable snake_case strings grouped by prefix: `schema_*` (type/enum/pattern), `file_missing`, `file_type`, `icon_dimensions`, `archive_symlink`, `archive_path_traversal`, `archive_too_large`, `archive_too_many_files`, `entry_missing_for_platform`, `slot_default_missing`, `publisher_mismatch`, `version_not_greater`, `version_invalid`, `unknown_key`. Adding a code is additive; codes are never renamed.
- **Sources**: `DirectorySource` reads a folder; `ArchiveSource` reads a zip via a streaming reader that never extracts to disk during validation. Both expose the same `listFiles()`/`readFile(path)` interface so rule code is source-agnostic. A third `InMemorySource` (map of path → bytes) exists for tests and the Edge Function.
- **Rule order**: (1) parse JSON, (2) schema, (3) semantic rules (slots, entry per platform, unknown keys), (4) file presence and archive limits, (5) options-dependent rules (publisher, versions). All rules run; validation does not stop at the first problem, except that file rules are skipped when the schema is invalid in a way that makes paths meaningless.
- **Semver**: use a standard semver library; pre-release allowed; build metadata rejected.
- **Icon check**: read PNG header only (IHDR width/height), no image decoding library.
- **CLI**: `harness-manifest validate <path> [--publisher <login>] [--json]`; human output lists problems grouped by path; `--json` prints the ValidationResult. Exit code 1 on problems, 0 otherwise (warnings do not change the exit code).
- **Re-consent diff**: `ReconsentDiff = { required: boolean; reasons: ('permissions_widened' | 'entry_changed' | 'runtime_kind_changed')[]; added: string[]; removed: string[] }`. "Widened" means: filesystem scope moved up the ladder none < workspace < home < paths(any new path) ; shell false→true; network domains added or `any` newly set. Narrowing never requires re-consent.
- **i18n**: the package ships an English message table; the desktop app maps `messageKey` to zh-CN. Params are interpolated by the consumer.
- **Fixtures**: a `fixtures/` directory in the package with `valid-minimal-node`, `valid-binary-multi-platform`, `valid-with-screenshots`, and one folder per problem code; each fixture folder has an `expected.json` naming the codes it must produce. Fixtures are also packaged as zips at test time by a helper so both source kinds are exercised.

## Testing Decisions

- Seam: **Manifest validation seam** (architecture §8, item 2). Tests call `validateManifest` and `validatePackage` with fixtures and assert on the set of problem codes and paths, never on internal rule ordering.
- A good test: given fixture X as directory and as zip, result codes equal `expected.json`; warnings asserted separately. Property tests for `id` and slot-name patterns.
- CLI tested by spawning it against fixtures and asserting exit code and `--json` output.
- `diffForReconsent` tested with a table of before/after permission pairs.
- Prior art: none in repo (greenfield); this package establishes the Vitest + fixture convention others follow.

## Out of Scope

- Uploading or downloading packages (P0-07, P0-08, P0-10).
- Unpacking to disk and executing (P0-05).
- Python runtime kind (P0.5-01); `beta` channel (P1-02); `encrypted` flag (P1-01). The schema rejects these values in P0 but reserves the keys in documentation.
- UI for showing problems (P0-08).

## Further Notes

- `docs/tech/manifest-spec.md` is the human-readable spec; if this package and the doc disagree, fix both in the same change.
- Keep the package dependency-light (JSON Schema validator, semver, zip reader). It must bundle for the renderer and run under Deno.

## Blocked by

- None (can start immediately)
