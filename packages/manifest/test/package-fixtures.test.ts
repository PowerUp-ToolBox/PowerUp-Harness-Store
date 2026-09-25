/**
 * Every fixture folder is a whole Harness Package: validatePackage() finds exactly what its
 * expected.json lists, whether the package is the folder, a zip of it or files in memory, and a
 * fixture with an archive recipe also gives its hostile archive's findings.
 */
import { describe, expect, it } from 'vitest';
import { ArchiveSource, validatePackage } from '../src/index.js';
import type { PackageSource } from '../src/index.js';
import { readPngDimensions } from '../src/images.js';
import { findings, fixtureNames, loadFixture, problemsOf } from './helpers.js';
import { png } from './support/images.js';
import { fixtureDir, fixtureSources, hostileArchive, readTree } from './support/packages.js';

const names = fixtureNames();

describe.each(names)('validatePackage(fixtures/%s)', (name) => {
  const { expected } = loadFixture(name);

  it('finds exactly the problems and warnings in expected.json, as a folder, a zip and in memory', async () => {
    for (const [kind, source] of await fixtureSources(name)) {
      const result = await validatePackage(source, expected.options);
      expect({ kind, problems: findings(problemsOf(result)) }).toEqual({
        kind,
        problems: findings(expected.problems),
      });
      expect({ kind, warnings: findings(result.warnings) }).toEqual({
        kind,
        warnings: findings(expected.warnings),
      });
      expect(result.ok).toBe(expected.problems.length === 0);
    }
  });

  it('gives the folder and its zip the very same result, messages and all', async () => {
    const [folder, ...others] = await fixtureSources(name);
    expect(folder?.[0]).toBe('folder');
    const fromFolder = await validatePackage(folder?.[1] as PackageSource, expected.options);
    for (const [kind, source] of others) {
      expect({ kind, result: await validatePackage(source, expected.options) }).toEqual({
        kind,
        result: fromFolder,
      });
    }
  });
});

const withRecipe = names.filter((name) => loadFixture(name).expected.archive !== undefined);

describe.each(withRecipe)('validatePackage(the hostile archive of fixtures/%s)', (name) => {
  it("finds exactly the problems and warnings in expected.json's archive section", async () => {
    const { options, archive } = loadFixture(name).expected;
    const result = await validatePackage(await ArchiveSource.open(hostileArchive(name)), options);
    expect(findings(problemsOf(result))).toEqual(findings(archive?.problems ?? []));
    expect(findings(result.warnings)).toEqual(findings(archive?.warnings ?? []));
  });
});

describe('fixture packages', () => {
  it('have the valid packages other packages rely on', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'valid-minimal-node',
        'valid-binary-multi-platform',
        'valid-with-screenshots',
      ]),
    );
  });

  it.each(names)('%s has a 512×512 PNG icon unless it is about the icon', (name) => {
    const icon = readTree(fixtureDir(name)).files.find(([path]) => path === 'assets/icon.png');
    if (['file_missing', 'file_type', 'icon_dimensions'].includes(name)) return;
    expect(icon).toBeDefined();
    expect(readPngDimensions(icon?.[1] ?? new Uint8Array())).toEqual({ width: 512, height: 512 });
  });

  it('share one icon, generated like test/support/images.ts does', () => {
    const icon = readTree(fixtureDir('valid-minimal-node')).files.find(
      ([path]) => path === 'assets/icon.png',
    );
    expect(new Uint8Array(icon?.[1] ?? [])).toEqual(new Uint8Array(png(512, 512)));
  });
});
