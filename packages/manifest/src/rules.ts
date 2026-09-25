import SemVer from 'semver/classes/semver.js';
import { createProblem, describeActual, isRecord, preview, truncate } from './problem.js';
import type { PathSegment } from './problem.js';
import { manifestSchema } from './schema.js';
import type { Problem, ValidateManifestOptions } from './types.js';

/**
 * Rules that JSON Schema cannot express, or expresses too expensively for untrusted input.
 * Each rule reads only the parts of the document it needs and skips silently when they are
 * malformed: the schema step already reports those, and one bad field must not hide others.
 */

/** The platform names, read from the schema so the two can never disagree. */
const PLATFORMS = (manifestSchema.$defs as { platform: { enum: readonly string[] } }).platform.enum;

const WEB_ONLY_UI_KEYS = ['path', 'readyTimeoutSeconds', 'window'] as const;

/** `changelog` limit: 5 KB of UTF-8. */
export const CHANGELOG_MAX_BYTES = 5 * 1024;

export interface RuleFindings {
  problems: Problem[];
  warnings: Problem[];
}

export function semanticRules(document: unknown): RuleFindings {
  const findings: RuleFindings = { problems: [], warnings: [] };
  if (!isRecord(document)) return findings;
  checkEntry(document, findings);
  checkUniqueLists(document, findings);
  checkVersion(document, findings);
  checkChangelog(document, findings);
  checkIgnoredKeys(document, findings);
  checkNetwork(document, findings);
  return findings;
}

/** `entry` must fit `runtime.kind`; a `binary` Harness needs an entry for every platform. */
function checkEntry(document: Record<string, unknown>, { problems, warnings }: RuleFindings): void {
  const runtime = document.runtime;
  const kind = isRecord(runtime) ? runtime.kind : undefined;
  const entry = document.entry;
  if (!Object.hasOwn(document, 'entry')) return;

  if (kind === 'node' && typeof entry !== 'string') {
    problems.push(
      createProblem('schema_type.entry_for_runtime_kind', ['entry'], {
        expected: 'a string',
        runtimeKind: kind,
        actual: describeActual(entry),
      }),
    );
  }
  if (kind !== 'binary') return;
  if (!isRecord(entry)) {
    problems.push(
      createProblem('schema_type.entry_for_runtime_kind', ['entry'], {
        expected: 'an object',
        runtimeKind: kind,
        actual: describeActual(entry),
      }),
    );
    return;
  }
  const declared = declaredPlatforms(document.platforms);
  for (const platform of declared) {
    if (!Object.hasOwn(entry, platform)) {
      problems.push(createProblem('entry_missing_for_platform', ['entry', platform], { platform }));
    }
  }
  for (const platform of Object.keys(entry)) {
    // Keys that are not platforms at all are reported by the schema (`propertyNames`).
    if (PLATFORMS.includes(platform) && !declared.has(platform)) {
      warnings.push(createProblem('ignored_key.entry_platform', ['entry', platform], { platform }));
    }
  }
}

/** The valid platform names listed in `platforms`, ignoring anything malformed. */
function declaredPlatforms(platforms: unknown): Set<string> {
  const declared = new Set<string>();
  if (!Array.isArray(platforms)) return declared;
  for (const platform of platforms as unknown[]) {
    if (typeof platform === 'string' && PLATFORMS.includes(platform)) declared.add(platform);
  }
  return declared;
}

/**
 * Lists that must not repeat a value. Checked here in linear time instead of with JSON Schema
 * `uniqueItems`, which JSON Schema validators evaluate pairwise (quadratic) on untrusted input.
 */
function checkUniqueLists(document: Record<string, unknown>, { problems }: RuleFindings): void {
  const lists: [PathSegment[], unknown][] = [
    [['tags'], document.tags],
    [['platforms'], document.platforms],
  ];
  const models = document.models;
  const slots = isRecord(models) ? models.slots : undefined;
  if (isRecord(slots)) {
    for (const [name, slot] of Object.entries(slots)) {
      if (isRecord(slot)) lists.push([['models', 'slots', name, 'recommended'], slot.recommended]);
    }
  }
  const permissions = document.permissions;
  if (isRecord(permissions)) {
    const { filesystem, network } = permissions;
    if (isRecord(filesystem))
      lists.push([['permissions', 'filesystem', 'paths'], filesystem.paths]);
    if (isRecord(network)) lists.push([['permissions', 'network', 'domains'], network.domains]);
  }

  for (const [path, list] of lists) {
    if (!Array.isArray(list)) continue;
    const firstIndex = new Map<string, number>();
    (list as unknown[]).forEach((item, index) => {
      // Non-string items are type problems, reported by the schema.
      if (typeof item !== 'string') return;
      const first = firstIndex.get(item);
      if (first === undefined) firstIndex.set(item, index);
      else {
        problems.push(
          createProblem('schema_unique_items', [...path, index], {
            value: preview(item),
            firstIndex: first,
          }),
        );
      }
    });
  }
}

/**
 * Parses strict semver: MAJOR.MINOR.PATCH with an optional pre-release, and nothing else (no
 * leading `v`, no surrounding spaces, no build metadata). Returns undefined when invalid.
 */
export function parseStrictVersion(version: string): SemVer | undefined {
  let parsed: SemVer;
  try {
    parsed = new SemVer(version);
  } catch {
    return undefined;
  }
  // The library accepts `v1.2.3`, ` 1.2.3 ` and `1.2.3+build`; its normalised form does not.
  return parsed.build.length === 0 && parsed.version === version ? parsed : undefined;
}

/**
 * The schema's pattern already rejects most invalid versions; the semver library also catches
 * what a pattern cannot (e.g. numeric parts above Number.MAX_SAFE_INTEGER). Duplicates of the
 * schema's `version_invalid` are removed by the caller.
 */
