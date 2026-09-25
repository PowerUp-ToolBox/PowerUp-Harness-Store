/**
 * The three package sources and the zip reader behind ArchiveSource: listing, names, links,
 * reading with limits, and every way a zip can be malformed or hostile.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as nodeCrc32, deflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveSource, InMemorySource, PACKAGE_LIMITS, PackageReadError } from '../src/index.js';
import type { PackageListing, RandomAccessReader } from '../src/index.js';
import { DirectorySource, fileReader, openArchiveFile } from '../src/node/index.js';
import { crc32 } from '../src/zip/crc32.js';
import { CP437_HIGH, decodeName } from '../src/zip/central-directory.js';
import { fixtureDir, zipFolder } from './support/packages.js';
import {
  buildZip,
  extraField,
  localRecord,
  sparseReader,
  writeZipFile,
} from './support/zip-writer.js';
import type { DataDescriptorSpec, ZipEntrySpec } from './support/zip-writer.js';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const open = (entries: ZipEntrySpec[], options?: Parameters<typeof buildZip>[1]) =>
  ArchiveSource.open(buildZip(entries, options));
const unreadable = async (bytes: Uint8Array | RandomAccessReader) =>
  (await ArchiveSource.open(bytes)).listEntries().unreadable;

let scratch = '';
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'manifest-sources-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('crc32', () => {
  it('matches zlib for any input, in one go or in parts', () => {
    const samples = [
      new Uint8Array(0),
      new TextEncoder().encode('123456789'),
      deflateRawSync('x'.repeat(10_000)),
    ];
    for (const bytes of samples) {
      expect(crc32(bytes)).toBe(nodeCrc32(bytes));
      const half = Math.floor(bytes.length / 2);
      expect(crc32(bytes.subarray(half), crc32(bytes.subarray(0, half)))).toBe(nodeCrc32(bytes));
    }
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('ArchiveSource: listing', () => {
  it('lists files, directories and links with their sizes, and reads files', async () => {
    const source = await open([
      { name: 'dist/' },
      { name: 'dist/index.js', data: 'console.log(1);' },
      { name: 'empty.txt' },
      { name: 'link', data: '/etc/passwd', unixMode: 0o120777, method: 0 },
    ]);
    expect(source.listEntries()).toEqual({
      entries: [
        { name: 'dist/', kind: 'directory', size: 0 },
        { name: 'dist/index.js', kind: 'file', size: 15 },
        { name: 'empty.txt', kind: 'file', size: 0 },
        { name: 'link', kind: 'symlink', size: 11 },
      ],
      archiveSize: expect.any(Number) as number,
      truncated: false,
    });
    expect(source.listFiles()).toEqual(['dist/index.js', 'empty.txt']);
    expect(text(await source.readFile('dist/index.js'))).toBe('console.log(1);');
    expect(await source.readFile('empty.txt')).toEqual(new Uint8Array(0));
  });

  it('accepts bytes, an ArrayBuffer or a reader, and refuses anything else', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'a' }]);
    const copy = new Uint8Array(zip); // its own ArrayBuffer, unlike a pooled Buffer
    for (const input of [zip, copy, copy.buffer, sparseReader(zip, 0)]) {
      expect((await ArchiveSource.open(input)).listFiles()).toEqual(['a.txt']);
    }
    for (const input of [{}, null, undefined, 'archive.zip', 42]) {
      await expect(ArchiveSource.open(input as RandomAccessReader)).rejects.toThrow(TypeError);
    }
    await expect(
      ArchiveSource.open({ size: -1, read: () => Promise.resolve(new Uint8Array()) }),
    ).rejects.toThrow(TypeError);
  });

  it('normalizes names to package paths: no "." or empty segments', async () => {
    const source = await open([
      { name: './manifest.json', data: '{}' },
      { name: 'dist//index.js', data: 'x' },
    ]);
    expect(source.listFiles()).toEqual(['manifest.json', 'dist/index.js']);
    expect(text(await source.readFile('manifest.json'))).toBe('{}');
  });

  it('keeps unsafe names out of the files (they are listed for the safety rules)', async () => {
    const source = await open([
      { name: '../escape.txt', data: 'x' },
      { name: '/etc/passwd', data: 'x' },
      { name: 'C:/Windows/x', data: 'x' },
      { name: 'ok.txt', data: 'x' },
    ]);
    expect(source.listFiles()).toEqual(['ok.txt']);
    expect(source.listEntries().entries.map((entry) => entry.name)).toEqual([
      '../escape.txt',
      '/etc/passwd',
      'C:/Windows/x',
      'ok.txt',
    ]);
    await expect(source.readFile('../escape.txt')).rejects.toThrow(/not a file/);
  });

  it('returns copies, never views of the archive bytes', async () => {
    const zip = buildZip([{ name: 'stored.txt', data: 'abc', method: 0 }]);
    const source = await ArchiveSource.open(zip);
    (await source.readFile('stored.txt')).fill(0);
    expect(text(await source.readFile('stored.txt'))).toBe('abc');
  });

  it('lists a path stored twice once as a file, reading the first copy', async () => {
    const source = await open([
      { name: 'manifest.json', data: 'first' },
      { name: 'manifest.json', data: 'second' },
    ]);
    expect(source.listFiles()).toEqual(['manifest.json']);
    expect(text(await source.readFile('manifest.json'))).toBe('first');
  });

  it('marks encrypted entries and unsupported compression methods', async () => {
    const source = await open([
      { name: 'secret.txt', data: 'x', flags: 0x0001 },
      { name: 'bzip2.txt', data: 'x', method: 12 },
      { name: 'folder/', flags: 0x0001 },
    ]);
    expect(source.listEntries().entries.map((entry) => entry.unsupported)).toEqual([
      { reason: 'encrypted' },
      { reason: 'compression_method', method: 12 },
      undefined,
    ]);
    await expect(source.readFile('secret.txt')).rejects.toThrow(PackageReadError);
    await expect(source.readFile('bzip2.txt')).rejects.toThrow(/compression method 12/);
  });

  it('detects a link by its Unix mode whatever host wrote it', async () => {
    for (const host of [0, 3, 10, 19]) {
      const source = await open([{ name: 'l', data: 'x', unixMode: 0o120755, host }]);
      expect(source.listEntries().entries[0]?.kind).toBe('symlink');
    }
    const regular = await open([{ name: 'f', data: 'x', unixMode: 0o100755 }]);
    expect(regular.listEntries().entries[0]?.kind).toBe('file');
  });
});

describe('ArchiveSource: names', () => {
  it('decodes UTF-8 names, flagged or not, and CP437 names', async () => {
    const source = await open([
      { name: 'café.md', data: 'x' }, // bit 11 set by the writer
      { name: 'naïve.md', data: 'x', rawName: new TextEncoder().encode('naïve.md') }, // no flag
      { name: 'cp437', data: 'x', rawName: Uint8Array.of(0x72, 0xe9, 0x73, 0x75, 0x6d, 0xe9) },
    ]);
    expect(source.listFiles()).toEqual(['café.md', 'naïve.md', 'rΘsumΘ']);
  });

  it('has a complete CP437 table', () => {
    expect(Array.from(CP437_HIGH)).toHaveLength(128);
    expect(decodeName(Uint8Array.of(0x80, 0xe1, 0xff), false)).toBe('Çß\u00a0');
  });

  it('uses a matching Info-ZIP Unicode Path field, and keeps both names for the safety rules', async () => {
    const raw = new TextEncoder().encode('plain.txt');
    const unicode = (name: string, crc = nodeCrc32(raw)) => {
      const data = Buffer.alloc(5);
      data.writeUInt8(1, 0);
      data.writeUInt32LE(crc, 1);
      return extraField(0x7075, Buffer.concat([data, Buffer.from(name)]));
    };
    const matching = await open([
      { name: 'plain.txt', rawName: raw, data: 'x', extra: unicode('ünï.txt') },
    ]);
    expect(matching.listEntries().entries[0]).toMatchObject({
      name: 'ünï.txt',
      otherNames: ['plain.txt'],
    });
    const stale = await open([
      { name: 'plain.txt', rawName: raw, data: 'x', extra: unicode('../evil.txt', 1234) },
    ]);
    expect(stale.listEntries().entries[0]).toMatchObject({
      name: 'plain.txt',
      otherNames: ['../evil.txt'],
    });
  });
});

describe('ArchiveSource: reading', () => {
  const big = 'The quick brown fox. '.repeat(10_000);

  it('reads only the bytes asked for, stored or deflated', async () => {
    const source = await open([
      { name: 'deflated.txt', data: big },
      { name: 'stored.txt', data: big, method: 0 },
    ]);
    for (const path of ['deflated.txt', 'stored.txt']) {
      expect(text(await source.readFile(path, { maxBytes: 9 }))).toBe('The quick');
      expect(text(await source.readFile(path))).toBe(big);
      expect(await source.readFile(path, { maxBytes: 0 })).toHaveLength(0);
    }
    await expect(source.readFile('stored.txt', { maxBytes: -1 })).rejects.toThrow(TypeError);
  });

  /** A reader over `zip` that counts its reads. */
  const countingReader = (zip: Uint8Array) => sparseReader(zip, 0);

  it('stops inflating a zip bomb at the bytes asked for, after a slice sized to them', async () => {
    // 64 MB of zeros deflate to 64 KB: a 1 KB slice would inflate to about 1 MB, a slice of a few
    // dozen bytes to a few dozen KB.
    const zeros = new Uint8Array(64 * 1024 * 1024);
    const bomb: ZipEntrySpec = {
      name: 'assets/icon.png',
      method: 8,
      compressedData: deflateRawSync(zeros),
      declaredSize: zeros.length,
      crc: nodeCrc32(zeros),
    };
    const reader = countingReader(buildZip([bomb]));
    const source = await ArchiveSource.open(reader);
    const { reads, bytesRead } = reader;
    const started = performance.now();
    expect(await source.readFile('assets/icon.png', { maxBytes: 33 })).toEqual(new Uint8Array(33));
    expect(await source.readFile('assets/icon.png', { maxBytes: 8 })).toEqual(new Uint8Array(8));
    expect(performance.now() - started).toBeLessThan(100);
    // A slice or two of a few dozen bytes each: the local header was read when the archive was
    // opened.
    expect(reader.reads - reads).toBeLessThanOrEqual(4);
    expect(reader.bytesRead - bytesRead).toBeLessThanOrEqual(200);
  });

  it('stops inflating as soon as an entry exceeds its declared size', async () => {
    const zeros = new Uint8Array(64 * 1024 * 1024);
    const lying: ZipEntrySpec = {
      name: 'manifest.json',
      method: 8,
      compressedData: deflateRawSync(zeros),
      declaredSize: 1000,
      crc: 0,
    };
    const reader = countingReader(buildZip([lying]));
    const source = await ArchiveSource.open(reader);
    const opened = reader.reads;
    await expect(source.readFile('manifest.json')).rejects.toThrow(/more than its declared size/);
    expect(reader.reads - opened).toBe(1); // one 1 KB slice
  });

  it.each<[string, ZipEntrySpec, RegExp]>([
    ['a CRC-32 that does not match', { name: 'f', data: 'hello', crc: 1 }, /CRC-32/],
    [
      'a stored CRC-32 that does not match',
      { name: 'f', data: 'hello', method: 0, crc: 1 },
      /CRC-32/,
    ],
    [
      'more bytes than declared',
      { name: 'f', data: 'x'.repeat(5000), declaredSize: 10 },
      /more than/,
    ],
    ['fewer bytes than declared', { name: 'f', data: 'hello', declaredSize: 50 }, /less than/],
    [
      'a stored size that differs',
      { name: 'f', data: 'hello', method: 0, declaredSize: 4 },
      /stored size/,
    ],
    [
      'a local header naming another file',
      { name: 'manifest.json', data: '{}', localName: 'other.json' },
      /different file/,
    ],
  ])('refuses %s', async (_name, entry, message) => {
    const source = await open([entry]);
    const path = source.listFiles()[0] ?? '';
    const error = await source.readFile(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PackageReadError);
    expect(String(error)).toMatch(message);
  });

  it('refuses corrupt Deflate data', async () => {
    const zip = buildZip([{ name: 'f', data: 'hello world, hello world' }]);
    const offset = 30 + 1; // local header + name
    zip.fill(0xff, offset, offset + 6);
    const source = await ArchiveSource.open(zip);
    await expect(source.readFile('f')).rejects.toThrow(PackageReadError);
  });

  it('refuses data that runs into the central directory', async () => {
    const zip = buildZip([{ name: 'f', data: 'hello', method: 0 }]);
    // Raise the compressed size in the central directory (offset 20 of its header).
    const cd = zip.length - 22 - (46 + 1);
    new DataView(zip.buffer, zip.byteOffset).setUint32(cd + 20, 5000, true);
    new DataView(zip.buffer, zip.byteOffset).setUint32(cd + 24, 5000, true);
    const source = await ArchiveSource.open(zip);
    expect(source.listEntries().entries[0]?.unsupported).toEqual({
      reason: 'inconsistent',
      detail: 'its data runs into the central directory',
    });
    await expect(source.readFile('f')).rejects.toThrow(/runs into the central directory/);
  });
});

