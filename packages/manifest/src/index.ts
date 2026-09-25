/**
 * @harness-store/manifest: the single source of truth for the Manifest (`manifest.json` at the
 * root of every Harness Package). The desktop app's Publish flow, the Store's `publish` Edge
 * Function and the Runtime's installer all use this entry point, so every one of them gives a
 * Publisher the same answer.
 *
 * This entry point is pure: no `node:*` imports and no Node-only globals, so it bundles for the
 * Electron renderer and runs under Node and Deno.
 */
export { validateManifest } from './validate-manifest.js';
export { manifestSchema } from './schema.js';
export type { JsonSchemaDocument } from './schema.js';
export { interpolate, MESSAGES_EN, PROBLEM_CODES } from './codes.js';
export type { MessageKey, ProblemCode, ProblemParams } from './codes.js';
export type { Problem, ValidateManifestOptions, ValidationResult } from './types.js';
export type * from './manifest.generated.js';
