/**
 * validatePackage(): each rule on top of validateManifest(), on packages built in memory (and
 * as zips where only an archive can hold the case).
 */
import { describe, expect, it } from 'vitest';
import {
  ArchiveSource,
  InMemorySource,
  PACKAGE_LIMITS,
  PackageReadError,
  validateManifest,
  validatePackage,
} from '../src/index.js';
import type {
  PackageListing,
  PackageSource,
  Problem,
  ReadFileOptions,
  ValidationResult,
} from '../src/index.js';
import { binaryManifest, findings, minimalManifest, problemsOf } from './helpers.js';
import { jpeg, png } from './support/images.js';
import { buildZip, extraField, sparseReader } from './support/zip-writer.js';
import type { ZipEntrySpec } from './support/zip-writer.js';

type Files = Record<string, Uint8Array | string>;

const encode = (content: Uint8Array | string) =>
  typeof content === 'string' ? new TextEncoder().encode(content) : content;

/** A valid node Harness Package; `changes` add or replace files, `remove` drops some. */
function packageFiles(changes: Files = {}, remove: string[] = []): Map<string, Uint8Array> {
  const files: Files = {
    'manifest.json': JSON.stringify(minimalManifest(), null, 2),
    'README.md': '# Hello Web\n\nSays hello with your model.\n',
    'assets/icon.png': png(512, 512),
    'dist/index.js': "console.log('hello');\n",
    ...changes,
  };
  for (const path of remove) Reflect.deleteProperty(files, path);
  return new Map(Object.entries(files).map(([path, content]) => [path, encode(content)]));
}

const inMemory = (changes?: Files, remove?: string[]) =>
  new InMemorySource(packageFiles(changes, remove));

/** The same package as a zip, plus raw entries only an archive can hold. */
async function zipped(changes?: Files, extra: ZipEntrySpec[] = [], remove?: string[]) {
  const entries: ZipEntrySpec[] = [...packageFiles(changes, remove)].map(([name, data]) => ({
    name,
    data,
  }));
  return ArchiveSource.open(buildZip([...entries, ...extra]));
}

const manifestText = (changes: Record<string, unknown>, base = minimalManifest()) =>
  JSON.stringify({ ...base, ...changes });

async function check(source: PackageSource, options?: Parameters<typeof validatePackage>[1]) {
  const result = await validatePackage(source, options);
  return { result, problems: findings(problemsOf(result)), warnings: findings(result.warnings) };
}

function only(result: ValidationResult, code: string): Problem {
  const found = [...problemsOf(result), ...result.warnings].filter((p) => p.code === code);
  expect(found).toHaveLength(1);
  const [problem] = found;
  if (problem === undefined) throw new Error(`no ${code} finding`);
  return problem;
}

describe('a valid Harness Package', () => {
  it('is ok, with the same typed Manifest as validateManifest() and no warnings', async () => {
    const { result } = await check(inMemory());
    expect(result).toEqual(validateManifest(minimalManifest()));
    expect(result.ok).toBe(true);
  });

  it('is ok as a zip too', async () => {
    const { result } = await check(await zipped());
    expect(result).toEqual({ ok: true, manifest: minimalManifest(), warnings: [] });
  });

  it('passes options through: publisher_mismatch and version_not_greater', async () => {
    const { problems } = await check(inMemory(), {
      publisher: 'bob',
      publishedVersions: ['0.1.0'],
    });
    expect(problems).toEqual(['publisher_mismatch@id', 'version_not_greater@version']);
  });

  it('throws when given something other than a PackageSource', async () => {
    for (const input of [undefined, 'path/to/folder', new Uint8Array(4), { listFiles: () => [] }]) {
      await expect(validatePackage(input as unknown as PackageSource)).rejects.toThrow(TypeError);
    }
  });

  it('throws on malformed options, like validateManifest()', async () => {
    await expect(
      validatePackage(inMemory(), { publisher: 1 as unknown as string }),
    ).rejects.toThrow(TypeError);
  });
});

