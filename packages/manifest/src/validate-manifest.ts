import type { OutputUnit } from '@cfworker/json-schema';
import { loadDocument } from './document.js';
import type { Manifest } from './manifest.generated.js';
import { createProblem, dedupe, isKeyProblem } from './problem.js';
import { normalizeOptions, optionRules, semanticRules } from './rules.js';
import { validateAgainstSchema } from './schema.js';
import { schemaProblems } from './schema-problems.js';
import type { Problem, ValidateManifestOptions, ValidationResult } from './types.js';

/**
 * Checks a Manifest against every structural rule of the Manifest specification
 * (docs/tech/manifest-spec.md) and returns all problems at once.
 *
 * `input` is JSON text (a string or UTF-8 bytes) or an already parsed JSON value. Rules run in
 * this order, and every rule runs even when an earlier one failed:
 *
 * 1. Parse the JSON. A parse failure is reported as a single `schema_invalid_json` problem and
 *    nothing else runs; so is a document too large to check (more than `MAX_MANIFEST_VALUES`
 *    values outside top-level `x-` keys, ten times the largest valid Manifest). A number beyond
 *    the range of a double (`1e400`) is a `schema_type` problem, and the other rules still run.
 * 2. JSON Schema validation against `manifestSchema`. Should the library run out of stack on a
 *    document with thousands of problems (possible only on a host with a small stack), the
 *    result is a single `schema_invalid_json` problem instead of an exception.
 * 3. Rules JSON Schema cannot express: `entry` against `runtime.kind` and `platforms`,
 *    duplicates in lists, strict semver, the changelog byte limit, network access, ignored keys.
 * 4. Rules that need `options`: `publisher_mismatch` and `version_not_greater`.
 *
 * Top-level keys starting with `x-` are Publisher-private: never validated, and left out of the
 * returned Manifest. The function is pure: no file system, no network, no Node-only globals.
 * Its work is bounded for any input, so a hostile Manifest gets problems, never an exception.
 *
 * @throws {TypeError} only when `options` itself is malformed: a caller bug, not a Manifest
 *   problem.
 */
export function validateManifest(
  input: unknown,
  options?: ValidateManifestOptions,
): ValidationResult {
  const normalizedOptions = normalizeOptions(options);

  const loaded = loadDocument(input);
  if (!loaded.ok) return { ok: false, problems: [loaded.problem], warnings: [] };
  const { document } = loaded;

  let schemaErrors: OutputUnit[];
  try {
    schemaErrors = validateAgainstSchema(document);
  } catch (error) {
    // The JSON Schema library gathers errors with `push(...errors)`. The value limit keeps their
    // number far below what Node's default stack takes, but a host with a much smaller stack
    // (some workers and isolates) can still overflow it.
    if (!(error instanceof RangeError)) throw error;
    const problem = createProblem('schema_invalid_json.too_many_problems', []);
    return { ok: false, problems: [problem], warnings: [] };
  }

  const semantic = semanticRules(document);
  const problems = orderProblems(
    supersedeByType(
      dedupe([
        // The library's own type problems come first: they name the expected type.
        ...schemaProblems(schemaErrors, document),
        ...loaded.problems,
        ...semantic.problems,
        ...optionRules(document, normalizedOptions),
      ]),
    ),
  );
  const warnings = dedupe(semantic.warnings);

  if (problems.length > 0) return { ok: false, problems, warnings };
  return { ok: true, manifest: document as Manifest, warnings };
}

/**
 * When a value has the wrong type, format problems about the same value add nothing: a string
 * `entry` for a `binary` Harness should not also be told it is not a `.js` path. Problems about
 * the key the value sits under (e.g. a Slot name) are independent and stay.
 */
function supersedeByType(problems: Problem[]): Problem[] {
  const mistyped = new Set(
    problems.filter((problem) => problem.code === 'schema_type').map((problem) => problem.path),
  );
  return problems.filter(
    (problem) =>
      problem.code === 'schema_type' ||
      !problem.code.startsWith('schema_') ||
      isKeyProblem(problem) ||
      !mistyped.has(problem.path),
  );
}

/**
 * `manifestVersion` decides how everything else is read, so its problems come first; the rest
 * keep rule order (schema, semantic, options).
 */
function orderProblems(problems: Problem[]): Problem[] {
  const isVersionProblem = (problem: Problem) => problem.path === 'manifestVersion';
  return [...problems.filter(isVersionProblem), ...problems.filter((p) => !isVersionProblem(p))];
}
