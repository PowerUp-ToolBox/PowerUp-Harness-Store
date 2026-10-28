import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, readFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  interpolate,
  MESSAGES_EN,
  PACKAGE_LIMITS,
  type MessageKey,
  type Problem,
  type ProblemParams,
} from '@harness-store/manifest';
import { ZipDeflate } from 'fflate';
import { exclusionRules, HARNESS_IGNORE_FILE, type ExclusionRules } from './package-exclusions.js';

/** Files are read, and fed to the compressor, this much at a time. */
const CHUNK_BYTES = 64 * 1024;

/** The Deflate level of every file: zlib's default, a balance of size and speed. */
const DEFLATE_LEVEL = 6;

/** Every entry's modification time in MS-DOS form: 1980-01-01 00:00:00, the earliest there is. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/** "Version made by": Unix (3), zip 2.0, so the attributes' high bits are read as a Unix mode. */
const MADE_BY_UNIX = (3 << 8) | 20;
const VERSION_NEEDED = 20;
/** General purpose flag bit 11: the name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
/** A zip without ZIP64 records holds at most this many bytes in one file. */
const MAX_ZIP32 = 0xffffffff;

/** A Harness Package built from a folder, as the Publish flow uploads it (P0-08). */
export interface BuiltPackage {
  /** The zip, or null when it could not be built within the limits (`problem` says why). */
  readonly bytes: Uint8Array | null;
  /** The zip's size in bytes; once it went past the limit, how far it had got. */
  readonly size: number;
  /**
   * Why there is no zip: one `archive_too_large` or `archive_too_many_files` problem
   * (`archive_too_many_files.not_counted` for a folder too large to count).
   */
  readonly problem: Problem | null;
  /**
   * What was left out, topmost only, sorted: a folder as `dir/` (nothing inside it is listed), a
   * file by its path.
   */
  readonly excluded: readonly string[];
  /** The folder's rules, `.harnessignore` included, as this build read them. */
  readonly rules: ExclusionRules;
}

export interface BuildOptions {
  /**
   * Asked between files: false stops the build with {@link BuildSupersededError}, for a run a
   * newer one replaced.
   */
  readonly isCurrent?: () => boolean;
  /** Default: `PACKAGE_LIMITS.maxArchiveBytes`. Tests lower it. */
  readonly maxBytes?: number;
  /**
   * The folder is listed up to this many files, then the build stops; default
   * `PACKAGE_LIMITS.maxListedEntries`, where `validatePackage` stops listing a zip. Tests lower it.
   */
  readonly maxListed?: number;
}

/** The folder itself cannot be listed (gone, or not readable). */
export class FolderUnreadableError extends Error {
  constructor(options?: ErrorOptions) {
    super('The folder cannot be read.', options);
    this.name = 'FolderUnreadableError';
  }
}

/** A file or folder inside it that the User's account may not open, named relative to it. */
export class EntryUnreadableError extends Error {
  readonly path: string;

  constructor(path: string, options?: ErrorOptions) {
    super(`${path} cannot be opened.`, options);
    this.name = 'EntryUnreadableError';
    this.path = path;
  }
}

/** Something listed changed while the zip was being built (deleted, or replaced by a link). */
export class FolderChangedError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(detail, options);
    this.name = 'FolderChangedError';
  }
}

/** A newer build replaced this one ({@link BuildOptions.isCurrent}). */
export class BuildSupersededError extends Error {
  constructor() {
    super('A newer build replaced this one.');
    this.name = 'BuildSupersededError';
  }
}

/** The folder holds more files than the build lists ({@link BuildOptions.maxListed}). */
class TooManyFilesError extends Error {
  constructor() {
    super('The folder holds too many files to list.');
    this.name = 'TooManyFilesError';
  }
}

/** One item of the folder that goes into the zip. */
interface Item {
  /** Relative, `/`-separated. */
  readonly path: string;
  /**
   * A regular file is read; a link or special file goes in as an empty entry with its mode (read
   * with `lstat` once the folder is known to be within the limits).
   */
  readonly kind: 'file' | 'other';
}

