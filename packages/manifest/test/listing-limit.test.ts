/**
 * The listing limit (PACKAGE_LIMITS.maxListedEntries, 100 000 entries) with a small stand-in value,
 * so a folder over the limit takes a moment to create instead of a minute. The full-size limit
 * is tested on zips, which are quick to build (test/sources.test.ts, test/validate-package.test.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveSource, PACKAGE_LIMITS, validatePackage } from '../src/index.js';
import { DirectorySource } from '../src/node/index.js';
import { crc32 } from '../src/zip/crc32.js';
import { findings, problemsOf } from './helpers.js';
import { buildZip } from './support/zip-writer.js';

type Limits = typeof PACKAGE_LIMITS;

vi.mock('../src/limits.js', async (importOriginal) => {
  const { PACKAGE_LIMITS: limits } = await importOriginal<{ PACKAGE_LIMITS: Limits }>();
  return { PACKAGE_LIMITS: Object.freeze({ ...limits, maxFiles: 10, maxListedEntries: 50 }) };
});

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'manifest-listing-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the listing limit', () => {
  it('is the stand-in value here', () => {
    expect(PACKAGE_LIMITS.maxListedEntries).toBe(50);
  });

  it('lets a folder of exactly the limit be listed whole', async () => {
    for (let i = 0; i < 50; i++) mkdirSync(join(dir, `d${String(i)}`));
    const listing = (await DirectorySource.open(dir)).listEntries();
    expect(listing.truncated).toBe(false);
    expect(listing.entries).toHaveLength(50);
  });

  it('stops listing a folder after the limit, across nested folders', async () => {
    for (let i = 0; i < 30; i++) {
      mkdirSync(join(dir, `d${String(i)}`));
      writeFileSync(join(dir, `d${String(i)}`, 'f.txt'), 'x');
    }
    const source = await DirectorySource.open(dir);
    expect(source.listEntries().truncated).toBe(true);
    expect(source.listEntries().entries).toHaveLength(50);
    const result = await validatePackage(source);
    expect(findings(problemsOf(result))).toEqual(['archive_too_many_files@$']);
    expect(problemsOf(result)[0]).toMatchObject({
      messageKey: 'archive_too_many_files.not_counted',
      params: { counted: 50, limit: 10 },
    });
  });

  it('stops listing a zip after the limit', async () => {
    const zip = buildZip(Array.from({ length: 51 }, (_, i) => ({ name: `d${String(i)}/` })));
    const listing = (await ArchiveSource.open(zip)).listEntries();
    expect(listing.truncated).toBe(true);
    expect(listing.entries).toHaveLength(50);
  });

  it('does not confirm the data-descriptor entries of a zip past the limit', async () => {
    // A Deflate stream that ends early, which confirming would report, among the listed entries.
    const content = 'x'.repeat(1000);
    const early = {
      name: 'early.bin',
      method: 8,
      compressedData: Buffer.concat([deflateRawSync(content), Buffer.from('trailing bytes')]),
      crc: crc32(new TextEncoder().encode(content)),
      declaredSize: content.length,
      dataDescriptor: true,
    };
    const zip = buildZip([
      early,
      ...Array.from({ length: 50 }, (_, i) => ({ name: `d${String(i)}/` })),
    ]);
    const source = await ArchiveSource.open(zip);
    expect(source.listEntries().truncated).toBe(true);
    expect(source.listEntries().entries[0]).not.toHaveProperty('unsupported');
    const result = await validatePackage(source);
    expect(findings(problemsOf(result))).toEqual(['archive_too_many_files@$']);
    expect(problemsOf(result)[0]?.messageKey).toBe('archive_too_many_files.not_counted');
  });

  it('does not confirm the data-descriptor entries of a zip with too many files', async () => {
    // Listed whole, but over maxFiles: validatePackage() rejects it from its listing alone.
    const content = 'x'.repeat(1000);
    const zip = buildZip([
      {
        name: 'early.bin',
        method: 8,
        compressedData: Buffer.concat([deflateRawSync(content), Buffer.from('trailing bytes')]),
        crc: crc32(new TextEncoder().encode(content)),
        declaredSize: content.length,
        dataDescriptor: true,
      },
      ...Array.from({ length: 10 }, (_, i) => ({ name: `f${String(i)}.txt`, data: 'x' })),
    ]);
    const source = await ArchiveSource.open(zip);
    expect(source.listEntries().truncated).toBe(false);
    expect(source.listEntries().entries[0]).not.toHaveProperty('unsupported');
    const result = await validatePackage(source);
    expect(problemsOf(result)).toContainEqual(
      expect.objectContaining({
        code: 'archive_too_many_files',
        params: { actual: 11, limit: 10 },
      }),
    );
    expect(problemsOf(result).map((p) => p.messageKey)).not.toContain(
      'archive_invalid.inconsistent',
    );
  });

  it('confirms the data-descriptor entries of a zip with exactly maxFiles files', async () => {
    const content = 'x'.repeat(1000);
    const zip = buildZip([
      {
        name: 'early.bin',
        method: 8,
        compressedData: Buffer.concat([deflateRawSync(content), Buffer.from('trailing bytes')]),
        crc: crc32(new TextEncoder().encode(content)),
        declaredSize: content.length,
        dataDescriptor: true,
      },
      ...Array.from({ length: 9 }, (_, i) => ({ name: `f${String(i)}.txt`, data: 'x' })),
      ...Array.from({ length: 5 }, (_, i) => ({ name: `d${String(i)}/` })),
    ]);
    const [early] = (await ArchiveSource.open(zip)).listEntries().entries;
    expect(early?.unsupported).toMatchObject({ reason: 'inconsistent' });
  });

  it('counts files, not directories, against maxFiles', async () => {
    for (let i = 0; i < 20; i++) mkdirSync(join(dir, `d${String(i)}`));
    for (let i = 0; i < 11; i++) writeFileSync(join(dir, `f${String(i)}`), 'x');
    const result = await validatePackage(await DirectorySource.open(dir));
    expect(problemsOf(result)).toContainEqual(
      expect.objectContaining({
        code: 'archive_too_many_files',
        params: { actual: 11, limit: 10 },
      }),
    );
  });
});
