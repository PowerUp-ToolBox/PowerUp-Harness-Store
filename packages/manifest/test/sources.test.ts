/**
 * The three package sources and the zip reader behind ArchiveSource: listing, names, links,
 * reading with limits, and every way a zip can be malformed or hostile.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
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
import { buildZip, extraField, sparseReader } from './support/zip-writer.js';
import type { ZipEntrySpec } from './support/zip-writer.js';

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

  it('stops inflating a zip bomb at the bytes asked for', async () => {
    // 64 MB of zeros deflate to 64 KB; the first 1 KB slice alone inflates to about 1 MB.
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
    const opened = reader.reads;
    const started = performance.now();
    expect(await source.readFile('assets/icon.png', { maxBytes: 33 })).toEqual(new Uint8Array(33));
    expect(performance.now() - started).toBeLessThan(500);
    expect(reader.reads - opened).toBe(3); // local header, local name, one 1 KB slice
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
    expect(reader.reads - opened).toBe(3);
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
    await expect(source.readFile('f')).rejects.toThrow(/past the end/);
  });
});

describe('ArchiveSource: the end of central directory record and ZIP64', () => {
  it('reads an archive with a comment, even one that contains the record signature', async () => {
    const signature = String.fromCharCode(0x50, 0x4b, 0x05, 0x06);
    for (const comment of ['hello', `${signature}${'x'.repeat(30)}`, signature]) {
      const source = await open([{ name: 'a.txt', data: 'a' }], { comment });
      expect(source.listEntries().unreadable).toBeUndefined();
      expect(source.listFiles()).toEqual(['a.txt']);
    }
  });

  it('reads an archive followed by trailing bytes', async () => {
    const zip = buildZip([{ name: 'a.txt', data: 'a' }]);
    const padded = Buffer.concat([zip, Buffer.from('trailing')]);
    expect((await ArchiveSource.open(padded)).listFiles()).toEqual(['a.txt']);
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
    const zip = buildZip([{ name: 'a.txt', data: 'a' }], { offset: 600 * 1024 * 1024 });
    writeFileSync(path, new Uint8Array(0));
    truncateSync(path, 600 * 1024 * 1024);
    const { appendFileSync } = await import('node:fs');
    appendFileSync(path, zip);
    const source = await openArchiveFile(path);
    expect(source.listEntries().archiveSize).toBe(600 * 1024 * 1024 + zip.length);
    expect(text(await source.readFile('a.txt'))).toBe('a');
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
});
