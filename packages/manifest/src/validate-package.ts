import type { MessageKey } from './codes.js';
import {
  hasJpegSignature,
  hasPngSignature,
  PNG_HEADER_BYTES,
  readPngDimensions,
  SIGNATURE_BYTES,
} from './images.js';
import { PACKAGE_LIMITS } from './limits.js';
import {
  createPackageProblem,
  createProblem,
  dedupe,
  isRecord,
  preview,
  truncate,
} from './problem.js';
import type { PathSegment } from './problem.js';
import { normalizeOptions } from './rules.js';
import { manifestSchema } from './schema.js';
import {
  hasParentSegment,
  indexFiles,
  isAbsoluteName,
  packagePath,
  PackageReadError,
} from './source.js';
import type { PackageListing, PackageSource } from './source.js';
import type { Problem, ValidateManifestOptions, ValidationResult } from './types.js';
import { inspectManifest } from './validate-manifest.js';

export type ValidatePackageOptions = ValidateManifestOptions;

const MANIFEST_FILE = 'manifest.json';
const README_FILE = 'README.md';
const ICON_FILE = 'assets/icon.png';

/** The platform names, read from the schema so the two can never disagree. */
const PLATFORMS = (manifestSchema.$defs as { platform: { enum: readonly string[] } }).platform.enum;

/** The schema's pattern for a path inside the Harness Package (an `entry` value). */
const RELATIVE_PATH = new RegExp(
  (manifestSchema.$defs as { relativePath: { pattern: string } }).relativePath.pattern,
  'u',
);

/**
 * Checks a whole Harness Package (a folder, a zip archive or files in memory) against every rule
 * of docs/tech/manifest-spec.md and returns all problems at once: everything validateManifest()
 * checks in `manifest.json`, plus the archive's safety and limits (§1) and the files the Manifest
 * and the Store need (`README.md`, `assets/icon.png`, screenshots, the Entry files).
 *
 * Rules run in this order, and each runs even when an earlier one failed:
 *
 * 1. Archive safety and limits, from the listing alone (no file content is read before they
 *    run): symbolic links, `..` segments and absolute names, more than 20 000 files, more than
 *    500 MB compressed, entries stored twice, encrypted or with an unsupported compression. An
 *    archive that is not a readable zip at all gives a single `archive_invalid` problem.
 * 2. `manifest.json` is read (at most 1 MB) and checked by validateManifest(), with `options`.
 * 3. File rules: required files, the icon's format and size, screenshots, and every Entry file
 *    the Manifest names. Entry files are only looked for when `entry` has the shape
 *    `runtime.kind` asks for and holds well-formed paths: otherwise the schema problem already
 *    says what is wrong, and a missing-file problem about a malformed path would add nothing.
 *
 * Nothing is extracted or written to disk, and the work is bounded for any input (a listing stops
 * after 100 000 entries, files are read only as far as the rules need), so validation is safe to
 * run on an untrusted upload.
 *
 * @throws {TypeError} when `source` is not a PackageSource or `options` is malformed, and
 *   whatever the source throws for reasons other than the package's content (an I/O error
 *   reading a folder).
 */
export async function validatePackage(
  source: PackageSource,
  options?: ValidatePackageOptions,
): Promise<ValidationResult> {
  const candidate = source as Partial<PackageSource> | null | undefined;
  if (
    typeof candidate?.listEntries !== 'function' ||
    typeof candidate.listFiles !== 'function' ||
    typeof candidate.readFile !== 'function'
  ) {
    throw new TypeError(
      'validatePackage() takes a PackageSource: DirectorySource, ArchiveSource or InMemorySource',
    );
  }
  const normalizedOptions = normalizeOptions(options);
  const listing = source.listEntries();
  if (listing.unreadable !== undefined) {
    const problem = createPackageProblem('archive_invalid', '$', { detail: listing.unreadable });
    return { ok: false, problems: [problem], warnings: [] };
  }

  const problems = archiveProblems(listing);
  if (listing.truncated) return { ok: false, problems, warnings: [] };

  const index = indexFiles(listing.entries);
  const sizes = new Map([...index].map(([path, at]) => [path, listing.entries[at]?.size ?? 0]));
  const links = new Set(
    listing.entries.flatMap((entry) => {
      const path = entry.kind === 'symlink' ? packagePath(entry.name) : undefined;
      return path === undefined ? [] : [path];
    }),
  );
  const context: PackageContext = {
    source,
    files: new Set(source.listFiles()),
    sizes,
    links,
    problems: [],
    warnings: [],
  };

  const inspection = await checkManifestFile(context, normalizedOptions);
  checkReadme(context);
  await checkIcon(context);
  await checkScreenshots(context);
  if (inspection !== undefined) checkEntryFiles(context, inspection.document);

  const manifestResult = inspection?.result;
  const allProblems = dedupe([
    ...problems,
    ...(manifestResult?.ok === false ? manifestResult.problems : []),
    ...context.problems,
  ]);
  const warnings = dedupe([...(manifestResult?.warnings ?? []), ...context.warnings]);
  if (allProblems.length === 0 && manifestResult?.ok) {
    return { ok: true, manifest: manifestResult.manifest, warnings };
  }
  return { ok: false, problems: allProblems, warnings };
}

