import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_LIMITS } from '../limits.js';
import { indexFiles, maxBytesOf } from '../source.js';
import type { PackageEntry, PackageListing, PackageSource, ReadFileOptions } from '../source.js';

/**
 * A Harness Package as a folder on disk, the folder being the package root (the Publish flow and
 * "install from folder" validate the folder before zipping or copying it).
 *
 * Opening it lists the folder without following symbolic links: a link is listed as a link (and
 * reported by validatePackage(), exactly as its zip would be), never entered. Devices, sockets
 * and named pipes are listed as `special` entries (reported, never read), as a zip that stores
 * their Unix mode lists them. Entries are listed in path order. A folder has no compressed size,
 * so the 500 MB archive limit is checked on the zip made from it.
 */
export class DirectorySource implements PackageSource {
  /** The folder, as given to {@link DirectorySource.open}. */
  readonly root: string;
  readonly #listing: PackageListing;
  readonly #files: Map<string, number>;

  private constructor(root: string, listing: PackageListing) {
    this.root = root;
    this.#listing = listing;
    this.#files = indexFiles(listing.entries);
  }

  /**
   * Lists `directory`, stopping after `PACKAGE_LIMITS.maxListedEntries` entries.
   *
   * @throws when `directory` is not a readable folder.
   */
  static async open(directory: string): Promise<DirectorySource> {
    if (!(await stat(directory)).isDirectory()) throw new Error(`${directory} is not a folder`);
    const entries: PackageEntry[] = [];
    let truncated = false;
    const pending = [''];
    for (let prefix = pending.pop(); prefix !== undefined && !truncated; prefix = pending.pop()) {
      let names = await readdir(join(directory, prefix));
      const room = PACKAGE_LIMITS.maxListedEntries - entries.length;
      if (names.length > room) {
        truncated = true;
        names = names.slice(0, room);
      }
      const paths = names.map((name) => (prefix === '' ? name : `${prefix}/${name}`));
      const stats = await Promise.all(paths.map((path) => lstat(join(directory, path))));
      paths.forEach((path, index) => {
        const entry = stats[index];
        if (entry?.isSymbolicLink()) entries.push({ name: path, kind: 'symlink', size: 0 });
        else if (entry?.isDirectory()) {
          entries.push({ name: path, kind: 'directory', size: 0 });
          pending.push(path);
        } else if (entry?.isFile()) entries.push({ name: path, kind: 'file', size: entry.size });
        else if (entry !== undefined) entries.push({ name: path, kind: 'special', size: 0 });
      });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const listing = Object.freeze({
      entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
      truncated,
    });
    return new DirectorySource(directory, listing);
  }

  listEntries(): PackageListing {
    return this.#listing;
  }

  listFiles(): string[] {
    return [...this.#files.keys()];
  }

  /** Reads a listed file, without following a link that replaced it since it was listed. */
  async readFile(path: string, options?: ReadFileOptions): Promise<Uint8Array> {
    const maxBytes = maxBytesOf(options);
    const index = this.#files.get(path);
    const entry = index === undefined ? undefined : this.#listing.entries[index];
    if (entry === undefined) throw new Error(`"${path}" is not a file in this Harness Package`);
    // O_NOFOLLOW does not exist on Windows; there the flag is 0 and has no effect.
    const handle = await open(
      join(this.root, path),
      constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0),
    );
    try {
      const size = (await handle.stat()).size;
      const length = Math.min(size, maxBytes);
      const bytes = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(bytes, filled, length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return bytes.subarray(0, filled);
    } finally {
      await handle.close();
    }
  }
}
