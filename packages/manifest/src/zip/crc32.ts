/**
 * CRC-32 (ISO 3309, the polynomial zip and PNG use), computed incrementally so a file can be
 * checked while it is being inflated.
 */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Continues a CRC-32 over `bytes`. Start with `crc32(bytes)`; for more bytes pass the previous
 * result as `crc`.
 */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (const byte of bytes) c = (TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return ~c >>> 0;
}
