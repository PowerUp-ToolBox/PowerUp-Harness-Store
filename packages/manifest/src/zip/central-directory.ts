import { crc32 } from './crc32.js';

/**
 * A zip archive read by position, so a large archive never has to be held in memory (or written
 * anywhere) to be listed and validated. `read` resolves to exactly `length` bytes.
 */
export interface RandomAccessReader {
  /** Size of the archive in bytes. */
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** The archive is not a zip this reader can read safely. The message completes a sentence. */
export class ZipFormatError extends Error {
  override name = 'ZipFormatError';
}

/** One entry of the central directory, the zip's own list of what it holds. */
export interface ZipEntry {
  /**
   * The entry's name, decoded: UTF-8 when the archive says so (flag bit 11) or when the bytes are
   * valid UTF-8, CP437 otherwise, or the Info-ZIP Unicode Path extra field when it matches.
   */
  name: string;
  /** Other names an unpacker might use for this entry (the other of the two names above). */
  otherNames: string[];
  rawName: Uint8Array;
  kind: 'file' | 'directory' | 'symlink' | 'special';
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface CentralDirectory {
  entries: ZipEntry[];
  /** Entries were left unread because the archive declares more than `maxEntries`. */
  truncated: boolean;
  /** Where the central directory starts; every entry's data must lie before it. */
  centralDirectoryOffset: number;
}

export interface CentralDirectoryLimits {
  /** Stop listing after this many entries (the rest of the archive is not read). */
  maxEntries: number;
  /** A larger central directory is refused rather than read into memory. */
  maxCentralDirectoryBytes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_SIZE = 46;
const MAX_COMMENT_LENGTH = 0xffff;

export const ZIP64_EXTRA_FIELD = 0x0001;
export const UNICODE_PATH_EXTRA_FIELD = 0x7075;
/**
 * libarchive's experimental "xl" extra field, which carries a Unix mode (and MS-DOS attributes)
 * in a local header. libarchive applies it, so an entry the central directory calls a regular
 * file can be a symlink or folder to it: {@link fileTypeKind} decodes it for a consistency check.
 */
export const XL_EXTRA_FIELD = 0x6c78;

/** "Version made by" host codes we treat specially: Unix carries a mode, MS-DOS the DOS attributes. */
export const HOST_MSDOS = 0;
export const HOST_UNIX = 3;
/** The MS-DOS directory attribute, in the low byte of the external attributes. */
const MSDOS_DIRECTORY = 0x10;

/** The file kind a set of external attributes names, or undefined when they carry no file type. */
export type FileTypeKind = 'symlink' | 'special' | 'directory' | 'file';

/**
 * The file kind that `externalAttributes` (of a central record or an "xl" field) name for the
 * given "version made by" host: a Unix host's mode is in the high 16 bits, an MS-DOS host's
 * directory flag in the low byte. Undefined when they say nothing about the file type, so an
 * entry keeps the kind its name implies.
 */
export function fileTypeKind(externalAttributes: number, host: number): FileTypeKind | undefined {
  const unixFileType = (externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
  if (unixFileType === UNIX_SYMLINK) return 'symlink';
  if (unixFileType === UNIX_DIRECTORY) return 'directory';
  if (unixFileType === UNIX_REGULAR) return 'file';
  if (unixFileType !== 0) return 'special';
  if (host === HOST_MSDOS && (externalAttributes & MSDOS_DIRECTORY) !== 0) return 'directory';
  return undefined;
}

/**
 * `S_IFMT` and its values: the file-type bits of a Unix mode, for a symbolic link, a folder and a
 * regular file. Any other value (a device, a pipe, a socket) is a special file.
 */
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;
const UNIX_DIRECTORY = 0o040000;
const UNIX_REGULAR = 0o100000;

/** General purpose flag bit 11: the name (and comment) are UTF-8. */
export const FLAG_UTF8 = 0x0800;

/**
 * Reads the central directory of a zip archive: the entry names, sizes, types and offsets, and
 * nothing of any entry's content. ZIP64 archives are supported; split archives are not.
 *
 * @throws {ZipFormatError} when the archive is not a readable zip.
 */
export async function readCentralDirectory(
  reader: RandomAccessReader,
  limits: CentralDirectoryLimits,
): Promise<CentralDirectory> {
  const end = await findEndOfCentralDirectory(reader);
  if (end.cdSize > limits.maxCentralDirectoryBytes) {
    throw new ZipFormatError(
      `its list of files (the central directory) is ${String(end.cdSize)} bytes, more than the ${String(limits.maxCentralDirectoryBytes)} bytes any Harness Package needs`,
    );
  }
  if (end.cdOffset + end.cdSize > end.recordOffset) {
    throw new ZipFormatError('its central directory lies outside the archive');
  }
  // Info-ZIP and others treat a gap here as bytes prepended to the archive and shift every
  // offset by it, which would make them read other files than this reader does.
  if (end.cdOffset + end.cdSize !== end.recordOffset) {
    throw new ZipFormatError(
      'its central directory does not end where its end of central directory record starts',
    );
  }
  if (end.entryCount * CENTRAL_HEADER_SIZE > end.cdSize) {
    throw new ZipFormatError('it declares more entries than its central directory holds');
  }

  const directory = await reader.read(end.cdOffset, end.cdSize);
  const view = viewOf(directory);
  const entries: ZipEntry[] = [];
  const count = Math.min(end.entryCount, limits.maxEntries);
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + CENTRAL_HEADER_SIZE > directory.length) {
      throw new ZipFormatError('its central directory ends in the middle of an entry');
    }
    if (view.getUint32(at, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new ZipFormatError('its central directory is corrupt');
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const next = at + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    if (next > directory.length) {
      throw new ZipFormatError('its central directory ends in the middle of an entry');
    }
    const nameStart = at + CENTRAL_HEADER_SIZE;
    const rawName = directory.subarray(nameStart, nameStart + nameLength);
    const extra = directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    entries.push(parseEntry(view, at, rawName, extra, end.cdOffset));
    at = next;
  }
  // Some tools read central directory records until the signature stops matching rather than
  // counting them: records beyond the count would be files only they see.
  if (count === end.entryCount && at !== directory.length) {
    throw new ZipFormatError('its central directory holds more than its end record says');
  }
  return {
    entries,
    truncated: end.entryCount > count,
    centralDirectoryOffset: end.cdOffset,
  };
}

interface EndOfCentralDirectory {
  entryCount: number;
  cdSize: number;
  cdOffset: number;
  /** Offset of the (ZIP64) end of central directory record: the central directory ends here. */
  recordOffset: number;
}

async function findEndOfCentralDirectory(
  reader: RandomAccessReader,
): Promise<EndOfCentralDirectory> {
  if (reader.size < EOCD_SIZE) throw new ZipFormatError('it is too short to be a zip archive');
  const tailLength = Math.min(reader.size, EOCD_SIZE + MAX_COMMENT_LENGTH);
  const tailOffset = reader.size - tailLength;
  const tail = await reader.read(tailOffset, tailLength);
  const view = viewOf(tail);

  // The record is 22 bytes plus a comment of up to 64 KB, at the very end. Zip tools look for
  // the last occurrence of its signature, so that occurrence must be the record, and its comment
  // must end exactly where the file does: otherwise a tool could find another record (in the
  // comment, or in bytes after it) and read another list of files than this one.
  let at = -1;
  for (let candidate = tailLength - EOCD_SIZE; candidate >= 0; candidate--) {
    if (view.getUint32(candidate, true) === EOCD_SIGNATURE) {
      at = candidate;
      break;
    }
  }
  if (at < 0) {
    throw new ZipFormatError('it has no end of central directory record, so it is not a zip');
  }
  if (at + EOCD_SIZE + view.getUint16(at + 20, true) !== tailLength) {
    throw new ZipFormatError(
      'its end of central directory record is followed by other bytes, or its comment contains another such record, so zip tools could read it differently',
    );
  }

  const disk = view.getUint16(at + 4, true);
  const cdDisk = view.getUint16(at + 6, true);
  const entriesOnDisk = view.getUint16(at + 8, true);
  const entryCount = view.getUint16(at + 10, true);
  const cdSize = view.getUint32(at + 12, true);
  const cdOffset = view.getUint32(at + 16, true);
  const recordOffset = tailOffset + at;

  const needsZip64 =
    disk === 0xffff ||
    cdDisk === 0xffff ||
    entriesOnDisk === 0xffff ||
    entryCount === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff;
  // Some tools (Python's zipfile, Info-ZIP) read a ZIP64 end record whenever its locator is
  // there, others only when the fields above are saturated: when there is one, both must agree.
  const locator =
    recordOffset < ZIP64_LOCATOR_SIZE
      ? undefined
      : at >= ZIP64_LOCATOR_SIZE
        ? tail.subarray(at - ZIP64_LOCATOR_SIZE, at)
        : await reader.read(recordOffset - ZIP64_LOCATOR_SIZE, ZIP64_LOCATOR_SIZE);
  const hasLocator =
    locator !== undefined && viewOf(locator).getUint32(0, true) === ZIP64_LOCATOR_SIGNATURE;
  if (!hasLocator) {
    if (needsZip64) {
      throw new ZipFormatError('its ZIP64 end of central directory locator is missing');
    }
    if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new ZipFormatError('it is split across several files, which is not supported');
    }
    return { entryCount, cdSize, cdOffset, recordOffset };
  }
  const zip64 = await readZip64End(reader, recordOffset, viewOf(locator));
  const agrees =
    (disk === 0xffff || disk === 0) &&
    (cdDisk === 0xffff || cdDisk === 0) &&
    (entriesOnDisk === 0xffff || entriesOnDisk === zip64.entryCount) &&
    (entryCount === 0xffff || entryCount === zip64.entryCount) &&
    (cdSize === 0xffffffff || cdSize === zip64.cdSize) &&
    (cdOffset === 0xffffffff || cdOffset === zip64.cdOffset);
  if (!agrees) {
    throw new ZipFormatError(
      'its ZIP64 end of central directory record disagrees with its end of central directory record',
    );
  }
  return zip64;
}

async function readZip64End(
  reader: RandomAccessReader,
  eocdOffset: number,
  locator: DataView,
): Promise<EndOfCentralDirectory> {
  if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) > 1) {
    throw new ZipFormatError('it is split across several files, which is not supported');
  }
  const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
  const recordOffset = readUint64(locator, 8);
  if (recordOffset + ZIP64_EOCD_SIZE > locatorOffset) {
    throw new ZipFormatError('its ZIP64 end of central directory record lies outside the archive');
  }
  const record = viewOf(await reader.read(recordOffset, ZIP64_EOCD_SIZE));
  // The record's size field counts the bytes after itself: the record, and any extensible data,
  // must end exactly where the locator starts.
  if (
    record.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE ||
    recordOffset + 12 + readUint64(record, 4) !== locatorOffset
  ) {
    throw new ZipFormatError('its ZIP64 end of central directory record is corrupt');
  }
  const disk = record.getUint32(16, true);
  const cdDisk = record.getUint32(20, true);
  const entriesOnDisk = readUint64(record, 24);
  const entryCount = readUint64(record, 32);
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ZipFormatError('it is split across several files, which is not supported');
  }
  return {
    entryCount,
    cdSize: readUint64(record, 40),
    cdOffset: readUint64(record, 48),
    recordOffset,
  };
}

