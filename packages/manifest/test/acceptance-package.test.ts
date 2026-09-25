/**
 * The acceptance criteria of ticket P0-01.3 (#32), one test each, in the ticket's order, then
 * its "How to verify" steps 1 and 2 (step 3 is test/reconsent.test.ts).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchiveSource,
  diffForReconsent,
  InMemorySource,
  validateManifest,
  validatePackage,
} from '../src/index.js';
import type { Manifest } from '../src/index.js';
import { DirectorySource, openArchiveFile } from '../src/node/index.js';
import {
  findings,
  fixtureNames,
  loadFixture,
  minimalManifest,
  packageRoot,
  problemsOf,
} from './helpers.js';
import { png } from './support/images.js';
import {
  fixtureDir,
  folderEntries,
  hostileArchive,
  readTree,
  zipFolder,
} from './support/packages.js';
import { buildZip } from './support/zip-writer.js';

const codesAndPaths = async (source: Parameters<typeof validatePackage>[0], options?: object) => {
  const result = await validatePackage(source, options);
  return { problems: findings(problemsOf(result)), warnings: findings(result.warnings) };
};

/** Every file and folder under `dir`, as relative paths with their sizes. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const visit = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stats = statSync(path);
      out.push(`${relative(dir, path)}:${stats.isDirectory() ? 'dir' : String(stats.size)}`);
      if (stats.isDirectory()) visit(path);
    }
  };
  visit(dir);
  return out.sort();
}

let scratch = '';
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'manifest-acceptance-'));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('P0-01.3 acceptance criteria', () => {
  it('1. a fixture directory and the same fixture zipped return the identical codes and paths', async () => {
    for (const name of [
      'valid-minimal-node',
      'multiple-problems',
      'file_type',
      'entry-file-missing-binary',
    ]) {
      const { options } = loadFixture(name).expected;
      const folder = await codesAndPaths(await DirectorySource.open(fixtureDir(name)), options);
      const zipPath = join(scratch, `${name}.zip`);
      writeFileSync(zipPath, zipFolder(fixtureDir(name)));
      expect(await codesAndPaths(await openArchiveFile(zipPath), options)).toEqual(folder);
      expect(await codesAndPaths(await ArchiveSource.open(readFileSync(zipPath)), options)).toEqual(
        folder,
      );
    }
  });

  it('2. a zip with a ../ entry is rejected with archive_path_traversal and nothing is written to disk', async () => {
    const work = join(scratch, 'uploads', 'incoming');
    mkdirSync(work, { recursive: true });
    const zipPath = join(work, 'upload.zip');
    const escapes = [
      '../escape.txt',
      '../../escape.txt',
      'dist/../../../escape.txt',
      `/${relative('/', join(scratch, 'absolute.txt'))}`,
    ];
    writeFileSync(
      zipPath,
      buildZip([
        ...folderEntries(fixtureDir('valid-minimal-node')),
        ...escapes.map((name) => ({ name, data: 'pwned' })),
      ]),
    );
    const before = snapshot(scratch);

    const result = await validatePackage(await openArchiveFile(zipPath));

    expect(findings(problemsOf(result))).toEqual(
      findings(escapes.map((path) => ({ code: 'archive_path_traversal', path }))),
    );
    expect(snapshot(scratch)).toEqual(before);
    for (const dir of [work, dirname(work), scratch, process.cwd(), packageRoot]) {
      expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
    }
    expect(existsSync(join(scratch, 'absolute.txt'))).toBe(false);
  });

  it('3. a zip with a symlink entry is rejected with archive_symlink', async () => {
    const source = await ArchiveSource.open(hostileArchive('archive_symlink'));
    expect(await codesAndPaths(source)).toEqual({
      problems: ['archive_symlink@dist/config.json'],
      warnings: [],
    });
  });

  it('4. no assets/icon.png is file_missing at that path; a 256×256 icon is icon_dimensions', async () => {
    expect(await codesAndPaths(await DirectorySource.open(fixtureDir('file_missing')))).toEqual({
      problems: ['file_missing@assets/icon.png'],
      warnings: [],
    });
    const icon256 = new Map(readTree(fixtureDir('valid-minimal-node')).files);
    icon256.set('assets/icon.png', png(256, 256));
    expect(await codesAndPaths(new InMemorySource(icon256))).toEqual({
      problems: ['icon_dimensions@assets/icon.png'],
      warnings: [],
    });
  });

  it('5. a missing node Entry file, and a missing binary executable naming its platform', async () => {
    const node = await validatePackage(
      await DirectorySource.open(fixtureDir('entry-file-missing-node')),
    );
    expect(problemsOf(node)).toEqual([
      expect.objectContaining({
        code: 'entry_missing_for_platform',
        path: 'entry',
        params: { file: 'dist/index.js' },
      }),
    ]);
    const binary = await validatePackage(
      await DirectorySource.open(fixtureDir('entry-file-missing-binary')),
    );
    expect(problemsOf(binary)).toEqual([
      expect.objectContaining({
        code: 'entry_missing_for_platform',
        path: 'entry.win32-x64',
        params: { platform: 'win32-x64', file: 'bin/win-x64/reviewer.exe' },
      }),
    ]);
    // The same class of problem as a platform with no entry at all (P0-01.2).
    const noEntry = validateManifest(loadFixture('entry_missing_for_platform').manifestText);
    expect(problemsOf(noEntry).map((problem) => problem.code)).toEqual([
      'entry_missing_for_platform',
    ]);
  });

  const permissions = (scope: 'workspace' | 'home'): Manifest => {
    const manifest = minimalManifest();
    manifest.permissions = { filesystem: { scope }, shell: false, network: { domains: [] } };
    return manifest as unknown as Manifest;
  };

  it('6. filesystem.scope workspace to home requires re-consent; home to workspace does not', () => {
    expect(diffForReconsent(permissions('workspace'), permissions('home'))).toMatchObject({
      required: true,
      reasons: ['permissions_widened'],
    });
    expect(diffForReconsent(permissions('home'), permissions('workspace'))).toMatchObject({
      required: false,
      reasons: [],
    });
  });

  it('7. only the entry changes: required, with only entry_changed', () => {
    const previous = minimalManifest() as unknown as Manifest;
    const next = { ...minimalManifest(), entry: 'dist/cli.js' } as unknown as Manifest;
    expect(diffForReconsent(previous, next)).toMatchObject({
      required: true,
      reasons: ['entry_changed'],
    });
  });

  it.each(fixtureNames())(
    '8. fixtures/%s zipped validates identically to its directory form',
    async (name) => {
      const { options } = loadFixture(name).expected;
      const folder = await validatePackage(await DirectorySource.open(fixtureDir(name)), options);
      const zip = await validatePackage(
        await ArchiveSource.open(zipFolder(fixtureDir(name))),
        options,
      );
      expect(zip).toEqual(folder);
    },
  );
});

describe('P0-01.3 How to verify', () => {
  it.each([
    ['archive_path_traversal', 'archive_path_traversal'],
    ['archive_symlink', 'archive_symlink'],
    ['archive_too_large', 'archive_too_large'],
    ['archive_too_many_files', 'archive_too_many_files'],
  ])('1. the %s archive fixture produces exactly %s', async (name, code) => {
    const { problems } = await codesAndPaths(await ArchiveSource.open(hostileArchive(name)));
    expect(new Set(problems.map((finding) => finding.split('@')[0]))).toEqual(new Set([code]));
  });

  it.each([
    ['icon_dimensions', 'icon_dimensions'],
    ['file_type', 'file_type'],
    ['entry-file-missing-node', 'entry_missing_for_platform'],
    ['entry-file-missing-binary', 'entry_missing_for_platform'],
  ])('1. the %s fixture produces exactly %s', async (name, code) => {
    const { problems } = await codesAndPaths(await DirectorySource.open(fixtureDir(name)));
    expect(new Set(problems.map((finding) => finding.split('@')[0]))).toEqual(new Set([code]));
  });

  it('2. the validator itself never writes: only src/node/ touches the file system, read-only', () => {
    const sources = readdirSync(join(packageRoot, 'src'), { recursive: true })
      .map((file) => String(file).split(sep).join('/'))
      .filter((file) => file.endsWith('.ts'));
    expect(sources).toContain('node/directory-source.ts');
    const importsOf = (code: string, module: RegExp) =>
      [...code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)]
        .filter(([, , from]) => module.test(from ?? ''))
        .flatMap(([, names]) => (names ?? '').split(',').map((name) => name.trim()))
        .filter((name) => name !== '');
    for (const file of sources) {
      const code = readFileSync(join(packageRoot, 'src', file), 'utf8');
      if (!file.startsWith('node/')) {
        // The pure entry point cannot reach a file system at all.
        expect(code, file).not.toMatch(/from ['"](node:)?(fs|fs\/promises|os|child_process)['"]/);
        continue;
      }
      expect(code, file).not.toMatch(/import\s+\*|require\(/);
      const fsImports = importsOf(code, /^(node:)?fs(\/promises)?$/);
      for (const name of fsImports) {
        expect(
          ['open', 'stat', 'lstat', 'readdir', 'constants'],
          `${file} imports ${name}`,
        ).toContain(name);
      }
      // Every file opened is opened for reading only.
      const opens = [...code.matchAll(/\bawait open\(([^;]*?)\);/gs)].map(([, args]) => args ?? '');
      if (fsImports.includes('open')) expect(opens.length, file).toBeGreaterThan(0);
      for (const args of opens) expect(args, file).toMatch(/'r'$|O_RDONLY/);
    }
  });
});