/**
 * Unpackers that read a zip in order take names and sizes from the local headers, never from
 * the central directory: every local header must say what the central directory says, and every
 * byte before the central directory must belong to a listed entry.
 */
describe('ArchiveSource: local headers', () => {
  const listingOf = async (entries: ZipEntrySpec[]) => (await open(entries)).listEntries();
  const recordLength = (spec: ZipEntrySpec) => localRecord(spec).length;

  it('lists an archive whose local headers match its central directory, with nothing unlisted', async () => {
    const listing = await listingOf([
      { name: 'a/' },
      { name: 'a/b.txt', data: 'hello '.repeat(50) },
      { name: 'c.bin', data: 'x', method: 0 },
      { name: 'd.txt', data: 'd', zip64: true },
    ]);
    expect(listing.unlistedData).toBeUndefined();
    for (const entry of listing.entries) {
      expect(entry).not.toHaveProperty('localName');
      expect(entry).not.toHaveProperty('unsupported');
    }
  });

  it.each<[string, DataDescriptorSpec]>([
    ['with a signature', {}],
    ['without a signature', { signature: false }],
    ['with 8-byte sizes', { wide: true }],
    ['with the sizes in the local header too', { localSizes: true }],
  ])('reads entries followed by a data descriptor %s', async (_name, dataDescriptor) => {
    const source = await open([
      { name: 'empty/', dataDescriptor },
      { name: 'a.txt', data: 'alpha '.repeat(100), dataDescriptor },
      { name: 'b.txt', data: 'beta', method: 0, dataDescriptor },
      { name: 'c.txt', data: 'gamma', zip64: true, dataDescriptor },
      { name: 'd.txt', data: 'delta' },
    ]);
    const listing = source.listEntries();
    expect(listing.unlistedData).toBeUndefined();
    expect(listing.entries.map((entry) => entry.unsupported)).toEqual(Array(5).fill(undefined));
    expect(text(await source.readFile('a.txt'))).toBe('alpha '.repeat(100));
    expect(text(await source.readFile('b.txt'))).toBe('beta');
    expect(text(await source.readFile('c.txt'))).toBe('gamma');
    expect(text(await source.readFile('d.txt'))).toBe('delta');
  });

  it.each<[string, ZipEntrySpec, string]>([
    [
      'another compression method',
      { name: 'f', data: 'hello hello', local: { method: 0 } },
      'its local header gives compression method 0, its central directory record 8',
    ],
    [
      'another encryption flag',
      { name: 'f', data: 'x', local: { flags: 0x0001 } },
      'its local header and its central directory record disagree about encryption',
    ],
    [
      'another CRC-32',
      { name: 'f', data: 'x', local: { crc: 1 } },
      'its local header gives another CRC-32 than its central directory record',
    ],
    [
      'another compressed size',
      { name: 'f', data: 'x', method: 0, local: { compressedSize: 0 } },
      'its local header gives another compressed size than its central directory record',
    ],
    [
      'another size',
      { name: 'f', data: 'hello', local: { size: 4 } },
      'its local header gives another size than its central directory record',
    ],
    [
      'another size beside a data descriptor',
      { name: 'f', data: 'hello', dataDescriptor: { localSizes: true }, local: { size: 3 } },
      'its local header gives another size than its central directory record',
    ],
    [
      'saturated sizes without a ZIP64 field',
      { name: 'f', data: 'x', local: { size: 0xffffffff } },
      'its local header lacks the ZIP64 sizes it refers to',
    ],
    [
      'a data descriptor that does not match',
      { name: 'f', data: 'x', dataDescriptor: { crc: 1 } },
      'its data descriptor does not match its central directory record',
    ],
    [
      'no local header at all',
      { name: 'f', data: 'x', listedAt: 1 },
      'there is no local header where the central directory says',
    ],
  ])('lists an entry with %s as inconsistent, and never reads it', async (_name, spec, detail) => {
    const source = await open([{ name: 'a.txt', data: 'a' }, spec]);
    expect(source.listEntries().entries[1]?.unsupported).toEqual({
      reason: 'inconsistent',
      detail,
    });
    const error = await source.readFile('f').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PackageReadError);
    expect((error as Error).message).toBe(detail);
  });

  it('lists the name in the local header when its bytes differ, and never reads the entry', async () => {
    const source = await open([{ name: 'dist/app.js', data: 'x', localName: '../../app.js' }]);
    expect(source.listEntries().entries).toEqual([
      { name: 'dist/app.js', localName: '../../app.js', kind: 'file', size: 1 },
    ]);
    await expect(source.readFile('dist/app.js')).rejects.toThrow(/different file/);
  });

  it('adds a Unicode Path name found only in the local header to the other names', async () => {
    const unicodePath = extraField(
      0x7075,
      Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from('../evil.txt')]),
    );
    const listing = await listingOf([{ name: 'x.txt', data: 'x', local: { extra: unicodePath } }]);
    expect(listing.entries[0]?.otherNames).toEqual(['../evil.txt']);
  });

  const orphan: ZipEntrySpec = { name: '../orphan.txt', data: 'hidden', unlisted: true };
  const a: ZipEntrySpec = { name: 'a.txt', data: 'a' };
  it.each<[string, () => Uint8Array | RandomAccessReader, { offset: number; length: number }]>([
    [
      'an entry the central directory leaves out, first',
      () => buildZip([orphan, a]),
      { offset: 0, length: recordLength(orphan) },
    ],
    [
      'an entry the central directory leaves out, between two others',
      () => buildZip([a, orphan, { name: 'b.txt', data: 'b' }]),
      { offset: recordLength(a), length: recordLength(orphan) },
    ],
    [
      'an entry the central directory leaves out, last',
      () => buildZip([a, orphan]),
      { offset: recordLength(a), length: recordLength(orphan) },
    ],
    [
      'bytes before the first entry',
      () => sparseReader(buildZip([a], { offset: 100 }), 100),
      {
        offset: 0,
        length: 100,
      },
    ],
  ])('lists %s as unlisted data', async (_name, make, unlistedData) => {
    const source = await ArchiveSource.open(make());
    expect(source.listEntries().unlistedData).toEqual(unlistedData);
    expect(text(await source.readFile('a.txt'))).toBe('a');
  });

  it('lists entries that share a local header as inconsistent', async () => {
    const source = await open([a, { name: 'b.txt', data: 'a', listedAt: 0 }]);
    expect(source.listEntries().entries[1]).toMatchObject({
      localName: 'a.txt',
      unsupported: {
        reason: 'inconsistent',
        detail: 'it shares bytes of the archive with "a.txt"',
      },
    });
  });

  it('lists an entry hidden inside the data of another (overlapping files) as inconsistent', async () => {
    const inner: ZipEntrySpec = { name: 'inner.txt', data: 'hidden', method: 0 };
    const source = await open([
      { name: 'outer.bin', data: localRecord(inner), method: 0 },
      { ...inner, listedAt: 30 + 'outer.bin'.length },
    ]);
    const [outer, hidden] = source.listEntries().entries;
    expect(outer?.unsupported).toBeUndefined();
    expect(hidden?.unsupported).toEqual({
      reason: 'inconsistent',
      detail: 'it shares bytes of the archive with "outer.bin"',
    });
    expect(source.listEntries().unlistedData).toBeUndefined();
  });

  it('reads the local headers of many small files in a few large reads', async () => {
    const entries = Array.from({ length: 5000 }, (_, i) => ({
      name: `lib/${String(i)}.js`,
      data: `export default ${String(i)};`,
    }));
    const reader = sparseReader(buildZip(entries), 0);
    const source = await ArchiveSource.open(reader);
    expect(source.listFiles()).toHaveLength(5000);
    expect(source.listEntries().unlistedData).toBeUndefined();
    // The end record, the central directory, then one read per 64 KB of local headers and data.
    expect(reader.reads).toBeLessThan(12);
  });
});

