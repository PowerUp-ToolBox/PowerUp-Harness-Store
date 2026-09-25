# @harness-store/manifest

The single source of truth for the **Manifest**, the declarative `manifest.json` at the root of every **Harness Package**. The Publish flow in the desktop app, the Store's `publish` Edge Function and the **Runtime**'s installer all import this package instead of re-implementing the rules, so a Publisher gets the same answer everywhere.

Normative reference: [`docs/tech/manifest-spec.md`](../../docs/tech/manifest-spec.md). Spec: [`P0-01`](../../docs/delivery/specs/P0-01-monorepo-and-manifest.md).

Status: P0-01.2 is in (schema, `Manifest` type, `validateManifest`, problem codes, fixtures). Still to come: `validatePackage()` (file presence and archive limits for a folder or a zip) and `diffForReconsent()` in P0-01.3, and the `harness-manifest validate` CLI in P0-01.4.

## API

```ts
import {
  validateManifest,
  manifestSchema,
  PROBLEM_CODES,
  MESSAGES_EN,
  interpolate,
} from '@harness-store/manifest';
import type { Manifest, Problem, ValidationResult } from '@harness-store/manifest';

const result = validateManifest(manifestJsonText, {
  publisher: 'alice',
  publishedVersions: ['0.1.0'],
});
if (result.ok) {
  result.manifest; // Manifest: typed, a copy, top-level x- keys removed
} else {
  result.problems; // every blocking problem at once
}
result.warnings; // never block
```

