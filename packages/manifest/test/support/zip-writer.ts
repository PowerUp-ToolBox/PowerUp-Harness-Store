/**
 * A zip writer for tests. Unlike a real zip tool it can write everything a hostile archive may
 * hold: `..` and absolute names, symbolic links, names that differ between the local header and
 * the central directory, lying sizes and CRCs, ZIP64 fields, and data placed after a gap of any
 * size (without allocating the gap).
 */
import { crc32, deflateRawSync } from 'node:zlib';
import type { RandomAccessReader } from '../../src/index.js';

export interface ZipEntrySpec {
  name: string;
  /** Content; a string is UTF-8. Ignored for directories (names ending in `/`). */
  data?: Uint8Array | string;
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

/** Appends little-endian values to a growing buffer. */
class ByteWriter {
  #buffer = new Uint8Array(1024);
  #view = new DataView(this.#buffer.buffer);
  length = 0;
  #room(size: number) {
    if (this.length + size <= this.#buffer.length) return;
    const grown = new Uint8Array(Math.max(this.#buffer.length * 2, this.length + size));
    grown.set(this.#buffer.subarray(0, this.length));
    this.#buffer = grown;
    this.#view = new DataView(grown.buffer);
  }
  u16(value: number) {
    this.#room(2);
    this.#view.setUint16(this.length, value, true);
    this.length += 2;
  }
  u32(value: number) {
    this.#room(4);
    this.#view.setUint32(this.length, value >>> 0, true);
    this.length += 4;
  }
  u64(value: number) {
    this.u32(value % 0x100000000);
    this.u32(Math.floor(value / 0x100000000));
  }
  push(bytes: Uint8Array) {
    this.#room(bytes.length);
    this.#buffer.set(bytes, this.length);
    this.length += bytes.length;
  }
  bytes(): Uint8Array {
    return this.#buffer.slice(0, this.length);
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

/** Builds a zip. Offsets inside it count from `options.offset`. */
export function buildZip(entries: readonly ZipEntrySpec[], options: ZipOptions = {}): Uint8Array {
  const base = options.offset ?? 0;
  const body = new ByteWriter();
  const central = new ByteWriter();

  for (const spec of entries) {
    const isDirectory = spec.name.endsWith('/');
    const content = isDirectory ? new Uint8Array(0) : bytesOf(spec.data);
    const method = spec.method ?? (content.length > 0 ? 8 : 0);
    const stored = spec.compressedData ?? (method === 8 ? deflateRawSync(content) : content);
    const crc = spec.crc ?? crc32(content);
    const size = spec.declaredSize ?? content.length;
    const nameBytes = spec.rawName ?? encoder.encode(spec.name);
    const localNameBytes =
      spec.localName === undefined ? nameBytes : encoder.encode(spec.localName);
    const utf8 = spec.rawName === undefined && /[\u0080-\uffff]/.test(spec.name) ? 0x0800 : 0;
    const flags = (spec.flags ?? 0) | utf8;
    const mode = spec.unixMode ?? (isDirectory ? 0o40755 : 0o100644);
    const externalAttributes = ((mode << 16) >>> 0) | (isDirectory ? 0x10 : 0);
    const offset = base + body.length;

    const zip64 = spec.zip64 === true;
    const localExtra = zip64 ? extraField(0x0001, u64s(size, stored.length)) : new Uint8Array(0);
    body.u32(0x04034b50);
    body.u16(zip64 ? 45 : 20);
    body.u16(flags);
    body.u16(method);
    body.u16(0); // time
    body.u16(0x21); // date: 1980-01-01
    body.u32(crc);
    body.u32(zip64 ? 0xffffffff : stored.length);
    body.u32(zip64 ? 0xffffffff : size);
    body.u16(localNameBytes.length);
    body.u16(localExtra.length);
    body.push(localNameBytes);
    body.push(localExtra);
    body.push(stored);

    const centralExtra = Buffer.concat([
      zip64 ? extraField(0x0001, u64s(size, stored.length, offset)) : new Uint8Array(0),
      spec.extra ?? new Uint8Array(0),
    ]);
    central.u32(0x02014b50);
    central.u16(((spec.host ?? 3) << 8) | 20);
    central.u16(zip64 ? 45 : 20);
    central.u16(flags);
    central.u16(method);
    central.u16(0);
    central.u16(0x21);
    central.u32(crc);
    central.u32(zip64 ? 0xffffffff : stored.length);
    central.u32(zip64 ? 0xffffffff : size);
    central.u16(nameBytes.length);
    central.u16(centralExtra.length);
    central.u16(0); // comment length
    central.u16(0); // disk
    central.u16(0); // internal attributes
    central.u32(externalAttributes);
    central.u32(zip64 ? 0xffffffff : offset);
    central.push(nameBytes);
    central.push(centralExtra);
  }

  const out = new ByteWriter();
  out.push(body.bytes());
  const cdOffset = base + out.length;
  out.push(central.bytes());
  const comment = encoder.encode(options.comment ?? '');
  if (options.zip64End) {
    const recordOffset = base + out.length;
    out.u32(0x06064b50);
    out.u64(44);
    out.u16((3 << 8) | 45);
    out.u16(45);
    out.u32(0);
    out.u32(0);
    out.u64(entries.length);
    out.u64(entries.length);
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
  out.u16(options.zip64End ? 0xffff : entries.length);
  out.u16(options.zip64End ? 0xffff : entries.length);
  out.u32(options.zip64End ? 0xffffffff : central.length);
  out.u32(options.zip64End ? 0xffffffff : cdOffset);
  out.u16(comment.length);
  out.push(comment);
  return out.bytes();
}

function u64s(...values: number[]): Uint8Array {
  const out = new ByteWriter();
  for (const value of values) out.u64(value);
  return out.bytes();
}

/**
 * A reader over `zip` placed `offset` bytes into a file whose first `offset` bytes are zeros:
 * a sparse archive of any size, for the 500 MB limit, without allocating it.
 */
export function sparseReader(
  zip: Uint8Array,
  offset: number,
): RandomAccessReader & { reads: number } {
  const reader = {
    size: offset + zip.length,
    reads: 0,
    read(at: number, length: number) {
      reader.reads++;
      const out = new Uint8Array(length);
      const start = Math.max(at, offset);
      const end = Math.min(at + length, offset + zip.length);
      if (end > start) out.set(zip.subarray(start - offset, end - offset), start - at);
      return Promise.resolve(out);
    },
  };
  return reader;
}
