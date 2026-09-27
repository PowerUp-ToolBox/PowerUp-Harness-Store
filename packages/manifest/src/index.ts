/**
 * @harness-store/manifest: the single source of truth for the Manifest (`manifest.json` at the
 * root of every Harness Package). The desktop app's Publish flow, the Store's `publish` Edge
 * Function and the Runtime's installer all use this entry point, so every one of them gives a
 * Publisher the same answer.
 *
 * This entry point is pure: no `node:*` imports and no Node-only globals, so it bundles for the
 * Electron renderer and runs under Node and Deno. The sources that read the file system
 * (`DirectorySource`, zip files on disk) are in `@harness-store/manifest/node`.
 */
export { validateManifest } from './validate-manifest.js';
export { validatePackage } from './validate-package.js';
export type { ValidatePackageOptions } from './validate-package.js';
export { diffForReconsent } from './reconsent.js';
export type { ReconsentDiff, ReconsentReason } from './reconsent.js';
export { ArchiveSource } from './archive-source.js';
export type { RandomAccessReader } from './archive-source.js';
export { InMemorySource } from './in-memory-source.js';
export { PackageReadError } from './source.js';
export type {
  PackageEntry,
  PackageEntryKind,
  PackageListing,
  PackageSource,
  ReadFileOptions,
  UnsupportedEntry,
} from './source.js';
export { PACKAGE_LIMITS } from './limits.js';
export { manifestSchema } from './schema.js';
export type { JsonSchemaDocument } from './schema.js';
export { interpolate, MESSAGES_EN, PROBLEM_CODES } from './codes.js';
export type { MessageKey, ProblemCode, ProblemParams } from './codes.js';
export type { Problem, ValidateManifestOptions, ValidationResult } from './types.js';
export type * from './manifest.generated.js';
