import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatList, formatNumber } from '../../src/shared/i18n/format.js';

describe('formatBytes', () => {
  it.each([
    [512, '512 byte'],
    [1500, '1.5 kB'],
    [999_000, '999 kB'],
    [999_950, '1 MB'],
    [2_500_000, '2.5 MB'],
    [3_210_000_000, '3.2 GB'],
    [4_500_000_000_000, '4,500 GB'],
  ])('%d bytes → %s in en (base 1000, one fraction digit)', (bytes, expected) => {
    expect(formatBytes('en', bytes)).toBe(expected);
  });

  it('uses the zh-CN unit names', () => {
    expect(formatBytes('zh-CN', 512)).toBe('512 B');
    expect(formatBytes('zh-CN', 2_500_000)).toBe('2.5 MB');
  });
});

describe('formatNumber and formatDate', () => {
  it('group digits for the locale', () => {
    expect(formatNumber('en', 1234567.5)).toBe('1,234,567.5');
    expect(formatNumber('zh-CN', 1234567.5)).toBe('1,234,567.5');
  });

  it('write dates for the locale', () => {
    const date = Date.UTC(2026, 9, 27, 12);
    const utc = { dateStyle: 'medium', timeZone: 'UTC' } as const;
    expect(formatDate('en', date, utc)).toBe('Oct 27, 2026');
    expect(formatDate('zh-CN', date, utc)).toBe('2026年10月27日');
  });
});

describe('formatList', () => {
  it('joins a list as the locale does', () => {
    expect(formatList('en', ['tool calling'])).toBe('tool calling');
    expect(formatList('en', ['tool calling', 'vision'])).toBe('tool calling and vision');
    expect(formatList('zh-CN', ['工具调用', '视觉'])).toBe('工具调用和视觉');
  });
});