describe('manifest.json', () => {
  it('is required', async () => {
    const { result, problems } = await check(inMemory({}, ['manifest.json']));
    expect(problems).toEqual(['file_missing@manifest.json']);
    expect(only(result, 'file_missing')).toEqual({
      path: 'manifest.json',
      code: 'file_missing',
      message: 'The Harness Package must contain "manifest.json".',
      messageKey: 'file_missing',
      params: { file: 'manifest.json' },
    });
  });

  it('says so when the whole Harness folder was zipped instead of its contents', async () => {
    const nested = new InMemorySource(
      new Map([...packageFiles()].map(([path, bytes]) => [`hello-web/${path}`, bytes])),
    );
    const { result, problems } = await check(nested);
    expect(problems).toEqual([
      'file_missing@README.md',
      'file_missing@assets/icon.png',
      'file_missing@manifest.json',
    ]);
    const manifest = problemsOf(result).find((problem) => problem.path === 'manifest.json');
    expect(manifest).toMatchObject({
      messageKey: 'file_missing.manifest_nested',
      params: { found: 'hello-web/manifest.json' },
    });
  });

  it('gets every validateManifest() problem, with the Manifest paths', async () => {
    const { problems } = await check(
      inMemory({ 'manifest.json': manifestText({ name: 1, tags: ['fun', 'fun'] }) }),
    );
    expect(problems).toEqual(['schema_type@name', 'schema_unique_items@tags[1]']);
  });

  it('that is not JSON is reported once, and the file rules still run', async () => {
    const { problems } = await check(inMemory({ 'manifest.json': '{' }, ['assets/icon.png']));
    expect(problems).toEqual(['file_missing@assets/icon.png', 'schema_invalid_json@$']);
  });

  it(`is read up to ${String(PACKAGE_LIMITS.maxManifestBytes)} bytes; a larger one is not read`, async () => {
    const padded = (size: number) => {
      const text = JSON.stringify(minimalManifest());
      return `${text}${' '.repeat(size - text.length)}`;
    };
    const atLimit = await check(
      inMemory({ 'manifest.json': padded(PACKAGE_LIMITS.maxManifestBytes) }),
    );
    expect(atLimit.result.ok).toBe(true);

    const reads: (number | undefined)[] = [];
    const source = inMemory({ 'manifest.json': padded(PACKAGE_LIMITS.maxManifestBytes + 1) });
    const spy: PackageSource = {
      listFiles: () => source.listFiles(),
      listEntries: () => source.listEntries(),
      readFile: (path: string, options?: ReadFileOptions) => {
        if (path === 'manifest.json') reads.push(options?.maxBytes);
        return source.readFile(path, options);
      },
    };
    const { result, problems } = await check(spy);
    expect(problems).toEqual(['schema_invalid_json@$']);
    expect(only(result, 'schema_invalid_json').messageKey).toBe(
      'schema_invalid_json.file_too_large',
    );
    expect(reads).toEqual([PACKAGE_LIMITS.maxManifestBytes + 1]);
  });

  it('that cannot be read from the zip is archive_invalid, and the other rules still run', async () => {
    const source = await zipped({}, [], ['manifest.json']);
    const corrupt = await ArchiveSource.open(
      buildZip([
        { name: 'manifest.json', data: JSON.stringify(minimalManifest()), crc: 42 },
        { name: 'README.md', data: '# x' },
      ]),
    );
    expect(source.listFiles()).not.toContain('manifest.json');
    const { result, problems } = await check(corrupt);
    expect(problems).toEqual(['archive_invalid@manifest.json', 'file_missing@assets/icon.png']);
    expect(only(result, 'archive_invalid')).toMatchObject({
      messageKey: 'archive_invalid.entry',
      params: { detail: 'its content is corrupt (CRC-32 mismatch)' },
    });
  });
});

describe('README.md', () => {
  it('is required', async () => {
    expect((await check(inMemory({}, ['README.md']))).problems).toEqual(['file_missing@README.md']);
  });

  it(`gives a warning, not a problem, when over ${String(PACKAGE_LIMITS.maxReadmeBytes)} bytes`, async () => {
    const limit = PACKAGE_LIMITS.maxReadmeBytes;
    expect((await check(inMemory({ 'README.md': 'x'.repeat(limit) }))).result.warnings).toEqual([]);
    const { result } = await check(inMemory({ 'README.md': 'x'.repeat(limit + 1) }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      {
        path: 'README.md',
        code: 'file_too_large',
        message: `README.md is ${String(limit + 1)} bytes; keep it to at most 51200 bytes (50 KB).`,
        messageKey: 'file_too_large.readme',
        params: { actual: limit + 1, limit },
      },
    ]);
  });
});

