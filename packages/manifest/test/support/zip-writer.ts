/**
 * A zip writer for tests. Unlike a real zip tool it can write everything a hostile archive may
 * hold: `..` and absolute names, symbolic links, local headers that disagree with the central
 * directory, entries the central directory does not list (or lists twice, overlapping), lying
 * sizes and CRCs, data descriptors, ZIP64 fields, and large runs of zeros (a sparse entry, or a
 * gap before the archive) that are never allocated.
 */
import { closeSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import type { RandomAccessReader } from '../../src/index.js';

/** Overrides for an entry's local header, which otherwise repeats the central directory. */
export interface LocalHeaderSpec {
  method?: number;
  flags?: number;
  crc?: number;
  compressedSize?: number;
  size?: number;
  /** Extra fields of the local header (raw bytes), after any ZIP64 field. */
  extra?: Uint8Array;
}

/** A data descriptor after the entry's data (general purpose flag bit 3), as streaming zip tools write. */
export interface DataDescriptorSpec {
  /** Start with the optional signature `PK\x07\x08` (default true). */
  signature?: boolean;
  /** 8-byte sizes, as for ZIP64 (default false). */
  wide?: boolean;
  /** Keep the CRC-32 and sizes in the local header too, as Info-ZIP does for some (default false: zeros). */
  localSizes?: boolean;
  /** Written instead of the real values. */
  crc?: number;
  compressedSize?: number;
  size?: number;
}

export interface ZipEntrySpec {
  name: string;
  /** Content; a string is UTF-8. Ignored for directories (names ending in `/`). */
  data?: Uint8Array | string;
  /** Content of this many zero bytes, stored, never allocated (for archives over 500 MB). */
  zeros?: number;
  /** 8 (Deflate, the default for files with content) or 0 (stored), or any other number. */
  method?: number;
  /** Unix mode written in the high 16 bits of the external attributes, with host "Unix". */
  unixMode?: number;
  /** Host byte of "version made by" (3 = Unix, 0 = MS-DOS, 10 = NTFS). Default 3. */
  host?: number;
  /** Extra general purpose flags (bit 0: encrypted). UTF-8 names get bit 11 automatically. */
  flags?: number;
  /** Name bytes to write instead of the UTF-8 of `name` (then bit 11 is not set). */
  rawName?: Uint8Array;
  /** Name written in the local header instead of `name`. */
  localName?: string;
  /** Other values written in the local header. */
  local?: LocalHeaderSpec;
  /** Write a data descriptor after the data. */
  dataDescriptor?: boolean | DataDescriptorSpec;
  /** Written instead of the real CRC-32. */
  crc?: number;
  /** Declared uncompressed size instead of the real one. */
  declaredSize?: number;
  /** Compressed bytes written as they are, instead of compressing `data`. */
  compressedData?: Uint8Array;
  /** Write sizes and offset in a ZIP64 extra field. */
  zip64?: boolean;
  /** More central directory extra fields (raw bytes). */
  extra?: Uint8Array;
  /** Write the local header and data, but leave the entry out of the central directory. */
  unlisted?: boolean;
  /**
   * List the entry in the central directory at this local header offset, without writing a local
   * header or data for it (point it into another entry's data, or at another entry).
   */
  listedAt?: number;
}

export interface ZipOptions {
  /** The archive starts this many bytes into the file (the gap reads as zeros). */
  offset?: number;
  /** End with a ZIP64 end of central directory record and locator. */
  zip64End?: boolean;
  comment?: string;
}

const encoder = new TextEncoder();

function bytesOf(data: Uint8Array | string | undefined): Uint8Array {
  if (data === undefined) return new Uint8Array(0);
  return typeof data === 'string' ? encoder.encode(data) : data;
}

/** A run of zero bytes, kept as a length. */
interface Zeros {
  zeros: number;
}
type Segment = Uint8Array | Zeros;

/** Appends little-endian values and runs of zeros. */
class ByteWriter {
  #segments: Segment[] = [];
  #buffer = new Uint8Array(1024);
  #view = new DataView(this.#buffer.buffer);
  #used = 0;
  length = 0;
  #room(size: number) {
    if (this.#used + size <= this.#buffer.length) return;
    const grown = new Uint8Array(Math.max(this.#buffer.length * 2, this.#used + size));
    grown.set(this.#buffer.subarray(0, this.#used));
    this.#buffer = grown;
    this.#view = new DataView(grown.buffer);
  }
  #advance(size: number) {
    this.#used += size;
    this.length += size;
  }
  u16(value: number) {
    this.#room(2);
    this.#view.setUint16(this.#used, value, true);
    this.#advance(2);
  }
  u32(value: number) {
    this.#room(4);
    this.#view.setUint32(this.#used, value >>> 0, true);
    this.#advance(4);
  }
  u64(value: number) {
    this.u32(value % 0x100000000);
    this.u32(Math.floor(value / 0x100000000));
  }
  push(bytes: Uint8Array) {
    this.#room(bytes.length);
    this.#buffer.set(bytes, this.#used);
    this.#advance(bytes.length);
  }
  zeros(count: number) {
    this.#flush();
    this.#segments.push({ zeros: count });
    this.length += count;
  }
  append(other: ByteWriter) {
    for (const segment of other.segments()) {
      if (segment instanceof Uint8Array) this.push(segment);
      else this.zeros(segment.zeros);
    }
  }
  #flush() {
    if (this.#used === 0) return;
    this.#segments.push(this.#buffer.slice(0, this.#used));
    this.#buffer = new Uint8Array(1024);
    this.#view = new DataView(this.#buffer.buffer);
    this.#used = 0;
  }
  segments(): Segment[] {
    this.#flush();
    return [...this.#segments];
  }
  /** The bytes written, with runs of zeros allocated. */
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const segment of this.segments()) {
      if (segment instanceof Uint8Array) {
        out.set(segment, at);
        at += segment.length;
      } else at += segment.zeros;
    }
    return out;
  }
}

/** An extra field: header id, size, data. */
export function extraField(id: number, data: Uint8Array): Uint8Array {
  const out = new ByteWriter();
  out.u16(id);
  out.u16(data.length);
  out.push(data);
  return out.bytes();
}

const zeroCrcs = new Map<number, number>();

/** CRC-32 of `count` zero bytes, computed a megabyte at a time. */
function crcOfZeros(count: number): number {
  const known = zeroCrcs.get(count);
  if (known !== undefined) return known;
  const chunk = new Uint8Array(1 << 20);
  let crc = 0;
  for (let left = count; left > 0; left -= chunk.length) {
    crc = crc32(chunk.subarray(0, Math.min(left, chunk.length)), crc);
  }
  zeroCrcs.set(count, crc);
  return crc;
}

/** Everything about an entry that its local header and central directory record repeat. */
interface Prepared {
  spec: ZipEntrySpec;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  /** The data as stored (compressed), or a run of zeros. */
  stored: Uint8Array | Zeros;
  storedLength: number;
  crc: number;
  size: number;
  zip64: boolean;
  descriptor: DataDescriptorSpec | undefined;
}

function prepare(spec: ZipEntrySpec): Prepared {
  const isDirectory = spec.name.endsWith('/');
  const zeros = spec.zeros;
  const content = isDirectory || zeros !== undefined ? new Uint8Array(0) : bytesOf(spec.data);
  const length = zeros ?? content.length;
  const method = spec.method ?? (zeros === undefined && content.length > 0 ? 8 : 0);
  const stored: Uint8Array | Zeros =
    zeros !== undefined
      ? { zeros }
      : (spec.compressedData ?? (method === 8 ? deflateRawSync(content) : content));
  const descriptor =
    spec.dataDescriptor === true
      ? {}
      : spec.dataDescriptor === false
        ? undefined
        : spec.dataDescriptor;
  const utf8 = spec.rawName === undefined && /[\u0080-￿]/.test(spec.name) ? 0x0800 : 0;
  return {
    spec,
    nameBytes: spec.rawName ?? encoder.encode(spec.name),
    flags: (spec.flags ?? 0) | utf8 | (descriptor === undefined ? 0 : 0x0008),
    method,
    stored,
    storedLength: stored instanceof Uint8Array ? stored.length : stored.zeros,
    crc: spec.crc ?? (zeros !== undefined ? crcOfZeros(zeros) : crc32(content)),
    size: spec.declaredSize ?? length,
    zip64: spec.zip64 === true,
    descriptor,
  };
}

/** The local header, data and data descriptor of an entry. */
function writeLocal(out: ByteWriter, entry: Prepared) {
  const { spec, descriptor, zip64 } = entry;
  const local = spec.local ?? {};
  const deferred = descriptor !== undefined && descriptor.localSizes !== true;
  const crc = local.crc ?? (deferred ? 0 : entry.crc);
  const compressedSize = local.compressedSize ?? (deferred ? 0 : entry.storedLength);
  const size = local.size ?? (deferred ? 0 : entry.size);
  const nameBytes = spec.localName === undefined ? entry.nameBytes : encoder.encode(spec.localName);
  const extra = concat([
    zip64 ? extraField(0x0001, u64s(size, compressedSize)) : new Uint8Array(0),
    local.extra ?? new Uint8Array(0),
  ]);
  out.u32(0x04034b50);
  out.u16(zip64 ? 45 : 20);
  out.u16(local.flags ?? entry.flags);
  out.u16(local.method ?? entry.method);
  out.u16(0); // time
  out.u16(0x21); // date: 1980-01-01
  out.u32(crc);
  out.u32(zip64 ? 0xffffffff : compressedSize);
  out.u32(zip64 ? 0xffffffff : size);
  out.u16(nameBytes.length);
  out.u16(extra.length);
  out.push(nameBytes);
  out.push(extra);
  if (entry.stored instanceof Uint8Array) out.push(entry.stored);
  else out.zeros(entry.stored.zeros);
  if (descriptor !== undefined) {
    if (descriptor.signature !== false) out.u32(0x08074b50);
    out.u32(descriptor.crc ?? entry.crc);
    for (const value of [
      descriptor.compressedSize ?? entry.storedLength,
      descriptor.size ?? entry.size,
    ]) {
      if (descriptor.wide === true) out.u64(value);
      else out.u32(value);
    }
  }
}

/** The local header, data and data descriptor of an entry on its own, to embed in other data. */
export function localRecord(spec: ZipEntrySpec): Uint8Array {
  const out = new ByteWriter();
  writeLocal(out, prepare(spec));
  return out.bytes();
}

/** Writes a zip. Offsets inside it count from `options.offset`, which is not written. */
function writeZip(entries: readonly ZipEntrySpec[], options: ZipOptions): ByteWriter {
  const base = options.offset ?? 0;
  const body = new ByteWriter();
  const central = new ByteWriter();
  let listed = 0;

  for (const spec of entries) {
    const entry = prepare(spec);
    const isDirectory = spec.name.endsWith('/');
    const offset = spec.listedAt ?? base + body.length;
    if (spec.listedAt === undefined) writeLocal(body, entry);
    if (spec.unlisted === true) continue;
    listed++;

    const { zip64 } = entry;
    const mode = spec.unixMode ?? (isDirectory ? 0o40755 : 0o100644);
    const externalAttributes = ((mode << 16) >>> 0) | (isDirectory ? 0x10 : 0);
    const centralExtra = concat([
      zip64 ? extraField(0x0001, u64s(entry.size, entry.storedLength, offset)) : new Uint8Array(0),
      spec.extra ?? new Uint8Array(0),
    ]);
    central.u32(0x02014b50);
    central.u16(((spec.host ?? 3) << 8) | 20);
    central.u16(zip64 ? 45 : 20);
    central.u16(entry.flags);
    central.u16(entry.method);
    central.u16(0);
    central.u16(0x21);
    central.u32(entry.crc);
    central.u32(zip64 ? 0xffffffff : entry.storedLength);
    central.u32(zip64 ? 0xffffffff : entry.size);
    central.u16(entry.nameBytes.length);
    central.u16(centralExtra.length);
    central.u16(0); // comment length
    central.u16(0); // disk
    central.u16(0); // internal attributes
    central.u32(externalAttributes);
    central.u32(zip64 ? 0xffffffff : offset);
    central.push(entry.nameBytes);
    central.push(centralExtra);
  }

  const out = new ByteWriter();
  out.append(body);
  const cdOffset = base + out.length;
  out.append(central);
  const comment = encoder.encode(options.comment ?? '');
  if (options.zip64End) {
    const recordOffset = base + out.length;
    out.u32(0x06064b50);
    out.u64(44);
    out.u16((3 << 8) | 45);
    out.u16(45);
    out.u32(0);
    out.u32(0);
    out.u64(listed);
    out.u64(listed);
    out.u64(central.length);
    out.u64(cdOffset);
    out.u32(0x07064b50);
    out.u32(0);
    out.u64(recordOffset);
    out.u32(1);
  }
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(options.zip64End ? 0xffff : listed);
  out.u16(options.zip64End ? 0xffff : listed);
  out.u32(options.zip64End ? 0xffffffff : central.length);
  out.u32(options.zip64End ? 0xffffffff : cdOffset);
  out.u16(comment.length);
  out.push(comment);
  return out;
}

/** Builds a zip in memory. Offsets inside it count from `options.offset` (see {@link sparseReader}). */
export function buildZip(entries: readonly ZipEntrySpec[], options: ZipOptions = {}): Uint8Array {
  const out = writeZip(entries, options);
  if (out.segments().some((segment) => !(segment instanceof Uint8Array))) {
    throw new Error('buildZip() allocates everything: use zipReader() for entries of zeros');
  }
  return out.bytes();
}

/**
 * A reader over the zip, with `options.offset` zeros before it and every entry of `zeros`
 * left unallocated: an archive of any size. Counts its reads.
 */
export function zipReader(
  entries: readonly ZipEntrySpec[],
  options: ZipOptions = {},
): RandomAccessReader & { reads: number; bytesRead: number } {
  const segments = writeZip(entries, options).segments();
  if ((options.offset ?? 0) > 0) segments.unshift({ zeros: options.offset ?? 0 });
  return segmentReader(segments);
}

/** Writes the zip to a file, leaving runs of zeros as holes (a sparse file where supported). */
export function writeZipFile(
  path: string,
  entries: readonly ZipEntrySpec[],
  options: ZipOptions = {},
): number {
  const segments = writeZip(entries, options).segments();
  if ((options.offset ?? 0) > 0) segments.unshift({ zeros: options.offset ?? 0 });
  const fd = openSync(path, 'w');
  try {
    let at = 0;
    for (const segment of segments) {
      if (segment instanceof Uint8Array) {
        writeSync(fd, segment, 0, segment.length, at);
        at += segment.length;
      } else {
        at += segment.zeros;
        ftruncateSync(fd, at);
      }
    }
    return at;
  } finally {
    closeSync(fd);
  }
}

/**
 * A reader over `zip` placed `offset` bytes into a file whose first `offset` bytes are zeros
 * (a gap before the archive, which no entry accounts for). Counts its reads.
 */
export function sparseReader(
  zip: Uint8Array,
  offset: number,
): RandomAccessReader & { reads: number; bytesRead: number } {
  return segmentReader(offset > 0 ? [{ zeros: offset }, zip] : [zip]);
}

function segmentReader(
  segments: readonly Segment[],
): RandomAccessReader & { reads: number; bytesRead: number } {
  const starts: number[] = [];
  let size = 0;
  for (const segment of segments) {
    starts.push(size);
    size += segment instanceof Uint8Array ? segment.length : segment.zeros;
  }
  const reader = {
    size,
    reads: 0,
    bytesRead: 0,
    read(at: number, length: number) {
      reader.reads++;
      reader.bytesRead += length;
      const out = new Uint8Array(length);
      segments.forEach((segment, index) => {
        if (!(segment instanceof Uint8Array)) return;
        const segmentStart = starts[index] ?? 0;
        const start = Math.max(at, segmentStart);
        const end = Math.min(at + length, segmentStart + segment.length);
        if (end > start) {
          out.set(segment.subarray(start - segmentStart, end - segmentStart), start - at);
        }
      });
      return Promise.resolve(out);
    },
  };
  return reader;
}

function u64s(...values: number[]): Uint8Array {
  const out = new ByteWriter();
  for (const value of values) out.u64(value);
  return out.bytes();
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
