import { crc32 } from './zip/crc32.js';

/**
 * Just enough of the PNG and JPEG formats to check the icon and screenshots of a Harness Package
 * from their first bytes, without an image decoding library.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_START = [0xff, 0xd8, 0xff] as const;

/**
 * Bytes at the start of a PNG that hold its dimensions: the 8-byte signature, then the IHDR
 * chunk's length (4), type (4), data (13, starting with width and height) and CRC (4).
 */
export const PNG_HEADER_BYTES = 33;

/** Bytes needed to tell a PNG or a JPEG by its signature. */
export const SIGNATURE_BYTES = PNG_SIGNATURE.length;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG_SIGNATURE);
}

/** The JPEG start-of-image marker followed by the first marker's `FF`. */
export function hasJpegSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, JPEG_START);
}

/**
 * Width and height from a PNG's IHDR chunk, or undefined when `bytes` (at least
 * {@link PNG_HEADER_BYTES} of them) do not start like a well-formed PNG: the signature, then an
 * IHDR chunk of 13 bytes whose CRC matches.
 */
export function readPngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.length < PNG_HEADER_BYTES || !hasPngSignature(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(8);
  const type = String.fromCharCode(...bytes.subarray(12, 16));
  if (length !== 13 || type !== 'IHDR') return undefined;
  if (crc32(bytes.subarray(12, 29)) !== view.getUint32(29)) return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