describe('assets/icon.png', () => {
  it('is required', async () => {
    expect((await check(inMemory({}, ['assets/icon.png']))).problems).toEqual([
      'file_missing@assets/icon.png',
    ]);
  });

  it.each([
    [256, 256],
    [512, 256],
    [256, 512],
    [1024, 1024],
  ])('must be 512×512: %i×%i is icon_dimensions', async (width, height) => {
    const { result, problems } = await check(inMemory({ 'assets/icon.png': png(width, height) }));
    expect(problems).toEqual(['icon_dimensions@assets/icon.png']);
    expect(only(result, 'icon_dimensions')).toMatchObject({
      message: `The icon must be 512×512 pixels; found ${String(width)}×${String(height)}.`,
      params: { expected: 512, width, height },
    });
  });

  const corruptIhdr = () => {
    const bytes = png(512, 512).slice();
    bytes[20] = 0x01; // height, without fixing the chunk's CRC
    return bytes;
  };
  it.each<[string, () => Uint8Array | string]>([
    ['a JPEG', () => jpeg()],
    ['text', () => 'not an image'],
    ['empty', () => new Uint8Array(0)],
    ['a PNG signature alone', () => png(512, 512).subarray(0, 8)],
    ['a PNG cut inside its header', () => png(512, 512).subarray(0, 30)],
    ['a PNG whose header chunk is corrupt', corruptIhdr],
  ])('must be a PNG: %s is file_type', async (_name, content) => {
    const { result, problems } = await check(inMemory({ 'assets/icon.png': content() }));
    expect(problems).toEqual(['file_type@assets/icon.png']);
    expect(only(result, 'file_type').messageKey).toBe('file_type.icon');
  });

  it('is checked from its first 33 bytes only, never decoded', async () => {
    const source = inMemory({ 'assets/icon.png': png(512, 512) });
    const sizes: (number | undefined)[] = [];
    const spy: PackageSource = {
      listFiles: () => source.listFiles(),
      listEntries: () => source.listEntries(),
      readFile: (path: string, options?: ReadFileOptions) => {
        if (path === 'assets/icon.png') sizes.push(options?.maxBytes);
        return source.readFile(path, options);
      },
    };
    expect((await validatePackage(spy)).ok).toBe(true);
    expect(sizes).toEqual([33]);
  });
});

describe('screenshots in assets/', () => {
  const shots = (count: number, make: (i: number) => [string, Uint8Array]) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => make(i + 1)));

  it('may be PNG or JPEG, whatever the case of the extension', async () => {
    const { result } = await check(
      inMemory({
        'assets/a.png': png(64, 40),
        'assets/b.jpg': jpeg(),
        'assets/c.JPEG': jpeg(),
        'assets/d.PNG': png(64, 40),
      }),
    );
    expect(result).toMatchObject({ ok: true, warnings: [] });
  });

  it('give a warning when there are more than 5', async () => {
    const five = shots(5, (i) => [`assets/shot-${String(i)}.png`, png(64, 40)]);
    expect((await check(inMemory(five))).result.warnings).toEqual([]);
    const six = shots(6, (i) => [`assets/shot-${String(i)}.png`, png(64, 40)]);
    const { result, warnings } = await check(inMemory(six));
    expect(result.ok).toBe(true);
    expect(warnings).toEqual(['screenshots_too_many@assets']);
    expect(only(result, 'screenshots_too_many').params).toEqual({ actual: 6, limit: 5 });
  });

  it('give a warning when one is over 2 MB', async () => {
    const limit = PACKAGE_LIMITS.maxScreenshotBytes;
    const sized = (size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set(png(64, 40));
      return bytes;
    };
    expect((await check(inMemory({ 'assets/a.png': sized(limit) }))).warnings).toEqual([]);
    const { result, warnings } = await check(inMemory({ 'assets/a.png': sized(limit + 1) }));
    expect(result.ok).toBe(true);
    expect(warnings).toEqual(['file_too_large@assets/a.png']);
    expect(only(result, 'file_too_large')).toMatchObject({
      messageKey: 'file_too_large.screenshot',
      params: { actual: limit + 1, limit },
    });
  });

  it.each<[string, Uint8Array | string]>([
    ['assets/shot.gif', 'GIF89a'],
    ['assets/shot.webp', png(64, 40)],
    ['assets/notes.txt', 'text'],
    ['assets/shot.png', jpeg()],
    ['assets/shot.jpg', png(64, 40)],
    ['assets/shot.png', 'not a png'],
  ])('%s with that content is a file_type problem', async (path, content) => {
    const { result, problems } = await check(inMemory({ [path]: content }));
    expect(problems).toEqual([`file_type@${path}`]);
    expect(only(result, 'file_type').messageKey).toBe('file_type.screenshot');
  });

  it('are the files directly in assets/: hidden files and subfolders are not screenshots', async () => {
    const { result } = await check(
      inMemory({ 'assets/.DS_Store': 'finder', 'assets/fonts/inter.woff2': 'font' }),
    );
    expect(result).toMatchObject({ ok: true, warnings: [] });
  });
});

