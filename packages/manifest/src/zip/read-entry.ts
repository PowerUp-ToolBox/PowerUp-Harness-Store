import { Inflate } from 'fflate';
import { crc32 } from './crc32.js';
import { ZipFormatError } from './central-directory.js';
import type { RandomAccessReader, ZipEntry } from './central-directory.js';
import { FLAG_ENCRYPTED } from './local-headers.js';

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

/**
 * Compressed bytes are inflated a slice at a time, so a small slice of a "zip bomb" cannot expand
 * into more than about a thousand times its size (Deflate's maximum ratio) before the limits
 * below are checked. The first slices are small because most reads only need a few bytes: a read
 * of `n` bytes (the first `n`, or a whole entry of `n` bytes) starts with a slice of `n`
 * compressed bytes (at least {@link MIN_SLICE}, at most {@link FIRST_SLICE}), doubling while more
 * are needed, so checking a signature costs kilobytes of inflating, not a megabyte, however well
 * the entry compresses and whatever size it declares.
 */
const MIN_SLICE = 16;
const FIRST_SLICE = 1024;
const MAX_SLICE = 16 * 1024;

/**
 * Reads an entry's content into memory, up to `maxBytes` bytes. Nothing is written anywhere.
 * `dataStart` comes from the entry's local header, already checked against the central directory
 * (see readLocalHeaders()).
 *
 * When the whole entry is read, its size and CRC-32 must match the central directory; inflating
 * stops as soon as it produces more bytes than declared, so a lying entry costs at most one slice
 * of work. A read of the first bytes only is not checked against the CRC-32.
 *
 * @throws {ZipFormatError} when the entry cannot be read.
 */
export async function readEntry(
  reader: RandomAccessReader,
  entry: ZipEntry,
  dataStart: number,
  maxBytes: number,
): Promise<Uint8Array> {
  if (entry.flags & FLAG_ENCRYPTED) throw new ZipFormatError('it is encrypted');
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

async function inflateEntry(
  reader: RandomAccessReader,
  entry: ZipEntry,
  dataStart: number,
  maxBytes: number,
): Promise<Uint8Array> {
  // A prefix read stops once it has enough bytes; a full read is checked against the size and CRC.
  const prefixOnly = maxBytes < entry.uncompressedSize;
  const chunks: Uint8Array[] = [];
  let produced = 0;
  let crc = 0;
  const inflater = new Inflate((chunk) => {
    chunks.push(chunk);
    produced += chunk.length;
    if (!prefixOnly) crc = crc32(chunk, crc);
  });

  // Start with about as many compressed bytes as bytes are wanted: an entry that inflates far
  // beyond its declared size is caught after a small slice too.
  let consumed = 0;
  const wanted = Math.min(maxBytes, entry.uncompressedSize);
  let slice = Math.min(FIRST_SLICE, Math.max(MIN_SLICE, wanted));
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
