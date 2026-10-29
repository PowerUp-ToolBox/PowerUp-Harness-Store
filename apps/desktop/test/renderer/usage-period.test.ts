/**
 * Ticket P0-11.1: the Usage page's periods start at a local midnight, today counted as one of
 * their days, however long a day was. Run in a timezone with daylight saving time
 * (America/New_York, whose clocks went back on 2026-11-01), set before anything reads the clock
 * and restored afterwards, so it passes the same in CI's UTC.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { localDay, periodStart } from '../../src/renderer/src/usage/period.js';

// This project has no Node types; the test still runs under Node.
declare const process: { env: Record<string, string | undefined> };

const savedTimeZone = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (savedTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedTimeZone;
});

describe('periodStart', () => {
  // Nov 3 at 09:15 EST: the clocks went back two days before.
  const now = new Date('2026-11-03T14:15:00.000Z');

  it('Today starts at this morning’s local midnight', () => {
    expect(periodStart('today', now)).toBe('2026-11-03T05:00:00.000Z');
  });

  it('7 days and 30 days start 6 and 29 days before, at local midnight in daylight saving time', () => {
    expect(periodStart('7d', now)).toBe('2026-10-28T04:00:00.000Z');
    expect(periodStart('30d', now)).toBe('2026-10-05T04:00:00.000Z');
  });

  it('All has no start', () => {
    expect(periodStart('all', now)).toBeNull();
  });

  it('just after midnight belongs to the new day, and just before to the old one', () => {
    expect(periodStart('today', new Date('2026-11-03T05:00:00.000Z'))).toBe(
      '2026-11-03T05:00:00.000Z',
    );
    expect(periodStart('today', new Date('2026-11-03T04:59:59.999Z'))).toBe(
      '2026-11-02T05:00:00.000Z',
    );
  });

  it('crossing local midnight moves every period on by a day', () => {
    const before = new Date('2026-11-02T04:59:00.000Z');
    const after = new Date('2026-11-02T05:01:00.000Z');
    expect(periodStart('7d', before)).toBe('2026-10-26T04:00:00.000Z');
    expect(periodStart('7d', after)).toBe('2026-10-27T04:00:00.000Z');
  });
});

describe('localDay', () => {
  it('is the local midnight of a YYYY-MM-DD day', () => {
    expect(localDay('2026-11-01').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(localDay('2026-11-02').toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });
});