describe('Entry files', () => {
  it('node: the entry path must be a file in the package', async () => {
    const { result, problems } = await check(inMemory({}, ['dist/index.js']));
    expect(problems).toEqual(['entry_missing_for_platform@entry']);
    expect(only(result, 'entry_missing_for_platform')).toEqual({
      path: 'entry',
      code: 'entry_missing_for_platform',
      message:
        'The Entry file "dist/index.js" is not in the Harness Package, so the Runtime could not start the Harness.',
      messageKey: 'entry_missing_for_platform.file',
      params: { file: 'dist/index.js' },
    });
  });

  it('node: a folder of that name is not the file', async () => {
    const { problems } = await check(inMemory({ 'dist/index.js/main.js': 'x' }, ['dist/index.js']));
    expect(problems).toEqual(['entry_missing_for_platform@entry']);
  });

  it('node: the path is matched exactly, including its case', async () => {
    const { problems } = await check(inMemory({ 'dist/Index.js': 'x' }, ['dist/index.js']));
    expect(problems).toEqual(['entry_missing_for_platform@entry']);
  });

  it('node: a path with the wrong extension is still looked for, beside its pattern problem', async () => {
    const { problems } = await check(
      inMemory({ 'manifest.json': manifestText({ entry: 'main.py' }) }),
    );
    expect(problems).toEqual(['entry_missing_for_platform@entry', 'schema_pattern@entry']);
    const present = await check(
      inMemory({ 'manifest.json': manifestText({ entry: 'main.py' }), 'main.py': 'x' }),
    );
    expect(present.problems).toEqual(['schema_pattern@entry']);
  });

  it.each([
    ['a malformed path', { entry: '../dist/index.js' }, ['schema_pattern@entry']],
    ['an absolute path', { entry: '/dist/index.js' }, ['schema_pattern@entry']],
    ['a number', { entry: 42 }, ['schema_type@entry']],
    [
      'a per-platform object for a node Harness',
      { entry: { 'linux-x64': 'x.js' } },
      ['schema_type@entry'],
    ],
    [
      'an unknown runtime kind',
      { runtime: { kind: 'python' }, entry: 'main.py' },
      ['schema_enum@runtime.kind', 'schema_pattern@entry'],
    ],
  ])(
    'is not looked for when entry is %s: the schema problem says it all',
    async (_name, changes, expected) => {
      const { problems } = await check(
        inMemory({ 'manifest.json': manifestText(changes) }, ['dist/index.js']),
      );
      expect(problems).toEqual(expected);
    },
  );

  const binary = () => {
    const manifest = binaryManifest();
    return {
      'manifest.json': JSON.stringify(manifest),
      'bin/mac-arm64/reviewer': 'x',
      'bin/win-x64/reviewer.exe': 'x',
      'bin/linux-x64/reviewer': 'x',
    };
  };

  it('binary: a valid package with every executable is ok', async () => {
    expect((await check(inMemory(binary(), ['dist/index.js']))).result.ok).toBe(true);
  });

  it('binary: a missing executable is reported for its platform, by name', async () => {
    const files = binary();
    Reflect.deleteProperty(files, 'bin/win-x64/reviewer.exe');
    const { result, problems } = await check(inMemory(files, ['dist/index.js']));
    expect(problems).toEqual(['entry_missing_for_platform@entry.win32-x64']);
    expect(only(result, 'entry_missing_for_platform')).toMatchObject({
      messageKey: 'entry_missing_for_platform.platform_file',
      params: { platform: 'win32-x64', file: 'bin/win-x64/reviewer.exe' },
      message:
        'The Entry file "bin/win-x64/reviewer.exe" for platform "win32-x64" is not in the Harness Package, so the Runtime could not start the Harness there.',
    });
  });

  it('binary: every missing executable is reported, each once', async () => {
    const { problems } = await check(
      inMemory({ 'manifest.json': JSON.stringify(binaryManifest()) }, ['dist/index.js']),
    );
    expect(problems).toEqual([
      'entry_missing_for_platform@entry.darwin-arm64',
      'entry_missing_for_platform@entry.linux-x64',
      'entry_missing_for_platform@entry.win32-x64',
    ]);
  });

  it('binary: an entry for an undeclared platform is ignored, so its file is not looked for', async () => {
    const manifest = binaryManifest();
    manifest.entry = { ...(manifest.entry as object), 'linux-arm64': 'bin/linux-arm64/reviewer' };
    const { result, problems, warnings } = await check(
      inMemory({ ...binary(), 'manifest.json': JSON.stringify(manifest) }, ['dist/index.js']),
    );
    expect(problems).toEqual([]);
    expect(warnings).toEqual(['ignored_key@entry.linux-arm64']);
    expect(result.ok).toBe(true);
  });

  it('binary: a platform without any entry is reported once, by the Manifest rule', async () => {
    const manifest = binaryManifest();
    manifest.entry = {
      'darwin-arm64': 'bin/mac-arm64/reviewer',
      'linux-x64': 'bin/linux-x64/reviewer',
    };
    const { problems } = await check(
      inMemory({ ...binary(), 'manifest.json': JSON.stringify(manifest) }, ['dist/index.js']),
    );
    expect(problems).toEqual(['entry_missing_for_platform@entry.win32-x64']);
  });

  it('an Entry that is a link is reported as a link, not also as missing', async () => {
    const source = await zipped(
      {},
      [{ name: 'dist/index.js', data: '/usr/bin/node', unixMode: 0o120777 }],
      ['dist/index.js'],
    );
    expect((await check(source)).problems).toEqual(['archive_symlink@dist/index.js']);
  });
});