/** One entry of the zip being written. */
interface Entry {
  readonly name: Uint8Array;
  readonly utf8: boolean;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly mode: number;
  readonly data: readonly Uint8Array[];
}

/**
 * Builds the Harness Package of `folder`: a deterministic zip of what the exclusion rules
 * (./package-exclusions.ts) keep, so the same folder always gives the same bytes. Entries are the
 * folder's files only (no folder entries), sorted by path in UTF-16 code-unit order, each with the
 * timestamp 1980-01-01 00:00:00 and its Unix mode, deflated at level 6 (the layout of the
 * reference Harnesses' pack script). Folders the rules leave out are never entered.
 *
 * A symbolic link or special file (a pipe, a socket, a device) is never followed or read: it goes
 * in as an empty entry carrying its mode, so `validatePackage` reports it at its own path
 * (`archive_symlink`, `file_type.special`) and the package cannot be published.
 *
 * Files are read and compressed 64 KiB at a time, yielding to the event loop in between, so the
 * main process (which also hosts the Model Gateway) never stalls on a large package. Every local
 * header carries the sizes and CRC-32 (no data descriptors), as `validatePackage` rejects a
 * stored entry with one. A zip that grows past `PACKAGE_LIMITS.maxArchiveBytes` is abandoned with
 * an `archive_too_large` problem, and a folder with more than `PACKAGE_LIMITS.maxFiles` files with
 * an `archive_too_many_files` one, without being read, so no ZIP64 record is ever needed. Listing
 * stops after `PACKAGE_LIMITS.maxListedEntries` files, as `validatePackage` stops listing a zip
 * (`archive_too_many_files.not_counted`), so a folder picked by mistake (a project root with its
 * `node_modules`, a home folder) is not walked to the end on every run.
 *
 * @throws {FolderUnreadableError} when `folder` cannot be listed, {@link EntryUnreadableError}
 *   for a file or folder in it the User may not open, {@link FolderChangedError} when something
 *   listed is gone or replaced while it is read, {@link BuildSupersededError}.
 */
export async function buildPackage(
  folder: string,
  options: BuildOptions = {},
): Promise<BuiltPackage> {
  const isCurrent = options.isCurrent ?? (() => true);
  const maxBytes = options.maxBytes ?? PACKAGE_LIMITS.maxArchiveBytes;
  const maxListed = options.maxListed ?? PACKAGE_LIMITS.maxListedEntries;
  const rules = exclusionRules(await readHarnessIgnore(folder));
  const items: Item[] = [];
  const excluded: string[] = [];
  try {
    await walk(folder, '', { rules, items, excluded, isCurrent, maxListed });
  } catch (error) {
    if (!(error instanceof TooManyFilesError)) throw error;
    excluded.sort(compare);
    const problem = packageProblem('archive_too_many_files.not_counted', {
      counted: maxListed,
      limit: PACKAGE_LIMITS.maxFiles,
    });
    return { bytes: null, size: 0, problem, excluded, rules };
  }
  items.sort((a, b) => compare(a.path, b.path));
  excluded.sort(compare);

  if (items.length > PACKAGE_LIMITS.maxFiles) {
    const problem = packageProblem('archive_too_many_files', {
      actual: items.length,
      limit: PACKAGE_LIMITS.maxFiles,
    });
    return { bytes: null, size: 0, problem, excluded, rules };
  }

  const entries: Entry[] = [];
  let size = 0;
  for (const item of items) {
    if (!isCurrent()) throw new BuildSupersededError();
    const entry =
      item.kind === 'file'
        ? await deflateFile(folder, item, maxBytes - size)
        : emptyEntry(item.path, await modeOf(folder, item.path));
    size += localHeaderSize(entry) + entry.compressedSize + centralHeaderSize(entry);
    if (entry.size > MAX_ZIP32 || size + END_RECORD_SIZE > maxBytes) {
      const problem = packageProblem('archive_too_large', {
        actual: Math.max(size + END_RECORD_SIZE, entry.size),
        limit: PACKAGE_LIMITS.maxArchiveBytes,
      });
      return { bytes: null, size: size + END_RECORD_SIZE, problem, excluded, rules };
    }
    entries.push(entry);
  }
  const bytes = writeZip(entries);
  return { bytes, size: bytes.length, problem: null, excluded, rules };
}

