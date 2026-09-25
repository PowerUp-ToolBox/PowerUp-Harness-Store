import { preview } from '../problem.js';
import {
  decodeName,
  extraFields,
  FLAG_UTF8,
  readUint64,
  UNICODE_PATH_EXTRA_FIELD,
  viewOf,
  ZIP64_EXTRA_FIELD,
  ZipFormatError,
} from './central-directory.js';
import type { CentralDirectory, RandomAccessReader, ZipEntry } from './central-directory.js';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
/** The longest data descriptor: signature, CRC-32 and two 8-byte (ZIP64) sizes. */
const MAX_DATA_DESCRIPTOR_SIZE = 24;

/** General purpose flag bit 0: the entry is encrypted. */
export const FLAG_ENCRYPTED = 0x0001;
/** General purpose flag bit 3: the CRC-32 and sizes follow the data, in a data descriptor. */
export const FLAG_DATA_DESCRIPTOR = 0x0008;

/**
 * Local headers are read through a window of this many bytes: the headers of small files lie
 * next to each other, so one read covers many of them.
 */
const WINDOW = 64 * 1024;

/** What an entry's local header says, next to its central directory record. */
export interface LocalHeader {
  /** Where the entry's data starts. Undefined when the local header cannot be read. */
  dataStart?: number;
  /** The local header's name, decoded, when its bytes differ from the central directory's. */
  name?: string;
  /** Names in the local header's Info-ZIP Unicode Path field that the entry is not known by. */
  otherNames: string[];
  /**
   * Why the entry is inconsistent: its local header disagrees with its central directory record,
   * or its bytes overlap another entry's. Completes "The zip entry is inconsistent: ...".
   */
  inconsistency?: string;
}

export interface LocalLayout {
  /** The local header of each entry of the central directory, in the same order. */
  headers: LocalHeader[];
  /**
   * The first stretch before the central directory that no entry accounts for. Only looked for
   * when the whole central directory was read.
   */
  unlisted?: { offset: number; length: number };
}

/**
 * Reads the local header of every entry and checks that it describes the entry exactly as the
 * central directory does, then that the entries (each local header, its data and its data
 * descriptor) cover everything before the central directory, from the first byte, without gaps
 * or overlaps.
 *
 * Unpackers that read a zip in order (Java's ZipInputStream, streaming unpackers for Node,
 * bsdtar reading a pipe) never look at the central directory: they take names and sizes from
 * the local headers. With these checks, what they find is what the central directory lists, so
 * the archive-safety rules, which work from the listing, hold for them too.
 *
 * One ambiguity remains for entries with a data descriptor (flag bit 3): such an unpacker finds
 * where the data ends from the data itself (the end of the Deflate stream, or the descriptor's
 * signature), and this reader does not inflate every entry to confirm it. The Runtime's own
 * unpacker must therefore read the central directory, as `ArchiveSource` does.
 *
 * @throws only what the reader throws (an I/O error): a problem with the archive is reported in
 *   the result.
 */