describe('archive safety', () => {
  it('rejects links, and keeps checking everything else', async () => {
    const source = await zipped({ 'manifest.json': manifestText({ name: 1 }) }, [
      { name: 'assets/logo.png', data: '/etc/passwd', unixMode: 0o120777, method: 0 },
    ]);
    const { result, problems } = await check(source);
    expect(problems).toEqual(['archive_symlink@assets/logo.png', 'schema_type@name']);
    expect(only(result, 'archive_symlink')).toEqual({
      path: 'assets/logo.png',
      code: 'archive_symlink',
      message: 'The entry is a symbolic link. A Harness Package may not contain links.',
      messageKey: 'archive_symlink',
    });
  });

  it('a required file that is a link is reported as a link only', async () => {
    const source = await zipped(
      {},
      [{ name: 'README.md', data: 'x', unixMode: 0o120777 }],
      ['README.md'],
    );
    expect((await check(source)).problems).toEqual(['archive_symlink@README.md']);
  });

  it.each([
    ['../escape.txt', 'archive_path_traversal'],
    ['dist/../../escape.txt', 'archive_path_traversal'],
    ['dist/..', 'archive_path_traversal'],
    ['..\\escape.txt', 'archive_path_traversal'],
    ['dist\\..\\..\\escape.txt', 'archive_path_traversal'],
    ['.. /escape.txt', 'archive_path_traversal'],
    ['.../escape.txt', 'archive_path_traversal'],
    ['/etc/cron.d/job', 'archive_path_traversal.absolute'],
    ['\\Windows\\evil.dll', 'archive_path_traversal.absolute'],
    ['C:\\Windows\\evil.dll', 'archive_path_traversal.absolute'],
    ['c:/evil.dll', 'archive_path_traversal.absolute'],
    ['C:evil.dll', 'archive_path_traversal.absolute'],
  ])('rejects the entry %s', async (name, messageKey) => {
    const { result, problems } = await check(await zipped({}, [{ name, data: 'x' }]));
    expect(problems).toEqual([`archive_path_traversal@${name}`]);
    expect(only(result, 'archive_path_traversal').messageKey).toBe(messageKey);
  });

  it.each(['..hidden/x.txt', 'a..b/x.txt', 'dist/x..js', '...config', 'dist/./x.js'])(
    'accepts the entry %s, which stays inside the package',
    async (name) => {
      expect((await check(await zipped({}, [{ name, data: 'x' }]))).problems).toEqual([]);
    },
  );

  it('checks the in-memory keys the same way', async () => {
    const { problems } = await check(inMemory({ '../escape.txt': 'x', '/abs': 'x' }));
    expect(problems).toEqual([
      'archive_path_traversal@../escape.txt',
      'archive_path_traversal@/abs',
    ]);
  });

  it('checks the other name of an entry (Info-ZIP Unicode Path field) too', async () => {
    const field = Buffer.alloc(5);
    field.writeUInt8(1, 0); // version 1, CRC 0: does not match, so the plain name is used
    const extra = extraField(0x7075, Buffer.concat([field, Buffer.from('../../evil.txt')]));
    const { result, problems } = await check(
      await zipped({}, [{ name: 'innocent.txt', data: 'x', extra }]),
    );
    expect(problems).toEqual(['archive_path_traversal@innocent.txt']);
    expect(only(result, 'archive_path_traversal')).toMatchObject({
      messageKey: 'archive_path_traversal.other_name',
      params: { name: '"../../evil.txt"' },
    });
  });

  it('rejects a path stored twice, once', async () => {
    const source = await zipped({}, [
      { name: 'dist/index.js', data: 'second copy' },
      { name: './dist/index.js', data: 'third copy' },
    ]);
    const { result, problems } = await check(source);
    expect(problems).toEqual(['archive_invalid@dist/index.js']);
    expect(only(result, 'archive_invalid').messageKey).toBe('archive_invalid.duplicate');
  });

  it('rejects encrypted entries and unsupported compression methods', async () => {
    const source = await zipped({}, [
      { name: 'secret.bin', data: 'x', flags: 0x0001 },
      { name: 'data.bz2', data: 'x', method: 12 },
    ]);
    const { result, problems } = await check(source);
    expect(problems).toEqual(['archive_invalid@data.bz2', 'archive_invalid@secret.bin']);
    expect(problemsOf(result).map((problem) => [problem.messageKey, problem.params])).toEqual([
      ['archive_invalid.encrypted', undefined],
      ['archive_invalid.compression_method', { method: 12 }],
    ]);
  });

  it('reports an encrypted manifest.json once', async () => {
    const source = await zipped(
      {},
      [{ name: 'manifest.json', data: '{}', flags: 0x0001 }],
      ['manifest.json'],
    );
    const { result, problems } = await check(source);
    expect(problems).toEqual(['archive_invalid@manifest.json']);
    expect(only(result, 'archive_invalid').messageKey).toBe('archive_invalid.encrypted');
  });

  it('cuts a hostile entry name to 1 024 characters in the problem path', async () => {
    const name = `../${'x'.repeat(5000)}`;
    const [problem] = problemsOf((await check(await zipped({}, [{ name, data: 'x' }]))).result);
    expect(problem?.path).toBe(`../${'x'.repeat(1021)}…`);
  });
});

