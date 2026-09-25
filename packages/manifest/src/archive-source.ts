import { PACKAGE_LIMITS } from './limits.js';
import { indexFiles, maxBytesOf, PackageReadError } from './source.js';
import type { PackageEntry, PackageListing, PackageSource, ReadFileOptions } from './source.js';
import { readCentralDirectory, ZipFormatError } from './zip/central-directory.js';
import type { CentralDirectory, RandomAccessReader, ZipEntry } from './zip/central-directory.js';
import { FLAG_ENCRYPTED, readLocalHeaders } from './zip/local-headers.js';
import type { LocalHeader, LocalLayout } from './zip/local-headers.js';
import { METHOD_DEFLATE, METHOD_STORED, readEntry } from './zip/read-entry.js';

export type { RandomAccessReader } from './zip/central-directory.js';

/**
 * A Harness Package in a zip archive. Opening it reads the central directory (the zip's list of
 * entries) and every entry's local header, never any content; {@link readFile} inflates one entry
 * into memory, up to the bytes asked for. Nothing is ever extracted or written to disk, so it is
 * safe on an untrusted upload.
 *
 * The listing is what every unpacker would find: an entry whose local header disagrees with the
 * central directory, and bytes that belong to no entry (where a streaming unpacker could find
 * files the central directory hides), are listed for the archive-safety rules to reject.
 *
 * The archive is given as bytes (the Store's `publish` Edge Function, the renderer) or as a
 * {@link RandomAccessReader} that reads by position (`fileReader()` from
 * `@harness-store/manifest/node` reads a zip file on disk without loading it whole).
 */
export class ArchiveSource implements PackageSource {
  readonly #reader: RandomAccessReader;
  readonly #entries: readonly ZipEntry[];
  readonly #headers: readonly LocalHeader[];
  readonly #listing: PackageListing;
  readonly #files: Map<string, number>;

  private constructor(
    reader: RandomAccessReader,
    zip: { directory: CentralDirectory; layout: LocalLayout } | string,
  ) {
    this.#reader = reader;
    if (typeof zip === 'string') {
      this.#entries = [];
      this.#headers = [];
      this.#listing = Object.freeze({
        entries: Object.freeze([]),
        archiveSize: reader.size,
        truncated: false,
        unreadable: zip,
      });
    } else {
      const { directory, layout } = zip;
      this.#entries = directory.entries;
      this.#headers = layout.headers;
      const listing: PackageListing = {
        entries: Object.freeze(
          directory.entries.map((entry, index) =>
            toPackageEntry(entry, layout.headers[index] ?? { otherNames: [] }),
          ),
        ),
        archiveSize: reader.size,
        truncated: directory.truncated,
      };
      if (layout.unlisted !== undefined) listing.unlistedData = Object.freeze(layout.unlisted);
      this.#listing = Object.freeze(listing);
    }
    this.#files = indexFiles(this.#listing.entries);
  }

  /**
   * Reads the archive's central directory and local headers. An archive that is not a readable
   * zip still opens: its listing says why (`unreadable`), and validatePackage() reports
   * `archive_invalid`.
   *
   * @throws {TypeError} when `archive` is neither bytes nor a reader; otherwise only what the
   *   reader throws (an I/O error), never because of the archive's content.
   */
  static async open(
    archive: Uint8Array | ArrayBuffer | RandomAccessReader,
  ): Promise<ArchiveSource> {
    const reader = toReader(archive);
    try {
      const directory = await readCentralDirectory(reader, {
        maxEntries: PACKAGE_LIMITS.maxListedEntries,
        maxCentralDirectoryBytes: PACKAGE_LIMITS.maxCentralDirectoryBytes,
      });
      const layout = await readLocalHeaders(reader, directory);
      return new ArchiveSource(reader, { directory, layout });
    } catch (error) {
      if (error instanceof ZipFormatError) return new ArchiveSource(reader, error.message);
      throw error;
    }
  }

  listEntries(): PackageListing {
    return this.#listing;
  }

  listFiles(): string[] {
    return [...this.#files.keys()];
  }

  async readFile(path: string, options?: ReadFileOptions): Promise<Uint8Array> {
    const maxBytes = maxBytesOf(options);
    const index = this.#files.get(path);
    const entry = index === undefined ? undefined : this.#entries[index];
    const header = index === undefined ? undefined : this.#headers[index];
    if (entry === undefined || header === undefined) {
      throw new Error(`"${path}" is not a file in this Harness Package`);
    }
    // An entry that unpackers could see differently is never read.
    if (header.inconsistency !== undefined) throw new PackageReadError(header.inconsistency);
    if (header.name !== undefined || header.dataStart === undefined) {
      throw new PackageReadError(
        'its local header names a different file than the central directory',
      );
    }
    try {
      return await readEntry(this.#reader, entry, header.dataStart, maxBytes);
    } catch (error) {
      if (error instanceof ZipFormatError) throw new PackageReadError(error.message);
      throw error;
    }
  }
}

function toPackageEntry(entry: ZipEntry, header: LocalHeader): PackageEntry {
  const listed: PackageEntry = { name: entry.name, kind: entry.kind, size: entry.uncompressedSize };
  const otherNames = [...entry.otherNames, ...header.otherNames];
  if (otherNames.length > 0) listed.otherNames = Object.freeze(otherNames);
  if (header.name !== undefined) listed.localName = header.name;
  if (header.inconsistency !== undefined) {
    listed.unsupported = Object.freeze({ reason: 'inconsistent', detail: header.inconsistency });
  } else if (entry.kind === 'file') {
    // Directories and links carry no content an unpacker needs to inflate.
    if (entry.flags & FLAG_ENCRYPTED) listed.unsupported = { reason: 'encrypted' };
    else if (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE) {
      listed.unsupported = { reason: 'compression_method', method: entry.method };
    }
  }
  return Object.freeze(listed);
}

function toReader(archive: Uint8Array | ArrayBuffer | RandomAccessReader): RandomAccessReader {
  // ArrayBuffer.isView and the tag check also work for bytes from another realm (an iframe, a
  // worker message, a vm context), where `instanceof` does not.
  if (ArrayBuffer.isView(archive)) {
    return bytesReader(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength));
  }
  if (Object.prototype.toString.call(archive) === '[object ArrayBuffer]') {
    return bytesReader(new Uint8Array(archive as ArrayBuffer));
  }
  const candidate: unknown = archive;
  const reader = (
    typeof candidate === 'object' && candidate !== null ? candidate : {}
  ) as Partial<RandomAccessReader>;
  if (
    typeof reader.read !== 'function' ||
    typeof reader.size !== 'number' ||
    !Number.isSafeInteger(reader.size) ||
    reader.size < 0
  ) {
    throw new TypeError('ArchiveSource.open() takes the archive bytes or a RandomAccessReader');
  }
  return checkedReader(reader as RandomAccessReader);
}

/** Reads from bytes in memory: each read is a view, not a copy. */
function bytesReader(bytes: Uint8Array): RandomAccessReader {
  return checkedReader({
    size: bytes.length,
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  });
}

/** Refuses reads outside the archive and short reads, whatever the underlying reader does. */
function checkedReader(reader: RandomAccessReader): RandomAccessReader {
  return {
    size: reader.size,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > reader.size) {
        throw new ZipFormatError('it refers to data beyond the end of the archive');
      }
      const bytes = await reader.read(offset, length);
      if (bytes.length !== length) throw new ZipFormatError('it could not be read completely');
      return bytes;
    },
  };
}
