/** Small, valid images for tests, made without an image library. */
import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { fixturesRoot } from '../helpers.js';

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG: 1-bit greyscale, all black, `width` × `height` pixels. */
export function png(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(1, 8); // bit depth
  header.writeUInt8(0, 9); // colour type: greyscale
  const row = Buffer.alloc(1 + Math.ceil(width / 8)); // filter byte 0, then the pixels
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** A real 64 × 40 baseline JPEG, the screenshot of fixtures/valid-with-screenshots. */
export function jpeg(): Uint8Array {
  return readFileSync(`${fixturesRoot}valid-with-screenshots/assets/screenshot-2.jpg`);
}