interface PackageContext {
  source: PackageSource;
  /** The package's regular files, from `source.listFiles()`. */
  files: ReadonlySet<string>;
  /** Size of each regular file, from the listing. */
  sizes: Map<string, number>;
  /** Paths of symbolic links: already reported, so never also "missing". */
  links: Set<string>;
  problems: Problem[];
  warnings: Problem[];
}

/** Rule 1: everything the listing alone shows, before any content is read. */
function archiveProblems(listing: PackageListing): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  let fileCount = 0;
  for (const entry of listing.entries) {
    if (entry.kind !== 'directory') fileCount++;
    if (entry.kind === 'symlink') {
      problems.push(createPackageProblem('archive_symlink', entry.name));
    }
    if (isAbsoluteName(entry.name)) {
      problems.push(createPackageProblem('archive_path_traversal.absolute', entry.name));
    } else if (hasParentSegment(entry.name)) {
      problems.push(createPackageProblem('archive_path_traversal', entry.name));
    }
    for (const other of entry.otherNames ?? []) {
      if (isAbsoluteName(other) || hasParentSegment(other)) {
        problems.push(
          createPackageProblem('archive_path_traversal.other_name', entry.name, {
            name: preview(other),
          }),
        );
      }
    }
    if (entry.unsupported?.reason === 'encrypted') {
      problems.push(createPackageProblem('archive_invalid.encrypted', entry.name));
    } else if (entry.unsupported?.reason === 'compression_method') {
      problems.push(
        createPackageProblem('archive_invalid.compression_method', entry.name, {
          method: entry.unsupported.method,
        }),
      );
    }
    const path = entry.kind === 'directory' ? undefined : packagePath(entry.name);
    if (path !== undefined) {
      if (seen.has(path)) problems.push(createPackageProblem('archive_invalid.duplicate', path));
      seen.add(path);
    }
  }

  const { maxArchiveBytes, maxFiles, maxListedEntries } = PACKAGE_LIMITS;
  if (listing.archiveSize !== undefined && listing.archiveSize > maxArchiveBytes) {
    problems.push(
      createPackageProblem('archive_too_large', '$', {
        actual: listing.archiveSize,
        limit: maxArchiveBytes,
      }),
    );
  }
  if (listing.truncated) {
    problems.push(
      createPackageProblem('archive_too_many_files.not_counted', '$', {
        counted: maxListedEntries,
        limit: maxFiles,
      }),
    );
  } else if (fileCount > maxFiles) {
    problems.push(
      createPackageProblem('archive_too_many_files', '$', { actual: fileCount, limit: maxFiles }),
    );
  }
  return dedupe(problems);
}

/**
 * Reads a file for a rule. A file whose content cannot be read from the package (a corrupt zip
 * entry) is an `archive_invalid` problem at its path, and undefined is returned.
 */
async function readForRule(
  context: PackageContext,
  path: string,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  try {
    return await context.source.readFile(path, { maxBytes });
  } catch (error) {
    if (!(error instanceof PackageReadError)) throw error;
    context.problems.push(
      createPackageProblem('archive_invalid.entry', path, { detail: error.message }),
    );
    return undefined;
  }
}

/** Reports a required file that is not there (a link in its place is already reported). */
function requireFile(context: PackageContext, path: string): boolean {
  if (context.files.has(path)) return true;
  if (!context.links.has(path)) {
    context.problems.push(createPackageProblem('file_missing', path, { file: path }));
  }
  return false;
}

function sizeOf(context: PackageContext, path: string): number {
  return context.sizes.get(path) ?? 0;
}

/** Rule 2: `manifest.json`, through validateManifest(). */
async function checkManifestFile(
  context: PackageContext,
  normalizedOptions: ReturnType<typeof normalizeOptions>,
) {
  if (!context.files.has(MANIFEST_FILE)) {
    // A Harness folder zipped as a whole puts everything one level down.
    const nested = [...context.files].find((path) => /^[^/]+\/manifest\.json$/.test(path));
    if (nested !== undefined && !context.links.has(MANIFEST_FILE)) {
      context.problems.push(
        createPackageProblem('file_missing.manifest_nested', MANIFEST_FILE, { found: nested }),
      );
    } else {
      requireFile(context, MANIFEST_FILE);
    }
    return undefined;
  }
  const { maxManifestBytes } = PACKAGE_LIMITS;
  const bytes = await readForRule(context, MANIFEST_FILE, maxManifestBytes + 1);
  if (bytes === undefined) return undefined;
  if (bytes.length > maxManifestBytes) {
    context.problems.push(
      createPackageProblem('schema_invalid_json.file_too_large', '$', { limit: maxManifestBytes }),
    );
    return undefined;
  }
  return inspectManifest(bytes, normalizedOptions);
}

