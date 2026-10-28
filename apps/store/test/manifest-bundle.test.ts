/**
 * Ticket P0-07.3: the Edge Functions import @harness-store/manifest from one bundled ES module
 * (scripts/bundle-manifest.ts). The bundle builds with no Node built-in and validates a Harness
 * Package exactly as the package itself does.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as manifestPackage from '@harness-store/manifest';
import { zipSync } from 'fflate';
import { build } from 'vite';
import type { Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundleConfig } from '../scripts/bundle-manifest.ts';
import { storeRoot } from '../scripts/local-stack.ts';
import { readFolder } from '../scripts/seed.ts';

let dir: string | undefined;
let bundled: typeof manifestPackage;

beforeAll(async () => {
  const output = (await build(bundleConfig(storeRoot(), false))) as
    Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunks = [output]
    .flat()
    .flatMap((result) => result.output)
    .filter((item): item is Rolldown.OutputChunk => item.type === 'chunk');
  expect(chunks.map((chunk) => chunk.fileName)).toEqual(['manifest.js']);
  dir = mkdtempSync(join(tmpdir(), 'manifest-bundle-'));
  const file = join(dir, 'manifest.js');
  writeFileSync(file, chunks[0]?.code ?? '');
  bundled = (await import(pathToFileURL(file).href)) as typeof manifestPackage;
}, 60_000);

afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function fixtureZip(name: string): Uint8Array {
  const fixtures = join(storeRoot(), '..', '..', 'packages', 'manifest', 'fixtures');
  return zipSync(Object.fromEntries(readFolder(join(fixtures, name))));
}

describe('the bundled Manifest package', () => {
  it('exports what the package exports', () => {
    expect(Object.keys(bundled).sort()).toEqual(Object.keys(manifestPackage).sort());
  });

  it.each([
    ['valid-with-screenshots', { publisher: 'alice', publishedVersions: ['0.0.9'] }],
    ['publisher_mismatch', { publisher: 'alice' }],
    ['version_not_greater', { publisher: 'alice', publishedVersions: ['1.0.0', '1.2.0'] }],
    ['multiple-problems', {}],
  ])('validates %s exactly as the package does', async (name, options) => {
    const zip = fixtureZip(name);
    const expected = await manifestPackage.validatePackage(
      await manifestPackage.ArchiveSource.open(zip),
      options,
    );
    const actual = await bundled.validatePackage(await bundled.ArchiveSource.open(zip), options);
    expect(actual).toEqual(expected);
  });
});
