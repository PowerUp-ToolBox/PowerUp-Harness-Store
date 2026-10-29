/** The Usage page's periods, in the order its selector shows them. */
export const USAGE_PERIODS = ['today', '7d', '30d', 'all'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

/** How many calendar days before today each period starts: today counts as one of its days. */
const DAYS_BEFORE_TODAY: Readonly<Record<Exclude<UsagePeriod, 'all'>, number>> = {
  today: 0,
  '7d': 6,
  '30d': 29,
};

/**
 * Where a period starts, as the ISO-8601 instant of a local midnight: today's for "Today", that
 * of 6 or 29 days before for "7 days" and "30 days", so each covers whole calendar days of the
 * User's timezone, however long a day was (daylight saving time). Null for "All". Periods have no
 * end: records written later still count. Computed from `now` on every query, so a page left open
 * past midnight moves on to the next day.
 */
export function periodStart(period: UsagePeriod, now: Date): string | null {
  if (period === 'all') return null;
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - DAYS_BEFORE_TODAY[period],
  );
  return start.toISOString();
}

/** A local `YYYY-MM-DD` day, as `usage.query` groups by it, at that day's local midnight. */
export function localDay(day: string): Date {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
}