export async function readLocalHeaders(
  reader: RandomAccessReader,
  directory: CentralDirectory,
): Promise<LocalLayout> {
  const { entries, centralDirectoryOffset: limit } = directory;
  const window = new WindowedReader(reader, limit);
  // The entries in the order of their local headers (and of the central directory for a tie).
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.localHeaderOffset - b.entry.localHeaderOffset || a.index - b.index);
  const walk: { entry: ZipEntry; index: number; header: LocalHeader; end?: number }[] = [];
  for (const [position, item] of sorted.entries()) {
    const next = sorted[position + 1]?.entry.localHeaderOffset ?? limit;
    walk.push({ ...item, ...(await readLocalHeader(window, item.entry, next, limit)) });
  }

  // Each entry must start where the previous one ends. After an entry whose end is unknown (its
  // local header is unreadable, already reported), the next gap is not reported.
  let covered = 0;
  let endKnown = true;
  let last: ZipEntry | undefined;
  let unlisted: LocalLayout['unlisted'];
  for (const { entry, header, end } of walk) {
    const start = entry.localHeaderOffset;
    if (start < covered && last !== undefined) {
      header.inconsistency ??= `it shares bytes of the archive with ${preview(last.name)}`;
    } else if (start > covered && endKnown && unlisted === undefined) {
      unlisted = { offset: covered, length: start - covered };
    }
    if (end === undefined) {
      endKnown = false;
      covered = Math.max(covered, start + 1);
      last = entry;
    } else if (end > covered || !endKnown) {
      endKnown = true;
      covered = Math.max(covered, end);
      last = entry;
    }
  }
  if (covered < limit && endKnown && unlisted === undefined) {
    unlisted = { offset: covered, length: limit - covered };
  }
  // Entries past the listing limit were never read, so their bytes would look unlisted.
  if (directory.truncated) unlisted = undefined;

  const headers: LocalHeader[] = [];
  for (const { index, header } of walk) headers[index] = header;
  return unlisted === undefined ? { headers } : { headers, unlisted };
}

async function readLocalHeader(
  window: WindowedReader,
  entry: ZipEntry,
  next: number,
  limit: number,
): Promise<{ header: LocalHeader; end?: number }> {
  const header: LocalHeader = { otherNames: [] };
  const offset = entry.localHeaderOffset;
  const fail = (inconsistency: string) => {
    header.inconsistency = inconsistency;
    return { header };
  };
  if (offset + LOCAL_HEADER_SIZE > limit) {
    return fail('there is no local header where the central directory says');
  }
  const fixed = viewOf(await window.read(offset, LOCAL_HEADER_SIZE));
  if (fixed.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
    return fail('there is no local header where the central directory says');
  }
  const flags = fixed.getUint16(6, true);
  const method = fixed.getUint16(8, true);
  const crc = fixed.getUint32(14, true);
  const compressedField = fixed.getUint32(18, true);
  const sizeField = fixed.getUint32(22, true);
  const nameLength = fixed.getUint16(26, true);
  const extraLength = fixed.getUint16(28, true);
  const dataStart = offset + LOCAL_HEADER_SIZE + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > limit) return fail('its data runs into the central directory');

  const variable = await window.read(offset + LOCAL_HEADER_SIZE, nameLength + extraLength);
  const rawName = variable.subarray(0, nameLength);
  const fields = extraFields(variable.subarray(nameLength));
  header.dataStart = dataStart;

  if (!sameBytes(rawName, entry.rawName)) {
    header.name = decodeName(rawName, (flags & FLAG_UTF8) !== 0);
  }
  const unicodePath = fields.get(UNICODE_PATH_EXTRA_FIELD);
  if (unicodePath !== undefined && unicodePath.length >= 5) {
    // Unpackers that read in order take the Unicode Path field from the local header.
    const unicodeName = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      unicodePath.subarray(5),
    );
    if (unicodeName !== entry.name && !entry.otherNames.includes(unicodeName)) {
      header.otherNames.push(unicodeName);
    }
  }

  const inconsistency =
    method !== entry.method
      ? `its local header gives compression method ${String(method)}, its central directory record ${String(entry.method)}`
      : (flags & FLAG_ENCRYPTED) !== (entry.flags & FLAG_ENCRYPTED)
        ? 'its local header and its central directory record disagree about encryption'
        : compareSizes(entry, flags, crc, compressedField, sizeField, fields);
  if (inconsistency !== undefined) return fail(inconsistency);

  if ((flags & FLAG_DATA_DESCRIPTOR) === 0) return { header, end: dataEnd };
  const descriptor = await window.read(
    dataEnd,
    Math.min(MAX_DATA_DESCRIPTOR_SIZE, limit - dataEnd),
  );
  const length = descriptorLength(descriptor, entry, dataEnd, next);
  if (length === undefined) {
    return fail('its data descriptor does not match its central directory record');
  }
  return { header, end: dataEnd + length };
}