/**
 * The three ways an entry can look one thing to a reader that uses the central directory and
 * another to a streaming unpacker (a local "xl" file-type field, a Deflate stream that ends
 * before its declared size, and a stored entry with a data descriptor inside its data). Every one
 * is reported as inconsistent and never read, so the archive-safety rules hold for both readers.
 */
describe('ArchiveSource: entries that differ for a streaming unpacker', () => {
  /** A libarchive "xl" extra field carrying "version made by" (host) and external attributes. */
  const xlField = (externalAttributes: number, host = 3) => {
    const bytes = new Uint8Array(7);
    const view = new DataView(bytes.buffer);
    bytes[0] = 0x05; // bitmap: version made by (0x01) and external attributes (0x04)
    view.setUint16(1, (host << 8) | 20, true);
    view.setUint32(3, externalAttributes >>> 0, true);
    return extraField(0x6c78, bytes);
  };
  const unixMode = (mode: number) => (mode << 16) >>> 0;
  /** A data descriptor: signature, CRC-32, and 4-byte compressed and uncompressed sizes. */
  const descriptor = (crc: number, compressedSize: number, size: number) => {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x08074b50, true);
    view.setUint32(4, crc >>> 0, true);
    view.setUint32(8, compressedSize, true);
    view.setUint32(12, size, true);
    return bytes;
  };
  const concatBytes = (...parts: Uint8Array[]) => Buffer.concat(parts.map((p) => Buffer.from(p)));
  const inconsistent = (spec: ZipEntrySpec, match: RegExp) => {
    it(`lists ${spec.name} as inconsistent, and never reads it`, async () => {
      const source = await open([{ name: 'a.txt', data: 'a' }, spec]);
      const entry = source.listEntries().entries[1];
      expect(entry?.unsupported).toMatchObject({ reason: 'inconsistent' });
      expect((entry?.unsupported as { detail: string }).detail).toMatch(match);
      const path = source.listFiles().find((p) => p !== 'a.txt') ?? spec.name;
      await expect(source.readFile(path)).rejects.toThrow(PackageReadError);
    });
  };

  inconsistent(
    {
      name: 'dist/index.js',
      data: '/etc/passwd',
      method: 0,
      local: { extra: xlField(unixMode(0o120777)) },
    },
    /file type to symlink .*"xl"/,
  );
  inconsistent(
    { name: 'app', data: 'x', method: 0, host: 0, local: { extra: xlField(0x10, 0) } },
    /file type to directory .*"xl"/,
  );

  it('accepts a local "xl" field that agrees with the central directory', async () => {
    const source = await open([
      { name: 'keep.js', data: 'x', method: 0, local: { extra: xlField(unixMode(0o100644)) } },
    ]);
    expect(source.listEntries().entries[0]).not.toHaveProperty('unsupported');
    expect(text(await source.readFile('keep.js'))).toBe('x');
  });

  // A Deflate entry with a data descriptor whose Deflate stream ends early, then a fake descriptor
  // a streaming unpacker accepts, then a hidden "../../evil.txt" it would go on to unpack.
  it('lists a Deflate data-descriptor entry that ends before its size as inconsistent', async () => {
    const content = 'console.log(1);\n'.repeat(20);
    const stream = deflateRawSync(content);
    const contentCrc = nodeCrc32(content);
    const hidden = localRecord({ name: '../../evil.txt', data: 'pwned', method: 0 });
    const blob = concatBytes(stream, descriptor(contentCrc, stream.length, content.length), hidden);
    const source = await open([
      {
        name: 'dist/lib.js',
        method: 8,
        compressedData: blob,
        crc: contentCrc,
        declaredSize: content.length,
        dataDescriptor: { crc: contentCrc, compressedSize: blob.length, size: content.length },
      },
    ]);
    const unsupported = source.listEntries().entries[0]?.unsupported as {
      reason: string;
      detail: string;
    };
    expect(unsupported.reason).toBe('inconsistent');
    expect(unsupported.detail).toMatch(/Deflate stream ends before/);
    expect(source.listEntries().unlistedData).toBeUndefined();
    await expect(source.readFile('dist/lib.js')).rejects.toThrow(/Deflate stream ends before/);
  });

  it('accepts a Deflate data-descriptor entry whose stream fills its declared size', async () => {
    const content = 'alpha '.repeat(200);
    const source = await open([{ name: 'ok.txt', data: content, dataDescriptor: true }]);
    expect(source.listEntries().entries[0]).not.toHaveProperty('unsupported');
    expect(text(await source.readFile('ok.txt'))).toBe(content);
  });

  it('lists a stored data-descriptor entry with a copy of its descriptor inside as inconsistent', async () => {
    const prefix = Buffer.from('smuggled prefix.'); // the bytes before the fake descriptor
    const hidden = localRecord({ name: '../../evil.txt', data: 'pwned', method: 0 });
    // The fake descriptor's compressed-size field equals the bytes before it, so a scanner stops.
    const data = concatBytes(prefix, descriptor(0, prefix.length, prefix.length), hidden);
    const source = await open([{ name: 'dist/blob.bin', method: 0, data, dataDescriptor: true }]);
    const unsupported = source.listEntries().entries[0]?.unsupported as {
      reason: string;
      detail: string;
    };
    expect(unsupported.reason).toBe('inconsistent');
    expect(unsupported.detail).toMatch(/stored with a data descriptor/);
    await expect(source.readFile('dist/blob.bin')).rejects.toThrow(/stored with a data descriptor/);
  });

  it('accepts a stored data-descriptor entry whose data holds no matching descriptor', async () => {
    // The bytes 50 4b 07 08 appear, but the compressed-size field after them is not the offset.
    const data = concatBytes(Buffer.from('head'), descriptor(0, 999, 999), Buffer.from('tail'));
    const source = await open([{ name: 'clean.bin', method: 0, data, dataDescriptor: true }]);
    expect(source.listEntries().entries[0]).not.toHaveProperty('unsupported');
    expect(await source.readFile('clean.bin')).toHaveLength(data.length);
  });
});

