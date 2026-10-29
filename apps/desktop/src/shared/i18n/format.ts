import type { Locale } from './locale.js';

/**
 * Locale-aware formatting of numbers, dates and sizes, always through the `Intl` APIs with the
 * UI's resolved locale (never hand-rolled separators or unit names).
 */

export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDate(
  locale: Locale,
  value: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

/** A list joined as the locale joins one: `tool calling and vision`, `工具调用和视觉`. */
export function formatList(locale: Locale, items: readonly string[]): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
}

const BYTE_UNITS = [
  ['byte', 1],
  ['kilobyte', 1e3],
  ['megabyte', 1e6],
  ['gigabyte', 1e9],
] as const;

/**
 * A size in bytes, in decimal units (base 1000: 1 kB = 1000 bytes), with at most one fraction
 * digit: `1.5 kB`, `2.3 GB`. The unit is the largest whose rounded value stays under 1000, so
 * 999 950 bytes reads `1 MB`, not `1,000 kB`.
 */
export function formatBytes(locale: Locale, bytes: number): string {
  const [unit, size] =
    BYTE_UNITS.find(([, size]) => Math.round((Math.abs(bytes) / size) * 10) / 10 < 1000) ??
    BYTE_UNITS[3];
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(bytes / size);
}