- `validateManifest(input, options?)`: `input` is JSON text, UTF-8 bytes (any `ArrayBuffer` view; a byte order mark is ignored) or an already parsed JSON value (validated as the JSON `JSON.stringify` would produce). Options: `publisher` (the signed-in Publisher's GitHub login, compared lower-cased) and `publishedVersions` (every published Harness Version of this Harness). Malformed options throw a `TypeError`; a malformed Manifest never throws.
- `manifestSchema`: the JSON Schema (draft 2020-12), deep-frozen. The file itself is exported as `@harness-store/manifest/manifest-v1.schema.json` for editors.
- `Manifest` and its parts (`Platform`, `Entry`, `HarnessRuntime`, `UserInterface`, `ModelSlot`, `ModelRequirements`, `DeclaredPermissions`, ...): generated from the schema into [`src/manifest.generated.ts`](src/manifest.generated.ts) and checked in.
- `PROBLEM_CODES`, `MESSAGES_EN` (English templates by `messageKey`) and `interpolate(template, params)` for rendering a translated template.

`ValidationResult` is exactly the shape in the P0-01 spec:

```ts
type Problem = {
  path: string;
  code: string;
  message: string;
  messageKey: string;
  params?: Record<string, string | number>;
};
type ValidationResult =
  | { ok: true; manifest: Manifest; warnings: Problem[] }
  | { ok: false; problems: Problem[]; warnings: Problem[] };
```

- `path` is relative to the Manifest root: `name`, `models.slots.default`, `platforms[1]`, `entry.win32-x64`, `["a.b"]` for a key that needs quoting, `$` for the Manifest as a whole.
- `code` is stable and additive-only: a shipped code is never renamed or removed. `schema_*` codes name the JSON Schema keyword that failed (`schema_max_items` is `maxItems`).
- `messageKey` is the code itself or `<code>.<variant>` for a more specific wording (e.g. `schema_pattern.harnessId`). `message` is the English template with `params` filled in. The desktop app maps the same `messageKey` to zh-CN and calls `interpolate` with the same `params`. `actual`/`value` params are JSON renderings (strings keep their quotes), shortened to 60 characters.

## Problem codes

| Code                                     | Blocks       | When                                                                                                                                                                                                               |
| ---------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema_invalid_json`                    | yes          | The input is not JSON (or not UTF-8, or a JavaScript value with no JSON form). Reported alone: nothing else runs.                                                                                                  |
| `schema_type`                            | yes          | Wrong JSON type, including `entry` not matching `runtime.kind`.                                                                                                                                                    |
| `schema_enum`                            | yes          | Not an allowed value (`const` too: `manifestVersion` other than `1`, `channel` other than `stable`), or an object key that is not allowed (an `entry` key that is not a platform).                                 |
| `schema_pattern`                         | yes          | Wrong format: Harness ID, license, URL, `entry` path, `ui.path`, Slot name, Recommended Model id, domain.                                                                                                          |
| `schema_required`                        | yes          | A required key is missing (`network` without `domains` or `any` too).                                                                                                                                              |
| `schema_min_length`, `schema_max_length` | yes          | String length (code points), or the `changelog` byte limit.                                                                                                                                                        |
| `schema_min_items`, `schema_max_items`   | yes          | List length: `platforms`, `tags`, `recommended`, `domains`, `paths`.                                                                                                                                               |
| `schema_max_properties`                  | yes          | More than 8 Model Slots.                                                                                                                                                                                           |
| `schema_minimum`, `schema_maximum`       | yes          | Numbers out of range: `readyTimeoutSeconds`, `minContext`, window size.                                                                                                                                            |
| `schema_unique_items`                    | yes          | A list repeats a value.                                                                                                                                                                                            |
| `unknown_key`                            | yes          | A key the format does not define, at any level. Top-level `x-` keys are exempt.                                                                                                                                    |
| `slot_default_missing`                   | yes          | No `default` Model Slot.                                                                                                                                                                                           |
| `entry_missing_for_platform`             | yes          | A `binary` Harness has no `entry` for a declared platform (path `entry.<platform>`).                                                                                                                               |
| `publisher_mismatch`                     | yes          | `options.publisher` given and the Harness ID's publisher segment differs.                                                                                                                                          |
| `version_invalid`                        | yes          | Not strict semver (build metadata, a `v` prefix and loose forms are rejected).                                                                                                                                     |
| `version_not_greater`                    | yes          | `options.publishedVersions` given and `version` is not greater than all of them.                                                                                                                                   |
| `ignored_key`                            | no (warning) | A valid key with no effect: `ui.path` for a terminal UI Kind, `runtime.node` for `binary`, an `entry` for an undeclared platform, `filesystem.paths` outside scope `paths`, `network.domains` next to `any: true`. |

## How validation works

Rules run in this order, and every rule runs even when an earlier one failed (only a JSON parse failure stops early):

1. **Parse** JSON text or bytes.
2. **JSON Schema** validation against `manifestSchema`, translated into problems. The schema encodes every rule about a single field (types, enums, patterns, lengths, counts, closed objects), so editors pointed at it catch the same mistakes.
3. **Semantic rules** that JSON Schema cannot express, or expresses too expensively for untrusted input: `entry` against `runtime.kind` and `platforms`, duplicates in lists (JSON Schema `uniqueItems` is evaluated pairwise, which is quadratic), strict semver through the `semver` library (numeric parts beyond `Number.MAX_SAFE_INTEGER`), the `changelog` limit in bytes, `network` needing `domains` or `any`, and the `ignored_key` warnings.
4. **Option rules**: `publisher_mismatch` and `version_not_greater`.

A finding detected by two rules is reported once, and a type problem hides format problems about the same value. `manifestVersion` problems are listed first; this validator understands version 1 only. No defaults are applied to the returned Manifest: keys with a default (`channel`, `workspace`, `ui.path`, `ui.readyTimeoutSeconds`) stay optional in the type and absent when the Publisher left them out.

## Why `@cfworker/json-schema`

The validator must run in the Electron renderer (whose Content Security Policy should not allow `unsafe-eval`), in Node and in Deno for the Supabase Edge Function. [Ajv](https://ajv.js.org) compiles schemas with `new Function`, and its precompiled "standalone" output still loads runtime helpers with `require()` even in ESM mode ([ajv#2209](https://github.com/ajv-validator/ajv/issues/2209)), so it would mean checking in generated code plus a CommonJS runtime. [`@cfworker/json-schema`](https://github.com/cfworker/cfworker/tree/main/packages/json-schema) interprets the schema instead: no `eval`, no dependencies, ESM, draft 2020-12 (react-jsonschema-form offers a validator built on it for CSP-constrained apps for exactly this reason). Its speed (no code generation) is irrelevant for a document the size of a Manifest. Two quirks are handled in `src/schema-problems.ts`: it re-reports a known key with an invalid value under `additionalProperties: false`, and it cannot build a pointer for a key containing a lone UTF-16 surrogate (such keys are renamed with U+FFFD before validation, then reported as unknown).

`semver` (the npm library) is imported from `semver/classes/semver.js` only, which keeps the browser bundle small; strictness on top of it is enforced here. The whole entry point bundles to about 55 KB minified.

## Runs everywhere

`src/` imports no Node built-in and uses no Node-only global; ESLint enforces this for `src/**` (a future Node-only subpath such as `src/node/` for `DirectorySource` is exempt). `test/browser-bundle.test.ts` builds `src/index.ts` with Vite for the browser, failing on any Node built-in, then runs the bundle in a V8 context that has only ECMAScript built-ins plus `TextDecoder` and `URL` and checks every fixture there. Deno is not part of the test run yet; the package uses nothing Deno lacks (ESM, `import ... with { type: 'json' }`, `TextDecoder`, `URL`, and npm packages Deno imports through `npm:` specifiers).

## Fixtures

[`fixtures/`](fixtures) holds one folder per problem code (named after the code), valid Manifests (`valid-minimal-node`, `valid-binary-multi-platform`, `valid-web-ui-options`) and a few scenarios (`multiple-problems`, `runtime-python-rejected`, ...). Each folder has a `manifest.json` and an `expected.json`:

```json
{
  "description": "Why this fixture exists.",
  "options": { "publisher": "alice" },
  "problems": [{ "code": "publisher_mismatch", "path": "id" }],
  "warnings": []
}
```

`test/fixtures.test.ts` checks that every code has a folder and that each `manifest.json` produces exactly the listed problems and warnings, in any order, whether passed as text, bytes or a parsed value. P0-01.3 reuses these folders as whole Harness Packages.

## Changing the schema

1. Edit [`src/manifest-v1.schema.json`](src/manifest-v1.schema.json) and, if prose changes, [`docs/tech/manifest-spec.md`](../../docs/tech/manifest-spec.md) in the same change (`test/schema.test.ts` compares the tag list, platform list, slug and Slot-name patterns with the doc).
2. Run `pnpm --filter @harness-store/manifest generate` and commit `src/manifest.generated.ts`. `pnpm typecheck` fails while it is stale.
3. A new `pattern` goes in a named `$defs` entry with a `schema_pattern.<name>` message; a new keyword needs a translation in `src/schema-problems.ts`. The schema tests enforce both.
4. Never rename or remove a problem code; add a fixture folder for a new one.

## Scripts

| Command          | What it does                                                                        |
| ---------------- | ----------------------------------------------------------------------------------- |
| `pnpm test`      | Vitest: fixtures, acceptance criteria, rules, property tests, browser bundle, drift |
| `pnpm lint`      | ESLint with the shared root config, plus the no-Node-in-`src/` rule                 |
| `pnpm typecheck` | `tsc --noEmit` (sources and tests), then the generated-type drift check             |
| `pnpm build`     | Emits `dist/` (including the schema JSON) from `tsconfig.build.json`                |
| `pnpm generate`  | Regenerates `src/manifest.generated.ts` from the schema                             |
