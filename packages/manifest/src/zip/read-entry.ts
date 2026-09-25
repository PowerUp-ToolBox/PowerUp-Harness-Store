import { Inflate } from 'fflate';
import { crc32 } from './crc32.js';
import { viewOf, ZipFormatError } from './central-directory.js';
import type { RandomAccessReader, ZipEntry } from './central-directory.js';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_HEADER_SIZE = 30;

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

/**
 * Compressed bytes are inflated a slice at a time, so a small slice of a "zip bomb" cannot expand
 * into more than about a thousand times its size (Deflate's maximum ratio) before the limits
 * below are checked. The first slices are small because most reads only need a few bytes.
 */
const FIRST_SLICE = 1024;
const MAX_SLICE = 16 * 1024;

/**
 * Reads an entry's content into memory, up to `maxBytes` bytes. Nothing is written anywhere.
 *
 * The local header must name the same file as the central directory (a mismatch is a classic way
 * to make two unpackers see two different files). When the whole entry is read, its size and
 * CRC-32 must match the central directory; inflating stops as soon as it produces more bytes than
 * declared, so a lying entry costs at most one slice of work.
 *
 * @throws {ZipFormatError} when the entry cannot be read.
 */
export async function readEntry(
  reader: RandomAccessReader,
  entry: ZipEntry,
  centralDirectoryOffset: number,
  maxBytes: number,
): Promise<Uint8Array> {
  if (entry.flags & 0x0001) throw new ZipFormatError('it is encrypted');
  const dataStart = await locateData(reader, entry, centralDirectoryOffset);
  const wanted = Math.min(maxBytes, entry.uncompressedSize);

  if (entry.method === METHOD_STORED) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new ZipFormatError('its stored size does not match its size');
    }
    const data = await reader.read(dataStart, wanted);
    if (wanted === entry.uncompressedSize && crc32(data) !== entry.crc32) {
      throw new ZipFormatError('its content is corrupt (CRC-32 mismatch)');
    }
    // A copy: the reader may return a view of the caller's archive bytes.
    return new Uint8Array(data);
  }
  if (entry.method !== METHOD_DEFLATE) {
    throw new ZipFormatError(`it uses compression method ${String(entry.method)}`);
  }
  return inflateEntry(reader, entry, dataStart, maxBytes);
}

async function locateData(
  reader: RandomAccessReader,
  entry: ZipEntry,
  centralDirectoryOffset: number,
): Promise<number> {
  const offset = entry.localHeaderOffset;
  if (offset + LOCAL_HEADER_SIZE > centralDirectoryOffset) {
    throw new ZipFormatError('its local header lies outside the archive');
  }
  const header = viewOf(await reader.read(offset, LOCAL_HEADER_SIZE));
  if (header.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) {
    throw new ZipFormatError('its local header is corrupt');
  }
  const nameLength = header.getUint16(26, true);
  const extraLength = header.getUint16(28, true);
  const dataStart = offset + LOCAL_HEADER_SIZE + nameLength + extraLength;
  if (dataStart + entry.compressedSize > centralDirectoryOffset) {
    throw new ZipFormatError('its data runs past the end of the archive');
  }
  const localName = await reader.read(offset + LOCAL_HEADER_SIZE, nameLength);
  if (!sameBytes(localName, entry.rawName)) {
    throw new ZipFormatError('its local header names a different file than the central directory');
  }
  return dataStart;
}

async function inflateEntry(
  reader: RandomAccessReader,
  entry: ZipEntry,
  dataStart: number,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let produced = 0;
  let crc = 0;
  const inflater = new Inflate((chunk) => {
    chunks.push(chunk);
    produced += chunk.length;
    crc = crc32(chunk, crc);
  });

  // A prefix read stops once it has enough bytes; a full read is checked against the size and CRC.
  const prefixOnly = maxBytes < entry.uncompressedSize;
  let consumed = 0;
  let slice = FIRST_SLICE;
  while (consumed < entry.compressedSize) {
    const length = Math.min(slice, entry.compressedSize - consumed);
    const input = await reader.read(dataStart + consumed, length);
    consumed += length;
    try {
      inflater.push(input, consumed === entry.compressedSize);
    } catch {
      throw new ZipFormatError('its compressed data is corrupt');
    }
    if (produced > entry.uncompressedSize) {
      throw new ZipFormatError('it inflates to more than its declared size');
    }
    if (prefixOnly && produced >= maxBytes) return concat(chunks, maxBytes);
    slice = Math.min(slice * 2, MAX_SLICE);
  }
  if (produced !== entry.uncompressedSize) {
    throw new ZipFormatError('it inflates to less than its declared size');
  }
  if (crc !== entry.crc32) throw new ZipFormatError('its content is corrupt (CRC-32 mismatch)');
  return concat(chunks, maxBytes);
}

function concat(chunks: readonly Uint8Array[], maxBytes: number): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(Math.min(total, maxBytes));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= out.length) break;
    const part = chunk.subarray(0, out.length - at);
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