/**
 * Compares the CRC-32 and sizes of a local header with the central directory record. With a
 * data descriptor (flag bit 3) the local header may leave them 0, as streaming writers do.
 */
function compareSizes(
  entry: ZipEntry,
  flags: number,
  crc: number,
  compressedField: number,
  sizeField: number,
  fields: Map<number, Uint8Array>,
): string | undefined {
  let compressedSize = compressedField;
  let size = sizeField;
  if (compressedField === 0xffffffff || sizeField === 0xffffffff) {
    // In a local header, the ZIP64 field holds both sizes: uncompressed, then compressed.
    const zip64 = fields.get(ZIP64_EXTRA_FIELD);
    if (zip64 === undefined || zip64.length < 16) {
      return 'its local header lacks the ZIP64 sizes it refers to';
    }
    try {
      size = readUint64(viewOf(zip64), 0);
      compressedSize = readUint64(viewOf(zip64), 8);
    } catch (error) {
      if (error instanceof ZipFormatError) return 'its local header has corrupt ZIP64 sizes';
      throw error;
    }
  }
  const deferred = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
  const agrees = (local: number, central: number) => local === central || (deferred && local === 0);
  if (!agrees(crc, entry.crc32)) {
    return 'its local header gives another CRC-32 than its central directory record';
  }
  if (!agrees(compressedSize, entry.compressedSize)) {
    return 'its local header gives another compressed size than its central directory record';
  }
  if (!agrees(size, entry.uncompressedSize)) {
    return 'its local header gives another size than its central directory record';
  }
  return undefined;
}

/**
 * The length of the data descriptor at the start of `bytes`: with or without its signature, with
 * 4- or 8-byte sizes, whichever gives the central directory's CRC-32 and sizes. When several do,
 * the one that ends where the next entry starts.
 */
function descriptorLength(
  bytes: Uint8Array,
  entry: ZipEntry,
  at: number,
  next: number,
): number | undefined {
  const view = viewOf(bytes);
  const signed = bytes.length >= 4 && view.getUint32(0, true) === DATA_DESCRIPTOR_SIGNATURE;
  const matching: number[] = [];
  for (const base of signed ? [4, 0] : [0]) {
    for (const wide of [false, true]) {
      const length = base + 4 + (wide ? 16 : 8);
      if (length > bytes.length) continue;
      const crc = view.getUint32(base, true);
      let compressedSize: number;
      let size: number;
      try {
        compressedSize = wide ? readUint64(view, base + 4) : view.getUint32(base + 4, true);
        size = wide ? readUint64(view, base + 12) : view.getUint32(base + 8, true);
      } catch (error) {
        if (error instanceof ZipFormatError) continue;
        throw error;
      }
      if (
        crc === entry.crc32 &&
        compressedSize === entry.compressedSize &&
        size === entry.uncompressedSize
      ) {
        matching.push(length);
      }
    }
  }
  return matching.find((length) => at + length === next) ?? matching[0];
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Reads through a window of {@link WINDOW} bytes, so neighbouring local headers cost one read of
 * the archive, never reading at or past `limit` (the central directory).
 */
class WindowedReader {
  readonly #reader: RandomAccessReader;
  readonly #limit: number;
  #start = 0;
  #bytes: Uint8Array = new Uint8Array(0);

  constructor(reader: RandomAccessReader, limit: number) {
    this.#reader = reader;
    this.#limit = limit;
  }

  /** Reads `length` bytes at `offset`; `offset + length` must not pass the limit. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < this.#start || offset + length > this.#start + this.#bytes.length) {
      const size = Math.min(Math.max(length, WINDOW), this.#limit - offset);
      this.#bytes = await this.#reader.read(offset, size);
      this.#start = offset;
    }
    const at = offset - this.#start;
    return this.#bytes.subarray(at, at + length);
  }
}
