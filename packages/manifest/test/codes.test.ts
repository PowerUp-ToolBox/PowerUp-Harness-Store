import { describe, expect, it } from 'vitest';
import {
  ArchiveSource,
  interpolate,
  MESSAGES_EN,
  PROBLEM_CODES,
  validateManifest,
  validatePackage,
} from '../src/index.js';
import type { MessageKey, PackageSource, ValidateManifestOptions } from '../src/index.js';
import { binaryManifest, minimalManifest, problemsOf } from './helpers.js';
import { png } from './support/images.js';
import { fixtureDir, folderEntries, hostileArchive } from './support/packages.js';
import { buildZip, extraField } from './support/zip-writer.js';
import type { ZipEntrySpec } from './support/zip-writer.js';

/**
 * Codes shipped so far. Codes are additive-only: this list may grow, but a code in it must never
 * be renamed or removed, because the desktop app, the Store and Publishers' CI match on them.
 */
const SHIPPED_CODES = [
  'schema_invalid_json',
  'schema_type',
  'schema_enum',
  'schema_pattern',
  'schema_required',
  'schema_min_length',
  'schema_max_length',
  'schema_min_items',
  'schema_max_items',
  'schema_max_properties',
  'schema_minimum',
  'schema_maximum',
  'schema_unique_items',
  'unknown_key',
  'slot_default_missing',
  'entry_missing_for_platform',
  'publisher_mismatch',
  'version_invalid',
  'version_not_greater',
  'ignored_key',
  'file_missing',
  'file_type',
  'icon_dimensions',
  'archive_symlink',
  'archive_path_traversal',
  'archive_too_large',
  'archive_too_many_files',
  'archive_invalid',
  'file_too_large',
  'screenshots_too_many',
];

describe('PROBLEM_CODES', () => {
  it('still contains every shipped code (codes are never renamed or removed)', () => {
    expect(Object.values(PROBLEM_CODES)).toEqual(expect.arrayContaining(SHIPPED_CODES));
  });

  it('maps each code to itself, in snake_case', () => {
    for (const [key, code] of Object.entries(PROBLEM_CODES)) {
      expect(code).toBe(key);
      expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PROBLEM_CODES)).toBe(true);
    expect(Object.isFrozen(MESSAGES_EN)).toBe(true);
  });
});