/** README.md is required; a long one is a warning. */
function checkReadme(context: PackageContext): void {
  if (!requireFile(context, README_FILE)) return;
  const size = sizeOf(context, README_FILE);
  const { maxReadmeBytes } = PACKAGE_LIMITS;
  if (size > maxReadmeBytes) {
    context.warnings.push(
      createPackageProblem('file_too_large.readme', README_FILE, {
        actual: size,
        limit: maxReadmeBytes,
      }),
    );
  }
}

/** assets/icon.png is required and must be a 512×512 PNG, read from its IHDR chunk only. */
async function checkIcon(context: PackageContext): Promise<void> {
  if (!requireFile(context, ICON_FILE)) return;
  const bytes = await readForRule(context, ICON_FILE, PNG_HEADER_BYTES);
  if (bytes === undefined) return;
  const dimensions = readPngDimensions(bytes);
  if (dimensions === undefined) {
    context.problems.push(createPackageProblem('file_type.icon', ICON_FILE));
    return;
  }
  const { iconSize } = PACKAGE_LIMITS;
  if (dimensions.width !== iconSize || dimensions.height !== iconSize) {
    context.problems.push(
      createPackageProblem('icon_dimensions', ICON_FILE, {
        expected: iconSize,
        width: dimensions.width,
        height: dimensions.height,
      }),
    );
  }
}

/**
 * Screenshots are the files directly in `assets/` other than the icon, ignoring hidden files
 * such as a Finder `.DS_Store`. Each must be a PNG or JPEG whose content matches its extension
 * (a problem); more than 5, or one over 2 MB, is a warning.
 */
async function checkScreenshots(context: PackageContext): Promise<void> {
  const screenshots = [...context.files].filter(
    (path) => /^assets\/[^/.][^/]*$/.test(path) && path !== ICON_FILE,
  );
  const { maxScreenshots, maxScreenshotBytes } = PACKAGE_LIMITS;
  if (screenshots.length > maxScreenshots) {
    context.warnings.push(
      createPackageProblem('screenshots_too_many', 'assets', {
        actual: screenshots.length,
        limit: maxScreenshots,
      }),
    );
  }
  for (const path of screenshots) {
    const size = sizeOf(context, path);
    if (size > maxScreenshotBytes) {
      context.warnings.push(
        createPackageProblem('file_too_large.screenshot', path, {
          actual: size,
          limit: maxScreenshotBytes,
        }),
      );
    }
    const extension = /\.(png|jpe?g)$/i.exec(path)?.[1]?.toLowerCase();
    if (extension === undefined) {
      context.problems.push(createPackageProblem('file_type.screenshot', path));
      continue;
    }
    const bytes = await readForRule(context, path, SIGNATURE_BYTES);
    if (bytes === undefined) continue;
    const matches = extension === 'png' ? hasPngSignature(bytes) : hasJpegSignature(bytes);
    if (!matches) context.problems.push(createPackageProblem('file_type.screenshot', path));
  }
}

/**
 * Every Entry file the Manifest names must be in the package: the Runtime could not start the
 * Harness otherwise (ADR-0004: a Harness is a standalone process). `node`: the one `entry` path.
 * `binary`: the path for each declared platform (an entry for an undeclared platform is ignored,
 * so it is not looked for).
 */
function checkEntryFiles(context: PackageContext, document: unknown): void {
  if (!isRecord(document)) return;
  const { runtime, entry, platforms } = document;
  const kind = isRecord(runtime) ? runtime.kind : undefined;

  const check = (path: PathSegment[], file: unknown, messageKey: MessageKey, platform?: string) => {
    if (typeof file !== 'string' || !RELATIVE_PATH.test(file)) return;
    const canonical = packagePath(file);
    if (canonical === undefined || context.files.has(canonical) || context.links.has(canonical)) {
      return;
    }
    const params: Record<string, string> = { file: truncate(file) };
    if (platform !== undefined) params.platform = platform;
    context.problems.push(createProblem(messageKey, path, params));
  };

  if (kind === 'node' && typeof entry === 'string') {
    check(['entry'], entry, 'entry_missing_for_platform.file');
  } else if (kind === 'binary' && isRecord(entry)) {
    const declared = Array.isArray(platforms) ? new Set(platforms as unknown[]) : undefined;
    for (const platform of PLATFORMS) {
      if (!Object.hasOwn(entry, platform) || (declared && !declared.has(platform))) continue;
      check(
        ['entry', platform],
        entry[platform],
        'entry_missing_for_platform.platform_file',
        platform,
      );
    }
  }
}