function parseEntry(
  view: DataView,
  at: number,
  rawName: Uint8Array,
  extra: Uint8Array,
  cdOffset: number,
): ZipEntry {
  const flags = view.getUint16(at + 8, true);
  const method = view.getUint16(at + 10, true);
  const crc = view.getUint32(at + 16, true);
  let compressedSize = view.getUint32(at + 20, true);
  let uncompressedSize = view.getUint32(at + 24, true);
  const diskStart = view.getUint16(at + 34, true);
  const externalAttributes = view.getUint32(at + 38, true);
  let localHeaderOffset = view.getUint32(at + 42, true);

  const fields = extraFields(extra);
  const zip64 = fields.get(ZIP64_EXTRA_FIELD);
  if (
    uncompressedSize === 0xffffffff ||
    compressedSize === 0xffffffff ||
    localHeaderOffset === 0xffffffff ||
    diskStart === 0xffff
  ) {
    // The ZIP64 extra field holds, in this order, exactly the values saturated above.
    if (zip64 === undefined) throw new ZipFormatError('an entry lacks its ZIP64 sizes');
    const zip64View = viewOf(zip64);
    let offset = 0;
    const next64 = () => {
      if (offset + 8 > zip64.length) throw new ZipFormatError('an entry has a corrupt ZIP64 field');
      const value = readUint64(zip64View, offset);
      offset += 8;
      return value;
    };
    if (uncompressedSize === 0xffffffff) uncompressedSize = next64();
    if (compressedSize === 0xffffffff) compressedSize = next64();
    if (localHeaderOffset === 0xffffffff) localHeaderOffset = next64();
    if (diskStart === 0xffff) {
      if (offset + 4 > zip64.length || zip64View.getUint32(offset, true) !== 0) {
        throw new ZipFormatError('it is split across several files, which is not supported');
      }
    }
  } else if (diskStart !== 0) {
    throw new ZipFormatError('it is split across several files, which is not supported');
  }
  if (localHeaderOffset >= cdOffset) {
    throw new ZipFormatError('an entry points outside the archive');
  }

  const decoded = decodeName(rawName, (flags & FLAG_UTF8) !== 0);
  let name = decoded;
  const otherNames: string[] = [];
  const unicodePath = fields.get(UNICODE_PATH_EXTRA_FIELD);
  if (unicodePath !== undefined && unicodePath.length >= 5) {
    // Info-ZIP's Unicode Path field: version 1, the CRC-32 of the raw name, then the UTF-8 name.
    // Info-ZIP's unzip uses it when the CRC matches; either way both names are checked for safety.
    const unicodeName = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      unicodePath.subarray(5),
    );
    const matches =
      unicodePath[0] === 1 && viewOf(unicodePath).getUint32(1, true) === crc32(rawName);
    if (matches) name = unicodeName;
    const other = matches ? decoded : unicodeName;
    if (other !== name) otherNames.push(other);
  }

  // The file type from the external attributes (a Unix mode, or an MS-DOS directory flag), whose
  // host is the high byte of "version made by"; the name's trailing "/" decides otherwise.
  const host = view.getUint16(at + 4, true) >>> 8;
  const kind =
    fileTypeKind(externalAttributes, host) ?? (name.endsWith('/') ? 'directory' : 'file');

  return {
    name,
    otherNames,
    rawName,
    kind,
    flags,
    method,
    crc32: crc,
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
  };
}

