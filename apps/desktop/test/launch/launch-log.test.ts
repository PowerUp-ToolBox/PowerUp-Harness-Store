import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLaunchLog, pruneLaunchLogs } from '../../src/main/runtime/launch-log.js';

/** Ticket P0-05.2: the per-launch log file, its line format, its size cap and its rotation. */

let folder: string;
const now = () => new Date('2026-10-28T09:00:00.000Z');

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'harness-store-log-'));
});
afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('openLaunchLog', () => {
  it('writes one timestamped line per output line, a partial line once it ends', async () => {
    const path = join(folder, 'launch.log');
    const log = openLaunchLog(path, { now });
    log.write('runtime', 'Started node index.mjs (pid 42)\n');
    log.write('pty', '\u001b[32mgreen\u001b[0m\r\nhal');
    log.write('err', 'oops\n');
    log.write('pty', 'f a line\r\nno end');
    await log.close();
    log.write('pty', 'after close\n');
    await log.close();
    expect(readFileSync(path, 'utf8')).toBe(
      [
        '2026-10-28T09:00:00.000Z [runtime] Started node index.mjs (pid 42)',
        '2026-10-28T09:00:00.000Z [pty] \u001b[32mgreen\u001b[0m',
        '2026-10-28T09:00:00.000Z [err] oops',
        '2026-10-28T09:00:00.000Z [pty] half a line',
        '2026-10-28T09:00:00.000Z [pty] no end',
        '',
      ].join('\n'),
    );
  });

  it('stops at its size cap with one line saying so', async () => {
    const path = join(folder, 'launch.log');
    const log = openLaunchLog(path, { now, maxBytes: 1024 * 1024 });
    const line = `${'x'.repeat(1000)}\n`;
    for (let index = 0; index < 1100; index += 1) log.write('out', line);
    await log.close();
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines.at(-1)).toBe(
      '2026-10-28T09:00:00.000Z [runtime] The log reached 1 MB; later output is not kept.',
    );
    expect(lines.length).toBeLessThan(1100);
    expect(readFileSync(path).length).toBeLessThanOrEqual(1024 * 1024 + 100);
  });

  it('keeps its last 50 complete lines in memory, past the size cap too (P0-05.3)', async () => {
    const log = openLaunchLog(join(folder, 'launch.log'), { now, maxBytes: 200 });
    expect(log.tail()).toEqual([]);
    for (let index = 0; index < 60; index += 1) log.write('out', `line ${String(index)}\n`);
    log.write('err', 'no end yet');
    const tail = log.tail();
    expect(tail).toHaveLength(50);
    expect(tail[0]).toBe('2026-10-28T09:00:00.000Z [out] line 10');
    expect(tail.at(-1)).toBe('2026-10-28T09:00:00.000Z [out] line 59');
    await log.close();
    expect(log.tail().at(-1)).toBe('2026-10-28T09:00:00.000Z [err] no end yet');
  });
});

describe('pruneLaunchLogs', () => {
  it('keeps the newest logs by modification time and leaves other files alone', async () => {
    for (let index = 0; index < 5; index += 1) {
      const path = join(folder, `launch-${String(index)}.log`);
      writeFileSync(path, '');
      utimesSync(path, 1_000 + index, 1_000 + index);
    }
    writeFileSync(join(folder, 'notes.txt'), '');
    await pruneLaunchLogs(folder, 2);
    expect(readdirSync(folder).sort()).toEqual(['launch-3.log', 'launch-4.log', 'notes.txt']);
  });

  it('does nothing for a folder that does not exist', async () => {
    await expect(pruneLaunchLogs(join(folder, 'missing'), 2)).resolves.toBeUndefined();
  });
});
