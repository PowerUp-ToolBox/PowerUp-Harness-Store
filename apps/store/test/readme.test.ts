import { describe, expect, it } from 'vitest';
import {
  README_MAX_BYTES,
  storedReadme,
  truncateUtf8,
} from '../supabase/functions/_shared/readme.ts';

const bytesOf = (text: string) => new TextEncoder().encode(text).length;

describe('storedReadme', () => {
  it('keeps a README within the limit as it is', () => {
    const text = '# Hello\n\n写作助手 ✍️\n';
    expect(storedReadme(new TextEncoder().encode(text))).toBe(text);
  });

  it('keeps at most 1 MiB, cut at a character boundary', () => {
    // 3-byte characters, so 1 MiB (not a multiple of 3) falls inside one.
    const stored = storedReadme(new TextEncoder().encode('写'.repeat(400_000)));
    expect(bytesOf(stored)).toBeLessThanOrEqual(README_MAX_BYTES);
    expect(bytesOf(stored)).toBeGreaterThan(README_MAX_BYTES - 3);
    expect(stored).toBe('写'.repeat(Math.floor(README_MAX_BYTES / 3)));
  });

  it('drops NUL characters, which Postgres text cannot hold, and replaces invalid UTF-8', () => {
    expect(storedReadme(new Uint8Array([0x61, 0x00, 0x62, 0xff]))).toBe('ab�');
  });
});

describe('truncateUtf8', () => {
  it('never splits a character, including a surrogate pair', () => {
    expect(truncateUtf8('a😀b', 4)).toBe('a');
    expect(truncateUtf8('a😀b', 5)).toBe('a😀');
    expect(truncateUtf8('é', 1)).toBe('');
    expect(truncateUtf8('abc', 3)).toBe('abc');
  });
});