/** Extra fields by header id; the first of each id wins, a truncated trailing field is ignored. */
export function extraFields(extra: Uint8Array): Map<number, Uint8Array> {
  const fields = new Map<number, Uint8Array>();
  const view = viewOf(extra);
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = view.getUint16(at, true);
    const size = view.getUint16(at + 2, true);
    if (at + 4 + size > extra.length) break;
    if (!fields.has(id)) fields.set(id, extra.subarray(at + 4, at + 4 + size));
    at += 4 + size;
  }
  return fields;
}

/**
 * Decodes an entry name. Without flag bit 11 the zip format says CP437, but macOS and most Unix
 * tools write UTF-8 without setting the flag, so valid UTF-8 is read as UTF-8.
 */
export function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    let name = '';
    for (const byte of raw)
      name += byte < 0x80 ? String.fromCharCode(byte) : (CP437_HIGH[byte - 0x80] ?? '\ufffd');
    return name;
  }
}

/** Code page 437, bytes 0x80 to 0xFF. */
export const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

export function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** A little-endian 64-bit unsigned value, which must be a safe integer. */
export function readUint64(view: DataView, at: number): number {
  const low = view.getUint32(at, true);
  const high = view.getUint32(at + 4, true);
  if (high > 0x1fffff) throw new ZipFormatError('it declares a size or offset beyond 2^53 bytes');
  return high * 0x100000000 + low;
}