/** Code-unit order, as `Array.prototype.sort` without a comparator orders strings. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A Problem as validatePackage builds it, at the package as a whole (`$`). */
function packageProblem(messageKey: MessageKey, params: ProblemParams): Problem {
  return {
    path: '$',
    code: messageKey.split('.', 1)[0] ?? messageKey,
    messageKey,
    params,
    message: interpolate(MESSAGES_EN[messageKey], params),
  };
}

/** `.harnessignore` at the folder root, when it is a regular file; a link is not followed. */
async function readHarnessIgnore(folder: string): Promise<string | null> {
  const path = join(folder, HARNESS_IGNORE_FILE);
  try {
    if (!(await lstat(path)).isFile()) return null;
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new EntryUnreadableError(HARNESS_IGNORE_FILE, { cause: error });
    }
    throw new FolderUnreadableError({ cause: error });
  }
}

/** What a walk of the folder fills in, and what it follows. */
interface Walk {
  readonly rules: ExclusionRules;
  /** What goes in. */
  readonly items: Item[];
  /** What is left out. */
  readonly excluded: string[];
  readonly isCurrent: () => boolean;
  /** More items than this stop the walk with {@link TooManyFilesError}. */
  readonly maxListed: number;
}

/** Lists `relative` (inside `root`) into `walk`. */
async function walk(root: string, relative: string, state: Walk): Promise<void> {
  const { rules, items, excluded, isCurrent } = state;
  if (!isCurrent()) throw new BuildSupersededError();
  let children: Dirent[];
  try {
    children = await readdir(join(root, ...splitPath(relative)), { withFileTypes: true });
  } catch (error) {
    if (relative === '') throw new FolderUnreadableError({ cause: error });
    throw unreadable(relative, error);
  }
  for (const child of children) {
    const path = relative === '' ? child.name : `${relative}/${child.name}`;
    if (child.isDirectory()) {
      if (rules.excludesFolder(path)) excluded.push(`${path}/`);
      else await walk(root, path, state);
      continue;
    }
    if (rules.excludesFile(path)) {
      excluded.push(path);
      continue;
    }
    items.push({ path, kind: child.isFile() ? 'file' : 'other' });
    if (items.length > state.maxListed) throw new TooManyFilesError();
  }
}

/** The Unix mode of a link or special file, as `lstat` gives it, file type bits included. */
async function modeOf(root: string, path: string): Promise<number> {
  try {
    return (await lstat(join(root, ...splitPath(path)))).mode;
  } catch (error) {
    throw unreadable(path, error);
  }
}

function splitPath(path: string): string[] {
  return path === '' ? [] : path.split('/');
}

/** A refused open is the User's to fix; anything else means the folder changed meanwhile. */
function unreadable(path: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM')
    return new EntryUnreadableError(path, { cause: error });
  return new FolderChangedError(`${path} can no longer be read`, { cause: error });
}

/**
 * Reads and deflates one regular file, without following a link that replaced it since it was
 * listed. Stops reading once its compressed data alone passes `budget` bytes.
 */
