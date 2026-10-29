/**
 * The README.md text the Store keeps for a Harness Version. A long README is only a warning for
 * validatePackage, so the Store never rejects one: it keeps at most {@link README_MAX_BYTES} of
 * UTF-8, cut at a character boundary. Plain TypeScript with no imports (see storage-paths.ts).
 */

/** At most 1 MiB of README is stored (`harness_versions.readme`). */
export const README_MAX_BYTES = 1024 * 1024;

/**
 * Decodes README.md (invalid UTF-8 becomes U+FFFD), drops NUL characters, which Postgres text
 * cannot hold, and keeps at most `maxBytes` bytes of UTF-8 without splitting a character.
 */
export function storedReadme(bytes: Uint8Array, maxBytes = README_MAX_BYTES): string {
  const text = new TextDecoder().decode(bytes).replaceAll('\u0000', '');
  return truncateUtf8(text, maxBytes);
}

/** The longest prefix of `text` whose UTF-8 encoding fits in `maxBytes` bytes. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) to the start of the character that would be cut.
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
}