function checkVersion(document: Record<string, unknown>, { problems }: RuleFindings): void {
  const version = document.version;
  if (typeof version === 'string' && parseStrictVersion(version) === undefined) {
    problems.push(createProblem('version_invalid', ['version'], { version: truncate(version) }));
  }
}

/** The 5 KB limit is in bytes, which JSON Schema's `maxLength` (code points) cannot express. */
function checkChangelog(document: Record<string, unknown>, { problems }: RuleFindings): void {
  const changelog = document.changelog;
  if (typeof changelog !== 'string') return;
  const bytes = utf8ByteLength(changelog);
  if (bytes > CHANGELOG_MAX_BYTES) {
    problems.push(
      createProblem('schema_max_length.bytes', ['changelog'], {
        limit: CHANGELOG_MAX_BYTES,
        actual: bytes,
      }),
    );
  }
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Keys that are valid but have no effect in this Manifest: warnings, never problems. */
function checkIgnoredKeys(document: Record<string, unknown>, { warnings }: RuleFindings): void {
  const { ui, runtime, permissions } = document;
  if (isRecord(ui) && ui.kind === 'terminal') {
    for (const key of WEB_ONLY_UI_KEYS) {
      if (Object.hasOwn(ui, key)) {
        warnings.push(
          createProblem('ignored_key.ui_web_only', ['ui', key], { key, kind: ui.kind }),
        );
      }
    }
  }
  if (isRecord(runtime) && runtime.kind === 'binary' && Object.hasOwn(runtime, 'node')) {
    warnings.push(
      createProblem('ignored_key.runtime_node', ['runtime', 'node'], { kind: runtime.kind }),
    );
  }
  const filesystem = isRecord(permissions) ? permissions.filesystem : undefined;
  if (
    isRecord(filesystem) &&
    typeof filesystem.scope === 'string' &&
    ['none', 'workspace', 'home'].includes(filesystem.scope) &&
    Array.isArray(filesystem.paths) &&
    filesystem.paths.length > 0
  ) {
    warnings.push(
      createProblem('ignored_key.filesystem_paths', ['permissions', 'filesystem', 'paths'], {
        scope: filesystem.scope,
      }),
    );
  }
}

/** `network` declares either `domains` or `any: true`; `domains` next to `any` is ignored. */
function checkNetwork(document: Record<string, unknown>, findings: RuleFindings): void {
  const permissions = document.permissions;
  const network = isRecord(permissions) ? permissions.network : undefined;
  if (!isRecord(network)) return;
  const hasDomains = Object.hasOwn(network, 'domains');
  const hasAny = Object.hasOwn(network, 'any');
  if (!hasDomains && !hasAny) {
    findings.problems.push(
      createProblem('schema_required.network_access', ['permissions', 'network']),
    );
  } else if (hasDomains && network.any === true) {
    findings.warnings.push(
      createProblem('ignored_key.network_domains', ['permissions', 'network', 'domains']),
    );
  }
}

/** {@link ValidateManifestOptions}, checked and parsed once. */
export interface NormalizedOptions {
  /** Lower-cased GitHub login. */
  publisher?: string;
  publishedVersions?: SemVer[];
}

/**
 * Checks the caller's options. Invalid options are a programming error in the caller (the Store
 * reads published versions from its own database), so they throw instead of becoming Problems.
 */
export function normalizeOptions(options: ValidateManifestOptions = {}): NormalizedOptions {
  if (!isRecord(options)) throw new TypeError('options must be an object when given');
  const normalized: NormalizedOptions = {};
  const { publisher, publishedVersions } = options as {
    publisher?: unknown;
    publishedVersions?: unknown;
  };
  if (publisher !== undefined) {
    if (typeof publisher !== 'string') throw new TypeError('options.publisher must be a string');
    normalized.publisher = publisher.toLowerCase();
  }
  if (publishedVersions !== undefined) {
    if (!Array.isArray(publishedVersions)) {
      throw new TypeError('options.publishedVersions must be an array of version strings');
    }
    normalized.publishedVersions = (publishedVersions as unknown[]).map((version) => {
      const parsed = typeof version === 'string' ? parseStrictVersion(version) : undefined;
      if (parsed === undefined) {
        throw new TypeError(
          `options.publishedVersions contains an invalid version: ${preview(version)}`,
        );
      }
      return parsed;
    });
  }
  return normalized;
}

/** Rules that depend on who is publishing and what is already published (Store-side facts). */
export function optionRules(document: unknown, options: NormalizedOptions): Problem[] {
  const problems: Problem[] = [];
  if (!isRecord(document)) return problems;

  const { publisher, publishedVersions } = options;
  if (publisher !== undefined && typeof document.id === 'string') {
    const slash = document.id.indexOf('/');
    if (slash !== -1) {
      const idPublisher = document.id.slice(0, slash);
      // An upper-case id is a schema_pattern problem; it is not also someone else's.
      if (idPublisher.toLowerCase() !== publisher) {
        problems.push(createProblem('publisher_mismatch', ['id'], { idPublisher, publisher }));
      }
    }
  }

  const version =
    typeof document.version === 'string' ? parseStrictVersion(document.version) : undefined;
  if (version !== undefined && publishedVersions !== undefined && publishedVersions.length > 0) {
    const latest = publishedVersions.reduce((max, candidate) =>
      candidate.compare(max) > 0 ? candidate : max,
    );
    if (version.compare(latest) <= 0) {
      problems.push(
        createProblem('version_not_greater', ['version'], {
          version: version.version,
          latest: latest.version,
        }),
      );
    }
  }
  return problems;
}