describe('archive limits', () => {
  const filler = (count: number, directories = 0): ZipEntrySpec[] => [
    ...Array.from({ length: directories }, (_, i) => ({ name: `d${String(i)}/` })),
    ...Array.from({ length: count }, (_, i) => ({ name: `filler/${String(i)}` })),
  ];
  const baseFiles = packageFiles().size;

  it(`accepts ${String(PACKAGE_LIMITS.maxFiles)} files, with any number of directory entries`, async () => {
    const source = await zipped({}, filler(PACKAGE_LIMITS.maxFiles - baseFiles, 3000));
    expect((await check(source)).result.ok).toBe(true);
  });

  it(`rejects ${String(PACKAGE_LIMITS.maxFiles + 1)} files`, async () => {
    const source = await zipped({}, filler(PACKAGE_LIMITS.maxFiles + 1 - baseFiles));
    const { result, problems } = await check(source);
    expect(problems).toEqual(['archive_too_many_files@$']);
    expect(only(result, 'archive_too_many_files')).toMatchObject({
      params: { actual: PACKAGE_LIMITS.maxFiles + 1, limit: PACKAGE_LIMITS.maxFiles },
    });
  });

  it('counts links as files, as a folder does', async () => {
    const links = Array.from({ length: PACKAGE_LIMITS.maxFiles + 1 - baseFiles }, (_, i) => ({
      name: `l${String(i)}`,
      data: 'x',
      unixMode: 0o120777,
    }));
    const { problems } = await check(await zipped({}, links));
    expect(problems).toContain('archive_too_many_files@$');
  });

  it('stops at 100 000 entries: too many files, and nothing else is checked', async () => {
    const entries = Array.from({ length: PACKAGE_LIMITS.maxListedEntries + 1 }, (_, i) => ({
      name: `e${String(i)}/`,
    }));
    // The manifest and the icon would come after the listing limit.
    const source = await ArchiveSource.open(buildZip(entries, { zip64End: true }));
    const { result, problems } = await check(source);
    expect(problems).toEqual(['archive_too_many_files@$']);
    expect(only(result, 'archive_too_many_files')).toMatchObject({
      messageKey: 'archive_too_many_files.not_counted',
      params: { counted: PACKAGE_LIMITS.maxListedEntries, limit: PACKAGE_LIMITS.maxFiles },
    });
  });

  it('rejects an archive over 500 MB, compressed', async () => {
    const zip = (offset: number) =>
      buildZip(
        [...packageFiles()].map(([name, data]) => ({ name, data })),
        { offset },
      );
    const limit = PACKAGE_LIMITS.maxArchiveBytes;
    const exact = zip(0).length;
    const atLimit = await ArchiveSource.open(sparseReader(zip(limit - exact), limit - exact));
    expect((await check(atLimit)).result.ok).toBe(true);
    const over = await ArchiveSource.open(sparseReader(zip(limit - exact + 1), limit - exact + 1));
    const { result, problems } = await check(over);
    expect(problems).toEqual(['archive_too_large@$']);
    expect(only(result, 'archive_too_large')).toMatchObject({
      message: `The Harness Package is ${String(limit + 1)} bytes; the limit is ${String(limit)} bytes (500 MB), compressed.`,
      params: { actual: limit + 1, limit },
    });
  });

  it('reports an archive that is not a zip as a single archive_invalid problem', async () => {
    const source = await ArchiveSource.open(new TextEncoder().encode('{"manifestVersion": 1}'));
    expect(await validatePackage(source)).toEqual({
      ok: false,
      problems: [
        {
          path: '$',
          code: 'archive_invalid',
          message:
            'The Harness Package is not a readable zip archive: it has no end of central directory record, so it is not a zip.',
          messageKey: 'archive_invalid',
          params: {
            detail: 'it has no end of central directory record, so it is not a zip',
          },
        },
      ],
      warnings: [],
    });
  });
});