describe('MESSAGES_EN', () => {
  const codes = Object.values(PROBLEM_CODES) as string[];

  it.each(Object.keys(MESSAGES_EN))('%s is a code or <code>.<variant>', (messageKey) => {
    const [code, variant, ...rest] = messageKey.split('.');
    expect(codes).toContain(code);
    expect(rest).toEqual([]);
    if (variant !== undefined) expect(variant).toMatch(/^[A-Za-z_]+$/);
  });

  it.each(codes)('has at least one English message for %s', (code) => {
    const keys = Object.keys(MESSAGES_EN).filter(
      (key) => key === code || key.startsWith(`${code}.`),
    );
    expect(keys.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(MESSAGES_EN))('%s is one or more full sentences', (_key, template) => {
    expect(template).toMatch(/^["{A-Z(a-z]/);
    expect(template.trim()).toBe(template);
    expect(template).toMatch(/[.}]$/);
  });
});

describe('interpolate', () => {
  it('fills placeholders from params', () => {
    expect(interpolate('Must be at most {limit}; found {actual}.', { limit: 5, actual: '6' })).toBe(
      'Must be at most 5; found 6.',
    );
  });

  it('leaves placeholders without a param untouched', () => {
    expect(interpolate('Unknown key "{key}".', {})).toBe('Unknown key "{key}".');
    expect(interpolate('{toString} {constructor}', {})).toBe('{toString} {constructor}');
  });

  it('works for translated templates too (the desktop app renders zh-CN this way)', () => {
    expect(interpolate('未知的键 "{key}"。', { key: 'foo' })).toBe('未知的键 "foo"。');
  });
});

type Example = [input: unknown, options?: ValidateManifestOptions];
const edit = (changes: Record<string, unknown>, base = minimalManifest()) => ({
  ...base,
  ...changes,
});
const permissions = (changes: Record<string, unknown>) => ({
  permissions: {
    filesystem: { scope: 'none' },
    shell: false,
    network: { domains: [] },
    ...changes,
  },
});

/** A whole Harness Package, for the keys only validatePackage() produces. */
interface PackageExample {
  source: () => Promise<PackageSource>;
}

/** The valid minimal package as a zip, with some entries replaced or added. */
function packageExample(changes: ZipEntrySpec[] = [], without: string[] = []): PackageExample {
  const replaced = new Set([...changes.map((entry) => entry.name), ...without]);
  return {
    source: () =>
      ArchiveSource.open(
        buildZip([
          ...folderEntries(fixtureDir('valid-minimal-node')).filter((e) => !replaced.has(e.name)),
          ...changes,
        ]),
      ),
  };
}
const fixtureArchive = (name: string): PackageExample => ({
  source: () => ArchiveSource.open(hostileArchive(name)),
});
const unicodePath = (name: string) =>
  extraField(0x7075, Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from(name)]));

/**
 * One Manifest (or Harness Package) per message key that produces it. Typed as a Record over
 * MessageKey, so a new message cannot be added without showing how a Publisher can get it.
 */
const EXAMPLES: Record<MessageKey, Example | PackageExample | 'fallback' | 'small_stack'> = {
  schema_invalid_json: ['{'],
  'schema_invalid_json.not_serializable': [{ manifestVersion: 1n }],
  'schema_invalid_json.too_large': [edit({ platforms: Array(5000).fill('linux-x64') })],
  // Only when the JSON Schema library runs out of stack: see test/browser-bundle.test.ts.
  'schema_invalid_json.too_many_problems': 'small_stack',
  schema_type: [edit({ name: 42 })],
  'schema_type.non_finite': [
    JSON.stringify(minimalManifest()).replace('"tools":false', '"minContext":1e400'),
  ],
  'schema_type.entry_for_runtime_kind': [edit({ entry: { 'linux-x64': 'a.js' } })],
  schema_enum: [edit({ workspace: 'always' })],
  'schema_enum.const': [edit({ channel: 'beta' })],
  'schema_enum.property_name': [edit({ entry: { mac: 'bin/x' } }, binaryManifest())],
  // Every pattern in the schema has a specific message; this one is the fallback for a new one.
  schema_pattern: 'fallback',
  'schema_pattern.harnessId': [edit({ id: 'Alice/x' })],
  'schema_pattern.license': [edit({ license: 'MIT License' })],
  'schema_pattern.httpUrl': [edit({ homepage: 'example.com' })],
  'schema_pattern.relativePath': [edit({ entry: { 'darwin-arm64': '/bin/x' } }, binaryManifest())],
  'schema_pattern.nodeEntryPath': [edit({ entry: 'main.py' })],
  'schema_pattern.uiPath': [edit({ ui: { kind: 'web', path: 'index.html' } })],
  'schema_pattern.slotName': [edit({ models: { slots: { default: {}, Fast: {} } } })],
  'schema_pattern.modelId': [edit({ models: { slots: { default: { recommended: ['gpt-5'] } } } })],
  'schema_pattern.domain': [edit(permissions({ network: { domains: ['GitHub.com'] } }))],
  schema_required: [{ ...minimalManifest(), name: undefined }],
  'schema_required.network_access': [edit(permissions({ network: {} }))],
  schema_min_length: [edit({ name: 'x' })],
  schema_max_length: [edit({ name: 'x'.repeat(41) })],
  'schema_max_length.bytes': [edit({ changelog: 'é'.repeat(3000) })],
  schema_min_items: [edit({ platforms: [] })],
  schema_max_items: [edit({ tags: ['fun', 'data', 'design', 'other', 'coding', 'writing'] })],
  schema_max_properties: [
    edit({
      models: {
        slots: Object.fromEntries(
          'abcdefghi'.split('').map((c) => [c === 'a' ? 'default' : c, {}]),
        ),
      },
    }),
  ],
  schema_minimum: [edit({ ui: { kind: 'web', readyTimeoutSeconds: 1 } })],
  schema_maximum: [edit({ ui: { kind: 'web', readyTimeoutSeconds: 600 } })],
  schema_unique_items: [edit({ tags: ['fun', 'fun'] })],
  unknown_key: [edit({ description: 'x' })],
  'unknown_key.nested': [edit({ ui: { kind: 'web', title: 'x' } })],
  slot_default_missing: [edit({ models: { slots: { main: {} } } })],
  entry_missing_for_platform: [edit({ entry: { 'linux-x64': 'bin/x' } }, binaryManifest())],
  publisher_mismatch: [minimalManifest(), { publisher: 'bob' }],
  version_invalid: [edit({ version: '1.0.0+1' })],
  version_not_greater: [minimalManifest(), { publishedVersions: ['1.0.0'] }],
  'ignored_key.entry_platform': [
    edit(
      { entry: { ...(binaryManifest().entry as object), 'linux-arm64': 'bin/x' } },
      binaryManifest(),
    ),
  ],
  'ignored_key.ui_web_only': [edit({ ui: { kind: 'terminal', path: '/' } })],
  'ignored_key.runtime_node': [edit({ runtime: { kind: 'binary', node: '22' } }, binaryManifest())],
  'ignored_key.filesystem_paths': [
    edit(permissions({ filesystem: { scope: 'home', paths: ['~/x'] } })),
  ],
  'ignored_key.network_domains': [
    edit(permissions({ network: { any: true, domains: ['a.com'] } })),
  ],
  'schema_invalid_json.file_too_large': packageExample([
    { name: 'manifest.json', data: `${JSON.stringify(minimalManifest())}${' '.repeat(1 << 20)}` },
  ]),
  'entry_missing_for_platform.file': packageExample([], ['dist/index.js']),
  'entry_missing_for_platform.platform_file': {
    source: () =>
      ArchiveSource.open(buildZip(folderEntries(fixtureDir('entry-file-missing-binary')))),
  },
  file_missing: packageExample([], ['README.md']),
  'file_missing.manifest_nested': {
    source: () =>
      ArchiveSource.open(
        buildZip(
          folderEntries(fixtureDir('valid-minimal-node')).map((entry) => ({
            ...entry,
            name: `hello-web/${entry.name}`,
          })),
        ),
      ),
  },
  'file_type.icon': packageExample([{ name: 'assets/icon.png', data: 'not a png' }]),
  'file_type.screenshot': packageExample([{ name: 'assets/shot.gif', data: 'GIF89a' }]),
  icon_dimensions: packageExample([{ name: 'assets/icon.png', data: png(256, 256) }]),
  archive_symlink: fixtureArchive('archive_symlink'),
  archive_path_traversal: fixtureArchive('archive_path_traversal'),
  'archive_path_traversal.absolute': packageExample([{ name: '/etc/x', data: 'x' }]),
  'archive_path_traversal.other_name': packageExample([
    { name: 'x.txt', data: 'x', extra: unicodePath('../x.txt') },
  ]),
  archive_too_large: fixtureArchive('archive_too_large'),
  archive_too_many_files: fixtureArchive('archive_too_many_files'),
  'archive_too_many_files.not_counted': {
    source: () =>
      ArchiveSource.open(
        buildZip(
          Array.from({ length: 100_001 }, (_, i) => ({ name: `${String(i)}/` })),
          { zip64End: true },
        ),
      ),
  },
  archive_invalid: fixtureArchive('archive_invalid'),
  'archive_invalid.entry': packageExample([
    { name: 'manifest.json', data: JSON.stringify(minimalManifest()), crc: 1 },
  ]),
  'archive_invalid.duplicate': packageExample([
    { name: 'README.md', data: '# one' },
    { name: 'README.md', data: '# two' },
  ]),
  'archive_invalid.encrypted': packageExample([{ name: 'secret.bin', data: 'x', flags: 1 }]),
  'archive_invalid.compression_method': packageExample([{ name: 'a.bz2', data: 'x', method: 12 }]),
  'file_too_large.readme': packageExample([{ name: 'README.md', data: 'x'.repeat(60_000) }]),
  'file_too_large.screenshot': packageExample([
    { name: 'assets/big.png', data: Buffer.concat([png(8, 8), Buffer.alloc(3 << 20)]) },
  ]),
  screenshots_too_many: packageExample(
    Array.from({ length: 6 }, (_, i) => ({ name: `assets/${String(i)}.png`, data: png(8, 8) })),
  ),
};

describe('every message key', () => {
  it.each(Object.entries(EXAMPLES).filter(([, example]) => Array.isArray(example)))(
    '%s is produced by its example',
    (messageKey, example) => {
      const [input, options] = example as Example;
      const result = validateManifest(input, options);
      const produced = [...problemsOf(result), ...result.warnings].map(
        (finding) => finding.messageKey,
      );
      expect(produced).toContain(messageKey);
    },
  );

  it.each(
    Object.entries(EXAMPLES).filter(
      (entry): entry is [string, PackageExample] =>
        typeof entry[1] === 'object' && 'source' in entry[1],
    ),
  )('%s is produced by its Harness Package', async (messageKey, example) => {
    const result = await validatePackage(await example.source());
    const produced = [...problemsOf(result), ...result.warnings].map(
      (finding) => finding.messageKey,
    );
    expect(produced).toContain(messageKey);
  });
});
