/**
 * Turns fixture folders into Harness Packages of every source kind: the folder itself, a zip of
 * it (as bytes, and as a file on disk), files in memory, and the hostile archives that fixtures
 * describe with an `archive.recipe` in their expected.json.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArchiveSource, InMemorySource } from '../../src/index.js';
import type { RandomAccessReader } from '../../src/index.js';
import { DirectorySource } from '../../src/node/index.js';
import { fixturesRoot, loadFixture } from '../helpers.js';
import { buildZip, zipReader } from './zip-writer.js';
import type { ZipEntrySpec } from './zip-writer.js';

export function fixtureDir(name: string): string {
  return join(fixturesRoot, name);
}

/** Every folder and file under `dir`, in path order, with `/` separators. */
export function readTree(dir: string): { directories: string[]; files: [string, Uint8Array][] } {
  const directories: string[] = [];
  const files: [string, Uint8Array][] = [];
  const visit = (prefix: string) => {
    const entries = readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        directories.push(path);
        visit(path);
      } else if (entry.isFile()) {
        files.push([path, readFileSync(join(dir, path))]);
      }
    }
  };
  visit('');
  return { directories, files };
}

/** Zip entries for a folder, as `zip -r` writes them: a `dir/` entry per folder, then files. */
export function folderEntries(dir: string): ZipEntrySpec[] {
  const { directories, files } = readTree(dir);
  return [
    ...directories.map((path) => ({ name: `${path}/` })),
    ...files.map(([name, data]) => ({ name, data })),
  ];
}

/** A zip of the folder, as a Publisher (or the Publish flow) would make it. */
export function zipFolder(dir: string): Uint8Array {
  return buildZip(folderEntries(dir));
}

export function inMemoryFolder(dir: string): InMemorySource {
  return new InMemorySource(new Map(readTree(dir).files));
}

/** The three kinds of source for a fixture folder, by name. */
export async function fixtureSources(
  name: string,
): Promise<[kind: string, source: DirectorySource | ArchiveSource | InMemorySource][]> {
  const dir = fixtureDir(name);
  return [
    ['folder', await DirectorySource.open(dir)],
    ['zip', await ArchiveSource.open(zipFolder(dir))],
    ['memory', inMemoryFolder(dir)],
  ];
}

/** The hostile archive a fixture's `archive.recipe` describes. */
export function hostileArchive(name: string): Uint8Array | RandomAccessReader {
  const recipe = loadFixture(name).expected.archive?.recipe;
  if (recipe === undefined) throw new Error(`fixtures/${name} has no archive recipe`);
  const entries: ZipEntrySpec[] = [
    ...(recipe.unlistedEntries ?? []).map(({ name: entryName, text }) => ({
      name: entryName,
      data: text,
      unlisted: true,
    })),
    ...folderEntries(fixtureDir(name)),
  ];
  for (const { name: entryName, text } of recipe.addEntries ?? []) {
    entries.push({ name: entryName, data: text });
  }
  for (const { name: entryName, localName, text } of recipe.localNames ?? []) {
    entries.push({ name: entryName, localName, data: text });
  }
  for (const { name: linkName, target } of recipe.symlinks ?? []) {
    entries.push({ name: linkName, data: target, method: 0, unixMode: 0o120777 });
  }
  for (let i = 0; i < (recipe.fillerFiles ?? 0); i++) {
    entries.push({ name: `filler/${String(i)}.txt` });
  }
  for (const { name: fileName, bytes } of recipe.largeFiles ?? []) {
    entries.push({ name: fileName, zeros: bytes });
  }
  if (recipe.largeFiles !== undefined) return zipReader(entries);
  const zip = buildZip(entries);
  return zip.subarray(0, zip.length - (recipe.truncateBytes ?? 0));
}