async function deflateFile(root: string, item: Item, budget: number): Promise<Entry> {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  let handle: FileHandle;
  try {
    handle = await open(join(root, ...splitPath(item.path)), constants.O_RDONLY | noFollow);
  } catch (error) {
    throw unreadable(item.path, error);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new FolderChangedError(`${item.path} is no longer a file`);
    const data: Uint8Array[] = [];
    const output = { compressedSize: 0, failure: null as Error | null };
    const deflate = new ZipDeflate(item.path, { level: DEFLATE_LEVEL });
    deflate.ondata = (error, chunk) => {
      if (error !== null) output.failure = error;
      else {
        data.push(chunk);
        output.compressedSize += chunk.length;
      }
    };
    const buffer = new Uint8Array(CHUNK_BYTES);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      size += bytesRead;
      const last = bytesRead === 0 || size > MAX_ZIP32 || output.compressedSize > budget;
      deflate.push(buffer.slice(0, bytesRead), last);
      if (output.failure !== null) throw output.failure;
      if (last) break;
      // Lets the Model Gateway and IPC run between chunks.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const name = new TextEncoder().encode(item.path);
    return {
      name,
      utf8: name.length !== item.path.length,
      method: METHOD_DEFLATE,
      crc: deflate.crc,
      compressedSize: output.compressedSize,
      size,
      mode: (stats.mode & 0xffff) >>> 0,
      data,
    };
  } finally {
    await handle.close();
  }
}

/** A link or special file: no content, only its name and mode. */
function emptyEntry(path: string, mode: number): Entry {
  const name = new TextEncoder().encode(path);
  return {
    name,
    utf8: name.length !== path.length,
    method: METHOD_STORED,
    crc: 0,
    compressedSize: 0,
    size: 0,
    mode: mode & 0xffff,
    data: [],
  };
}

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_RECORD_SIZE = 22;

function localHeaderSize(entry: Entry): number {
  return LOCAL_HEADER_SIZE + entry.name.length;
}

function centralHeaderSize(entry: Entry): number {
  return CENTRAL_HEADER_SIZE + entry.name.length;
}

/** The zip of `entries`, in order: local headers and data, the central directory, its end. */
function writeZip(entries: readonly Entry[]): Uint8Array {
  const dataSize = entries.reduce(
    (total, entry) => total + localHeaderSize(entry) + entry.compressedSize,
    0,
  );
  const directorySize = entries.reduce((total, entry) => total + centralHeaderSize(entry), 0);
  const bytes = new Uint8Array(dataSize + directorySize + END_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  const offsets: number[] = [];
  let at = 0;
  for (const entry of entries) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, VERSION_NEEDED, true);
    writeCommon(view, at + 6, entry);
    view.setUint16(at + 28, 0, true);
    bytes.set(entry.name, at + LOCAL_HEADER_SIZE);
    at += localHeaderSize(entry);
    for (const chunk of entry.data) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
  }
  const directoryOffset = at;
  entries.forEach((entry, index) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, MADE_BY_UNIX, true);
    view.setUint16(at + 6, VERSION_NEEDED, true);
    writeCommon(view, at + 8, entry);
    // Extra field and comment lengths, disk number, internal attributes: all 0.
    view.setUint16(at + 30, 0, true);
    view.setUint16(at + 32, 0, true);
    view.setUint16(at + 34, 0, true);
    view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, (entry.mode * 0x10000) >>> 0, true);
    view.setUint32(at + 42, offsets[index] ?? 0, true);
    bytes.set(entry.name, at + CENTRAL_HEADER_SIZE);
    at += centralHeaderSize(entry);
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, directorySize, true);
  view.setUint32(at + 16, directoryOffset, true);
  return bytes;
}

/**
 * The fields local headers and central directory records share, from the flags to the name's
 * length: flags, method, time, date, CRC-32, compressed and uncompressed size, name length.
 */
function writeCommon(view: DataView, at: number, entry: Entry): void {
  view.setUint16(at, entry.utf8 ? FLAG_UTF8 : 0, true);
  view.setUint16(at + 2, entry.method, true);
  view.setUint16(at + 4, DOS_TIME, true);
  view.setUint16(at + 6, DOS_DATE, true);
  view.setUint32(at + 8, entry.crc >>> 0, true);
  view.setUint32(at + 12, entry.compressedSize, true);
  view.setUint32(at + 16, entry.size, true);
  view.setUint16(at + 20, entry.name.length, true);
}