describe('ArchiveSource: the end of central directory record and ZIP64', () => {
  it('reads an archive with a comment', async () => {
    const signature = String.fromCharCode(0x50, 0x4b, 0x05, 0x06);
    // A signature in the last 21 bytes cannot start a record, so no tool takes it for one.
    for (const comment of ['hello', signature, `${'x'.repeat(10)}${signature}`]) {
      const source = await open([{ name: 'a.txt', data: 'a' }], { comment });
      expect(source.listEntries().unreadable).toBeUndefined();
      expect(source.listFiles()).toEqual(['a.txt']);
    }
  });

  // Zip tools take the last end of central directory record they find: a second one after the
  // real record (in its comment, or appended) could give them another list of files.
  it.each<[string, () => Uint8Array]>([
    [
      'a comment that holds another end record',
      () => {
        const signature = String.fromCharCode(0x50, 0x4b, 0x05, 0x06);
        return buildZip([{ name: 'a.txt', data: 'a' }], {
          comment: `${signature}${'x'.repeat(30)}`,
        });
      },
    ],
    [
      'trailing bytes',
      () => Buffer.concat([buildZip([{ name: 'a.txt', data: 'a' }]), Buffer.from('trailing')]),
    ],
  ])('refuses an archive whose end record is followed by %s', async (_name, make) => {
    expect(await unreadable(make())).toMatch(/followed by other bytes/);
  });

  it('reads a ZIP64 end record whose values the end record repeats', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'a' }], { zip64End: true });
    const view = new DataView(zip.buffer, zip.byteOffset);
    view.setUint16(zip.length - 22 + 8, 1, true);
    view.setUint16(zip.length - 22 + 10, 1, true);
    const source = await ArchiveSource.open(zip);
    expect(source.listEntries().unreadable).toBeUndefined();
    expect(source.listFiles()).toEqual(['a.txt']);
  });

  it('reads ZIP64 entries and a ZIP64 end record', async () => {
    const source = await open(
      [
        { name: 'a.txt', data: 'alpha', zip64: true },
        { name: 'b.txt', data: 'beta', method: 0, zip64: true },
      ],
      { zip64End: true },
    );
    expect(source.listEntries().unreadable).toBeUndefined();
    expect(source.listFiles()).toEqual(['a.txt', 'b.txt']);
    expect(text(await source.readFile('a.txt'))).toBe('alpha');
    expect(text(await source.readFile('b.txt'))).toBe('beta');
  });

  it.each<[string, () => Uint8Array, RegExp]>([
    ['an empty file', () => new Uint8Array(0), /too short/],
    [
      'text',
      () => new TextEncoder().encode('not a zip archive at all, just some text'),
      /not a zip/,
    ],
    ['a zip cut short', () => buildZip([{ name: 'a', data: 'a' }]).subarray(0, 40), /not a zip/],
    [
      'a split archive',
      () => {
        const zip = buildZip([{ name: 'a', data: 'a' }]);
        new DataView(zip.buffer, zip.byteOffset).setUint16(zip.length - 22 + 4, 1, true);
        return zip;
      },
      /split/,
    ],
    [
      'a central directory outside the file',
      () => {
        const zip = buildZip([{ name: 'a', data: 'a' }]);
        new DataView(zip.buffer, zip.byteOffset).setUint32(zip.length - 22 + 16, 1_000_000, true);
        return zip;
      },
      /outside/,
    ],
    [
      'more entries than the central directory holds',
      () => {
        const zip = buildZip([{ name: 'a', data: 'a' }]);
        const view = new DataView(zip.buffer, zip.byteOffset);
        view.setUint16(zip.length - 22 + 8, 500, true);
        view.setUint16(zip.length - 22 + 10, 500, true);
        return zip;
      },
      /more entries/,
    ],
    [
      'a corrupt central directory',
      () => {
        const zip = buildZip([{ name: 'a', data: 'a' }]);
        zip[zip.length - 22 - 47] = 0; // first byte of the central header signature
        return zip;
      },
      /corrupt/,
    ],
    [
      'a ZIP64 end record without its locator',
      () => {
        const zip = buildZip([{ name: 'a', data: 'a' }]);
        new DataView(zip.buffer, zip.byteOffset).setUint16(zip.length - 22 + 10, 0xffff, true);
        return zip;
      },
      /ZIP64/,
    ],
    [
      'an entry whose saturated sizes have no ZIP64 field',
      () => {
        const zip = buildZip([{ name: 'a', data: 'a' }]);
        new DataView(zip.buffer, zip.byteOffset).setUint32(
          zip.length - 22 - 47 + 24,
          0xffffffff,
          true,
        );
        return zip;
      },
      /ZIP64/,
    ],
    [
      // Info-ZIP would take the gap for bytes prepended to the archive and shift every offset.
      'a gap between its central directory and its end record',
      () => {
        const zip = buildZip([{ name: 'a', data: 'a' }]);
        return Buffer.concat([zip.subarray(0, -22), Buffer.from('gap'), zip.subarray(-22)]);
      },
      /does not end where its end of central directory record starts/,
    ],
    [
      // Some tools read records until the signature stops matching, not the count.
      'more central directory records than its end record counts',
      () => {
        const zip = buildZip([
          { name: 'a', data: 'a' },
          { name: 'b', data: 'b' },
        ]);
        const view = new DataView(zip.buffer, zip.byteOffset);
        view.setUint16(zip.length - 22 + 8, 1, true);
        view.setUint16(zip.length - 22 + 10, 1, true);
        return zip;
      },
      /holds more than its end record says/,
    ],
    [
      // Python's zipfile reads the ZIP64 record whenever its locator is there; Go only when needed.
      'a ZIP64 end record that disagrees with its end record',
      () => {
        const zip = buildZip([{ name: 'a', data: 'a' }], { zip64End: true });
        const view = new DataView(zip.buffer, zip.byteOffset);
        view.setUint16(zip.length - 22 + 8, 2, true);
        view.setUint16(zip.length - 22 + 10, 2, true);
        return zip;
      },
      /disagrees/,
    ],
    [
      'a ZIP64 end record that does not end at its locator',
      () => {
        const zip = buildZip([{ name: 'a', data: 'a' }], { zip64End: true });
        const recordOffset = zip.length - 22 - 20 - 56;
        new DataView(zip.buffer, zip.byteOffset).setUint32(recordOffset + 4, 40, true);
        return zip;
      },
      /ZIP64 end of central directory record is corrupt/,
    ],
  ])('reports %s as unreadable, without throwing', async (_name, make, message) => {
    expect(await unreadable(make())).toMatch(message);
  });

  it('refuses a central directory larger than any Harness Package needs, without reading it', async () => {
    const zip = buildZip([{ name: 'a', data: 'a' }]);
    const size = PACKAGE_LIMITS.maxCentralDirectoryBytes + 1;
    const view = new DataView(zip.buffer, zip.byteOffset);
    view.setUint32(zip.length - 22 + 12, size, true);
    const reader = sparseReader(zip, 0);
    const reads: number[] = [];
    const counting: RandomAccessReader = {
      size: reader.size,
      read: (offset, length) => {
        reads.push(length);
        return reader.read(offset, length);
      },
    };
    expect(await unreadable(counting)).toMatch(/central directory/);
    expect(Math.max(...reads)).toBeLessThan(70_000);
  });

  it('stops listing after maxListedEntries entries', async () => {
    const entries = Array.from({ length: PACKAGE_LIMITS.maxListedEntries + 5 }, (_, i) => ({
      name: `${String(i)}/`,
    }));
    const listing: PackageListing = (await open(entries, { zip64End: true })).listEntries();
    expect(listing.truncated).toBe(true);
    // The entries past the limit were never read, so their bytes are not unlisted data.
    expect(listing.unlistedData).toBeUndefined();
    expect(listing.entries).toHaveLength(PACKAGE_LIMITS.maxListedEntries);
  });

  it('rethrows what the reader throws: an I/O error is not a package problem', async () => {
    const failing: RandomAccessReader = {
      size: 100,
      read: () => Promise.reject(new Error('disk on fire')),
    };
    await expect(ArchiveSource.open(failing)).rejects.toThrow('disk on fire');
  });

  it('refuses a reader that returns fewer bytes than asked', async () => {
    const zip = buildZip([{ name: 'a', data: 'a' }]);
    const short: RandomAccessReader = {
      size: zip.length,
      read: (offset, length) => Promise.resolve(zip.subarray(offset, offset + length - 1)),
    };
    expect(await unreadable(short)).toMatch(/completely/);
  });
});