describe('independence of the rules', () => {
  it('reports archive, Manifest and file problems together, in one pass', async () => {
    const source = await zipped(
      {
        'manifest.json': manifestText({ models: { slots: { fast: {} } } }),
        'assets/icon.png': png(10, 10),
      },
      [{ name: '../x', data: 'x' }],
      ['README.md', 'dist/index.js'],
    );
    const { problems } = await check(source);
    expect(problems).toEqual([
      'archive_path_traversal@../x',
      'entry_missing_for_platform@entry',
      'file_missing@README.md',
      'icon_dimensions@assets/icon.png',
      'slot_default_missing@models.slots.default',
    ]);
  });

  it('returns warnings from both the Manifest and the files', async () => {
    const { warnings } = await check(
      inMemory({
        'manifest.json': manifestText({ ui: { kind: 'terminal', path: '/' } }),
        'README.md': 'x'.repeat(PACKAGE_LIMITS.maxReadmeBytes + 1),
      }),
    );
    expect(warnings).toEqual(['file_too_large@README.md', 'ignored_key@ui.path']);
  });
});

describe('errors that are not about the package', () => {
  it('rethrows an I/O error from the source', async () => {
    const source = inMemory();
    const failing: PackageSource = {
      listFiles: () => source.listFiles(),
      listEntries: (): PackageListing => source.listEntries(),
      readFile: () => Promise.reject(new Error('EACCES')),
    };
    await expect(validatePackage(failing)).rejects.toThrow('EACCES');
  });

  it('turns a PackageReadError from any source into archive_invalid', async () => {
    const source = inMemory();
    const failing: PackageSource = {
      listFiles: () => source.listFiles(),
      listEntries: () => source.listEntries(),
      readFile: () => Promise.reject(new PackageReadError('it is damaged')),
    };
    const { problems } = await check(failing);
    expect(problems).toEqual(['archive_invalid@assets/icon.png', 'archive_invalid@manifest.json']);
  });
});
