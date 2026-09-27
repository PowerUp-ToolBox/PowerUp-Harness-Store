import { indexFiles, maxBytesOf } from './source.js';
import type { PackageEntry, PackageListing, PackageSource, ReadFileOptions } from './source.js';

/**
 * A Harness Package held as a map from path to bytes. Meant for tests, and for callers that
 * already hold the files in memory without their archive (prefer `ArchiveSource` for a zip: it
 * sees what a map cannot, such as symbolic links and the archive's size).
 *
 * Every key is a file, named as a zip entry would be (`dist/index.js`); keys with unsafe names
 * (`../x`, `/etc/x`) are listed as they are, so the archive-safety rules report them.
 */
export class InMemorySource implements PackageSource {
  readonly #contents: Uint8Array[];
  readonly #listing: PackageListing;
  readonly #files: Map<string, number>;

  constructor(files: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>) {
    // The tag check also recognises a Map from another realm (an iframe, a vm context).
    const pairs: [string, unknown][] =
      Object.prototype.toString.call(files) === '[object Map]'
        ? [...(files as ReadonlyMap<string, unknown>)]
        : Object.entries(files);
    this.#contents = [];
    const entries: PackageEntry[] = [];
    for (const [name, content] of pairs) {
      if (typeof name !== 'string' || !ArrayBuffer.isView(content)) {
        throw new TypeError('InMemorySource takes a map from path to Uint8Array');
      }
      const bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
      this.#contents.push(bytes);
      entries.push(Object.freeze({ name, kind: 'file', size: bytes.length }));
    }
    this.#listing = Object.freeze({ entries: Object.freeze(entries), truncated: false });
    this.#files = indexFiles(entries);
  }

  listEntries(): PackageListing {
    return this.#listing;
  }

  listFiles(): string[] {
    return [...this.#files.keys()];
  }

  readFile(path: string, options?: ReadFileOptions): Promise<Uint8Array> {
    // The executor turns a throw into a rejection, like the other sources' async readFile.
    return new Promise((resolve) => {
      const maxBytes = maxBytesOf(options);
      const index = this.#files.get(path);
      const bytes = index === undefined ? undefined : this.#contents[index];
      if (bytes === undefined) throw new Error(`"${path}" is not a file in this Harness Package`);
      resolve(bytes.slice(0, Math.min(bytes.length, maxBytes)));
    });
  }
}