describe('InMemorySource', () => {
  it('lists every key as a file and reads it', async () => {
    const source = new InMemorySource({
      'a.txt': new TextEncoder().encode('abc'),
      '../x': new Uint8Array(1),
    });
    expect(source.listFiles()).toEqual(['a.txt']);
    expect(source.listEntries()).toEqual({
      entries: [
        { name: 'a.txt', kind: 'file', size: 3 },
        { name: '../x', kind: 'file', size: 1 },
      ],
      truncated: false,
    });
    expect(text(await source.readFile('a.txt', { maxBytes: 2 }))).toBe('ab');
    await expect(source.readFile('b.txt')).rejects.toThrow(/not a file/);
    await expect(source.readFile('a.txt', { maxBytes: Number.NaN })).rejects.toThrow(TypeError);
  });

  it('accepts a Map and refuses values that are not bytes', () => {
    expect(new InMemorySource(new Map([['a', new Uint8Array(1)]])).listFiles()).toEqual(['a']);
    expect(
      () => new InMemorySource({ a: 'text' } as unknown as Record<string, Uint8Array>),
    ).toThrow(TypeError);
  });

  it('returns a copy, so a rule cannot change the package', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const source = new InMemorySource({ a: bytes });
    (await source.readFile('a')).fill(0);
    expect(await source.readFile('a')).toEqual(bytes);
  });
});

