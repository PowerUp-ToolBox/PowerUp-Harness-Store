import { rmSync } from 'node:fs';
import { KILL_WAIT_MS, STOP_GRACE_MS } from '../../src/main/runtime/supervisor.js';

/**
 * What the tests that run Harness processes for real need on every OS. On Windows the polite step
 * of the shutdown sequence (`taskkill` without /F) cannot end a console process, which has no
 * window to close, so every stop there takes the whole STOP_GRACE_MS before `taskkill /F`; and a
 * folder a Harness ran in can stay locked (EBUSY) for a moment after it exited.
 */

/** How long a test waits for what a Harness does: long enough for a stop on Windows. */
export const WAIT_MS = STOP_GRACE_MS + KILL_WAIT_MS + 5000;

/** Deletes a folder a test made, retrying while Windows still holds a file in it. */
export function removeFolder(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
