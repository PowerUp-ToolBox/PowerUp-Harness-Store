/**
 * The source-agnostic view of a Harness Package that validatePackage() works on. A folder on
 * disk (`DirectorySource`, from `@harness-store/manifest/node`), a zip archive
 * (`ArchiveSource`) and a map of files (`InMemorySource`) all implement it, so the same rules
 * give the same answer for all three.
 */

/** What an entry of a Harness Package is. Anything else (a device, a pipe) is not listed. */
export type PackageEntryKind = 'file' | 'directory' | 'symlink';

/** Why an archive entry could be listed but not unpacked. */
export type UnsupportedEntry =
  { reason: 'encrypted' } | { reason: 'compression_method'; method: number };

/** One entry of a Harness Package, as listed without reading any content. */
export interface PackageEntry {
  /**
   * The name as stored (decoded): the zip entry name, or the path relative to the folder with `/`
   * separators. It may be unsafe (`../x`, `/etc/x`); the archive-safety rules check it.
   */
  name: string;
  /**
   * Other names an unpacker could use for the same entry (a zip's Info-ZIP Unicode Path field).
   * The archive-safety rules check them too.
   */
  otherNames?: readonly string[];
  kind: PackageEntryKind;
  /** Size in bytes, uncompressed (for a zip entry: as its central directory declares). */
  size: number;
  /** Set when the entry could never be unpacked. */
  unsupported?: UnsupportedEntry;
}

/** Everything the archive-safety rules need, gathered without reading any file's content. */
export interface PackageListing {
  entries: readonly PackageEntry[];
  /**
   * Size of the archive in bytes (its compressed size). Absent for a folder, which has no
   * compressed size until it is zipped, and for files held in memory.
   */
  archiveSize?: number;
  /** More entries exist than were listed: listing stops after `PACKAGE_LIMITS.maxListedEntries`. */
  truncated: boolean;
  /**
   * Set when the archive cannot be read at all (not a zip, a corrupt central directory); the
   * text completes the sentence "The Harness Package is not a readable zip archive: ...".
   */
  unreadable?: string;
}

export interface ReadFileOptions {
  /**
   * Read at most this many bytes: the result is the start of the file. Reading stops there, so a
   * huge (or hugely compressed) file costs no more than the bytes asked for.
   */
  maxBytes?: number;
}

/** A Harness Package that validatePackage() can check. */
export interface PackageSource {
  /**
   * The path of every regular file, relative to the package root with `/` separators and without
   * `.` or empty segments. Entries with unsafe names, links and directories are not files.
   */
  listFiles(): string[];
  /**
   * Reads a file listed by {@link listFiles}. Nothing is written anywhere.
   *
   * @throws {PackageReadError} when the file's content cannot be read from the package (a corrupt
   *   or unsupported zip entry): a problem with the package, reported as `archive_invalid`.
   * @throws {Error} for anything else, such as a path that is not listed or an I/O error.
   */
  readFile(path: string, options?: ReadFileOptions): Promise<Uint8Array>;
  /** Every entry, with the metadata the archive-safety rules check. */
  listEntries(): PackageListing;
}

/** A file's content cannot be read from the Harness Package. The message completes a sentence. */
export class PackageReadError extends Error {
  override name = 'PackageReadError';
}

/**
 * The path an entry name stands for, relative to the package root: its `/`-separated segments
 * without empty or `.` segments (`./dist//index.js` is `dist/index.js`). Undefined when the name
 * is unsafe (absolute, or with a `..` segment) or names the root itself.
 */
export function packagePath(name: string): string | undefined {
  if (isAbsoluteName(name) || hasParentSegment(name)) return undefined;
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
  return segments.length > 0 ? segments.join('/') : undefined;
}

/** `/x`, `\x`, `C:x` and `C:\x` name a place outside the package on some platform. */
export function isAbsoluteName(name: string): boolean {
  return /^[/\\]|^[A-Za-z]:/.test(name);
}

/**
 * A `..` segment, with `\` counted as a separator too (Windows unpackers treat it as one). A
 * segment of two dots followed only by dots and spaces (`.. `, `...`) counts as well: Windows
 * drops trailing dots and spaces from names, which turns it into `..`.
 */
export function hasParentSegment(name: string): boolean {
  return name.split(/[/\\]/).some((segment) => /^\.\.[. ]*$/.test(segment));
}

/** The regular files of a listing by path, keeping the first entry for a path listed twice. */
export function indexFiles(entries: readonly PackageEntry[]): Map<string, number> {
  const files = new Map<string, number>();
  entries.forEach((entry, index) => {
    if (entry.kind !== 'file') return;
    const path = packagePath(entry.name);
    if (path !== undefined && !files.has(path)) files.set(path, index);
  });
  return files;
}

/** Validates `options.maxBytes`: a caller bug throws instead of reading everything. */
export function maxBytesOf(options: ReadFileOptions | undefined): number {
  const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY;
  if (typeof maxBytes !== 'number' || Number.isNaN(maxBytes) || maxBytes < 0) {
    throw new TypeError('options.maxBytes must be a non-negative number');
  }
  return maxBytes;
}