describe('DirectorySource', () => {
  it('lists a folder in path order, with sizes, and reads files with a limit', async () => {
    const dir = join(scratch, 'plain');
    mkdirSync(join(dir, 'b/c'), { recursive: true });
    writeFileSync(join(dir, 'z.txt'), 'zzz');
    writeFileSync(join(dir, 'b/c/d.txt'), 'hello');
    const source = await DirectorySource.open(dir);
    expect(source.listEntries()).toEqual({
      entries: [
        { name: 'b', kind: 'directory', size: 0 },
        { name: 'b/c', kind: 'directory', size: 0 },
        { name: 'b/c/d.txt', kind: 'file', size: 5 },
        { name: 'z.txt', kind: 'file', size: 3 },
      ],
      truncated: false,
    });
    expect(source.listFiles()).toEqual(['b/c/d.txt', 'z.txt']);
    expect(text(await source.readFile('b/c/d.txt', { maxBytes: 4 }))).toBe('hell');
    expect(text(await source.readFile('b/c/d.txt'))).toBe('hello');
    await expect(source.readFile('../plain/z.txt')).rejects.toThrow(/not a file/);
    await expect(source.readFile('b')).rejects.toThrow(/not a file/);
  });

  it('lists links as links and never follows them', async ({ skip }) => {
    const dir = join(scratch, 'links');
    const outside = join(scratch, 'outside');
    mkdirSync(join(outside, 'deep'), { recursive: true });
    writeFileSync(join(outside, 'deep/secret.txt'), 'secret');
    mkdirSync(dir);
    try {
      symlinkSync(outside, join(dir, 'dir-link'), 'dir');
      symlinkSync(join(outside, 'deep/secret.txt'), join(dir, 'file-link'), 'file');
    } catch {
      skip(); // creating links needs a privilege on Windows
    }
    const source = await DirectorySource.open(dir);
    expect(source.listEntries().entries).toEqual([
      { name: 'dir-link', kind: 'symlink', size: 0 },
      { name: 'file-link', kind: 'symlink', size: 0 },
    ]);
    expect(source.listFiles()).toEqual([]);
  });

  const mkfifo = spawnSync('mkfifo', ['--version']).status === 0;

  it.skipIf(!mkfifo)(
    'lists a named pipe as a special entry, never read, as its zip lists it',
    async () => {
      const dir = join(scratch, 'fifo');
      mkdirSync(dir);
      writeFileSync(join(dir, 'a.txt'), 'a');
      expect(spawnSync('mkfifo', [join(dir, 'pipe')]).status).toBe(0);
      const source = await DirectorySource.open(dir);
      expect(source.listEntries().entries).toEqual([
        { name: 'a.txt', kind: 'file', size: 1 },
        { name: 'pipe', kind: 'special', size: 0 },
      ]);
      expect(source.listFiles()).toEqual(['a.txt']);
      await expect(source.readFile('pipe')).rejects.toThrow(/not a file/);
      const zip = await open([
        { name: 'a.txt', data: 'a' },
        { name: 'pipe', unixMode: 0o010644 },
      ]);
      expect(zip.listEntries().entries.map(({ name, kind }) => ({ name, kind }))).toEqual(
        source.listEntries().entries.map(({ name, kind }) => ({ name, kind })),
      );
    },
  );

  it('refuses to read a file that was replaced by a link after listing', async ({ skip }) => {
    if (process.platform === 'win32') skip();
    const dir = join(scratch, 'swap');
    mkdirSync(dir);
    writeFileSync(join(dir, 'icon.png'), 'png');
    writeFileSync(join(scratch, 'target.txt'), 'outside');
    const source = await DirectorySource.open(dir);
    rmSync(join(dir, 'icon.png'));
    symlinkSync(join(scratch, 'target.txt'), join(dir, 'icon.png'));
    await expect(source.readFile('icon.png')).rejects.toThrow();
  });

  it('refuses a path that is not a folder', async () => {
    writeFileSync(join(scratch, 'file.txt'), 'x');
    await expect(DirectorySource.open(join(scratch, 'file.txt'))).rejects.toThrow(/not a folder/);
    await expect(DirectorySource.open(join(scratch, 'missing'))).rejects.toThrow();
  });
});

