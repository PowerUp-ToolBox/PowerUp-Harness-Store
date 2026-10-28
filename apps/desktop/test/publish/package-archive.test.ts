/**
 * Ticket P0-08.1: the Harness Package the Publish flow builds from a folder, and validates before
 * anything is uploaded. It is deterministic, leaves out what the exclusion rules say (and lists
 * it), never follows a link, and is what `validatePackage` then checks through `ArchiveSource`.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveSource, validatePackage } from '@harness-store/manifest';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPackage } from '../../src/main/runtime/package-archive.js';

const FIXTURE = join(import.meta.dirname, '../fixtures/harnesses/fixture-web');

let root: string;
let folder: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-package-'));
  folder = join(root, 'my-harness');
  cpSync(FIXTURE, folder, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string | Uint8Array = 'x') {
  mkdirSync(join(folder, path, '..'), { recursive: true });
  writeFileSync(join(folder, path), content);
}

/** The central directory records of a zip: name, method, DOS time and date, Unix mode. */
function centralDirectory(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const records = [];
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(at + 28, true);
    records.push({
      name: new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength)),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      mode: view.getUint32(at + 38, true) >>> 16,
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return records;
}

describe('buildPackage', () => {
  it('builds the same bytes from the same folder, whatever the files’ times', async () => {
    const first = await buildPackage(folder);
    utimesSync(join(folder, 'manifest.json'), new Date('2030-01-01'), new Date('2030-01-01'));
    const second = await buildPackage(folder);
    expect(first.bytes).not.toBeNull();
    expect(second.bytes).toEqual(first.bytes);
    expect(first.size).toBe(first.bytes?.length);
  });

  it('holds the files only, sorted by path, every one dated 1980-01-01 and deflated', async () => {
    write('b/z.txt');
    write('b/a.txt');
    write('a.txt');
    const { bytes } = await buildPackage(folder);
    const records = centralDirectory(bytes ?? new Uint8Array());
    const names = records.map((record) => record.name);
    expect(names).toEqual([...names].sort());
    expect(names).toEqual([
      'README.md',
      'a.txt',
      'assets/icon.png',
      'b/a.txt',
      'b/z.txt',
      'index.mjs',
      'manifest.json',
    ]);
    for (const record of records) {
      expect(record).toMatchObject({ method: 8, time: 0, date: (1 << 5) | 1, flags: 0 });
      expect(record.mode & 0o170000).toBe(0o100000);
    }
    // Any zip reader takes it, and gets the files back as they are.
    const files = unzipSync(bytes ?? new Uint8Array());
    expect(new TextDecoder().decode(files['b/z.txt'])).toBe('x');
  });

  it('is a valid Harness Package for validatePackage, read with ArchiveSource', async () => {
    const { bytes } = await buildPackage(folder);
    const result = await validatePackage(await ArchiveSource.open(bytes ?? new Uint8Array()));
    expect(result).toMatchObject({ ok: true, warnings: [] });
  });

  it('leaves out the fixed exclusions and lists only the topmost of each', async () => {
    write('.git/HEAD', 'ref: refs/heads/main');
    write('.git/objects/ab/cdef');
    write('node_modules/.cache/tool/data.json');
    write('node_modules/left-pad/index.js');
    write('.DS_Store');
    write('assets/Thumbs.db');
    write('.index.mjs.swp');
    const built = await buildPackage(folder);
    const names = centralDirectory(built.bytes ?? new Uint8Array()).map((record) => record.name);
    expect(names).toContain('node_modules/left-pad/index.js');
    expect(names.filter((name) => /\.git\/|\.cache|DS_Store|Thumbs|\.swp/.test(name))).toEqual([]);
    expect(built.excluded).toEqual([
      '.DS_Store',
      '.git/',
      '.index.mjs.swp',
      'assets/Thumbs.db',
      'node_modules/.cache/',
    ]);
  });

  it('applies .harnessignore, which is left out itself and listed', async () => {
    write('.harnessignore', 'dist/\n*.log\n!.DS_Store\n');
    write('dist/bundle.js');
    write('logs/debug.log');
    write('.DS_Store');
    const built = await buildPackage(folder);
    const names = centralDirectory(built.bytes ?? new Uint8Array()).map((record) => record.name);
    expect(names).not.toContain('dist/bundle.js');
    expect(names).not.toContain('logs/debug.log');
    expect(names).not.toContain('.harnessignore');
    expect(built.excluded).toEqual(['.DS_Store', '.harnessignore', 'dist/', 'logs/debug.log']);
  });

  it.skipIf(process.platform === 'win32')(
    'puts a symbolic link in as an empty entry with its mode, which validatePackage refuses at its path',
    async () => {
      write('notes.txt', 'secret');
      symlinkSync(join(folder, 'notes.txt'), join(folder, 'link.txt'));
      symlinkSync('/etc', join(folder, '.git'));
      const built = await buildPackage(folder);
      const records = centralDirectory(built.bytes ?? new Uint8Array());
      const link = records.find((record) => record.name === 'link.txt');
      expect(link).toMatchObject({ method: 0 });
      expect((link?.mode ?? 0) & 0o170000).toBe(0o120000);
      // A link the rules leave out is not in the zip at all.
      expect(records.map((record) => record.name)).not.toContain('.git');
      const result = await validatePackage(
        await ArchiveSource.open(built.bytes ?? new Uint8Array()),
      );
      expect(
        result.ok ? [] : result.problems.map((problem) => [problem.path, problem.code]),
      ).toEqual([['link.txt', 'archive_symlink']]);
    },
  );

  it('stops with one archive_too_large problem once the zip passes the limit', async () => {
    write('big.bin', crypto.getRandomValues(new Uint8Array(60_000)));
    const built = await buildPackage(folder, { maxBytes: 20_000 });
    expect(built.bytes).toBeNull();
    expect(built.problem).toMatchObject({
      path: '$',
      code: 'archive_too_large',
      messageKey: 'archive_too_large',
      params: { limit: 500 * 1024 * 1024 },
    });
    expect(built.problem?.message).toMatch(
      /^The Harness Package is \d+ bytes; the limit is 524288000 bytes/,
    );
  });

  it('stops listing a folder with too many files, as validatePackage stops listing a zip', async () => {
    rmSync(folder, { recursive: true });
    for (let index = 0; index < 10; index++) {
      for (let file = 0; file < 5; file++) write(`d${String(index)}/f${String(file)}.txt`);
    }
    let directoriesEntered = 0;
    const built = await buildPackage(folder, {
      maxListed: 3,
      isCurrent: () => {
        directoriesEntered += 1;
        return true;
      },
    });
    expect(built.bytes).toBeNull();
    expect(built.problem).toMatchObject({
      path: '$',
      code: 'archive_too_many_files',
      messageKey: 'archive_too_many_files.not_counted',
      params: { counted: 3, limit: 20_000 },
    });
    expect(built.problem?.message).toBe(
      'The Harness Package has more than 3 entries, far more than the limit of 20000 files, so it was not checked further.',
    );
    // The root and the first folder, whose fourth file stopped the walk: no other folder.
    expect(directoriesEntered).toBe(2);
  });
});