describe('zip files on disk', () => {
  it('reads a zip file by position, without loading it whole', async () => {
    const path = join(scratch, 'fixture.zip');
    writeFileSync(path, zipFolder(fixtureDir('valid-minimal-node')));
    const source = await openArchiveFile(path);
    expect(source.listFiles()).toContain('manifest.json');
    expect(text(await source.readFile('manifest.json'))).toContain('"alice/hello-web"');
    await expect(fileReader(scratch)).rejects.toThrow(/not a file/);
  });

  it('reads a sparse zip file of over 500 MB without allocating it', async () => {
    const path = join(scratch, 'sparse.zip');
    const size = writeZipFile(path, [
      { name: 'big.bin', zeros: 600 * 1024 * 1024 },
      { name: 'a.txt', data: 'a' },
    ]);
    const source = await openArchiveFile(path);
    expect(source.listEntries().archiveSize).toBe(size);
    expect(source.listEntries().unlistedData).toBeUndefined();
    expect(text(await source.readFile('a.txt'))).toBe('a');
    expect(await source.readFile('big.bin', { maxBytes: 4 })).toEqual(new Uint8Array(4));
  });

  const zipTool = spawnSync('zip', ['-v'], { encoding: 'utf8' }).status === 0;

  it.skipIf(!zipTool)(
    'reads archives made by Info-ZIP zip, with its extra fields and links',
    async () => {
      const dir = join(scratch, 'info-zip');
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'dist/index.js'), 'console.log(1);\n'.repeat(100));
      writeFileSync(join(dir, 'README.md'), '# Hello\n');
      symlinkSync('/etc/passwd', join(dir, 'link'));
      const archive = join(scratch, 'info-zip.zip');
      const result = spawnSync('zip', ['-qry', archive, '.'], { cwd: dir });
      expect(result.status).toBe(0);
      const source = await openArchiveFile(archive);
      expect(source.listEntries().entries).toEqual(
        expect.arrayContaining([
          { name: 'dist/', kind: 'directory', size: 0 },
          { name: 'link', kind: 'symlink', size: 11 },
          { name: 'README.md', kind: 'file', size: 8 },
        ]),
      );
      expect(text(await source.readFile('dist/index.js'))).toBe('console.log(1);\n'.repeat(100));
      // The same folder listed directly agrees on files and links.
      const folder = await DirectorySource.open(dir);
      expect(folder.listFiles().sort()).toEqual(source.listFiles().sort());
    },
  );

  /** A small Harness-like folder for the tools below to archive. */
  const toolFolder = (name: string) => {
    const dir = join(scratch, name);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    mkdirSync(join(dir, 'empty'), { recursive: true });
    writeFileSync(join(dir, 'dist/index.js'), 'console.log(1);\n'.repeat(100));
    writeFileSync(join(dir, 'README.md'), '# Hello\n');
    writeFileSync(join(dir, 'stored.bin'), new Uint8Array(0));
    return dir;
  };

  /** Every file of the archive reads back, and nothing is inconsistent or unlisted. */
  const expectClean = async (archive: string) => {
    const source = await openArchiveFile(archive);
    const listing = source.listEntries();
    expect(listing.unreadable).toBeUndefined();
    expect(listing.unlistedData).toBeUndefined();
    for (const entry of listing.entries) {
      expect(entry).not.toHaveProperty('unsupported');
      expect(entry).not.toHaveProperty('localName');
    }
    expect(source.listFiles().sort()).toEqual(['README.md', 'dist/index.js', 'stored.bin']);
    expect(text(await source.readFile('dist/index.js'))).toBe('console.log(1);\n'.repeat(100));
  };

  it.skipIf(!zipTool)(
    'reads archives Info-ZIP zip writes to a pipe, with data descriptors, deflated or stored',
    async () => {
      const dir = toolFolder('info-zip-stream');
      for (const [file, flags] of [
        ['stream.zip', '-qr'],
        ['stream-stored.zip', '-qr0'],
      ] as const) {
        const archive = join(scratch, file);
        const result = spawnSync('sh', ['-c', `zip ${flags} - . | cat > "${archive}"`], {
          cwd: dir,
        });
        expect(result.status).toBe(0);
        await expectClean(archive);
      }
    },
  );

  const python = spawnSync('python3', ['--version']).status === 0;

  it.skipIf(!python)(
    "reads archives Python's zipfile writes to a stream, with data descriptors, deflated or stored",
    async () => {
      const dir = toolFolder('python-stream');
      const script = [
        'import io, os, sys, zipfile',
        'class Pipe(io.RawIOBase):',
        '    def __init__(self, f): self.f = f',
        '    def writable(self): return True',
        '    def write(self, b): return self.f.write(b)',
        'for path, method in ((sys.argv[1], zipfile.ZIP_DEFLATED), (sys.argv[2], zipfile.ZIP_STORED)):',
        "    with open(path, 'wb') as f, zipfile.ZipFile(Pipe(f), 'w', method) as z:",
        "        for root, dirs, files in os.walk('.'):",
        '            for name in sorted(dirs) + sorted(files):',
        '                full = os.path.join(root, name)',
        '                z.write(full, os.path.relpath(full))',
      ].join('\n');
      const archives = [join(scratch, 'python.zip'), join(scratch, 'python-stored.zip')];
      const result = spawnSync('python3', ['-c', script, ...archives], { cwd: dir });
      expect(result.stderr.toString()).toBe('');
      for (const archive of archives) await expectClean(archive);
    },
  );
});
