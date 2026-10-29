import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** The two steps of the shutdown sequence: ask (SIGTERM), then force (SIGKILL). */
export type StopSignal = 'SIGTERM' | 'SIGKILL';

/**
 * Sends `signal` to a Harness process and every process it started, so stopping a Harness never
 * leaves its children running.
 *
 * On macOS and Linux a Harness leads its own process group (a pty makes it a session leader; a
 * piped child is spawned detached), so the signal goes to the group, `-pid`. When the group is
 * gone, the process alone is tried; a process that has already exited is not an error.
 *
 * On Windows there are no signals: SIGTERM is `taskkill /T /PID <pid>` (asks every window of the
 * tree to close, so it cannot end a console process, which has none) and SIGKILL `taskkill /T /F /PID
 * <pid>`.
 *
 * A pid that is not a process's (0 or less) is never signalled: `kill(0)` would reach the
 * Runtime's own process group.
 */
export function signalProcessTree(
  pid: number,
  signal: StopSignal,
  platform: NodeJS.Platform = process.platform,
): void {
  if (pid <= 0) return;
  if (platform === 'win32') {
    const force = signal === 'SIGKILL' ? ['/F'] : [];
    execFile('taskkill', ['/T', ...force, '/PID', String(pid)], { windowsHide: true }, () => {
      // An exit before taskkill ran is fine: the shutdown sequence waits for the exit either way.
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already exited.
    }
  }
}

/** How often {@link processTreeEndsWithin} looks whether the process group is gone. */
const TREE_POLL_MS = 100;

/**
 * Whether the process group a Harness led is gone within `ms`: its leader may exit on SIGTERM
 * while a process it started in its group ignores SIGTERM (and the SIGHUP of the pty closing),
 * which still has to get SIGKILL.
 *
 * On Windows the tree cannot be looked up once its root process has exited, so this answers true.
 */
export async function processTreeEndsWithin(
  pid: number,
  ms: number,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === 'win32') return true;
  const deadline = Date.now() + ms;
  for (;;) {
    if (!processTreeAlive(pid, platform)) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(TREE_POLL_MS, left));
  }
}

/**
 * Whether some process still belongs to the process group a Harness led, now: once the Harness
 * itself has exited, a process it started may still run in its group (signal 0 only checks).
 *
 * On Windows the tree cannot be looked up once its root process has exited, so this answers false.
 */
export function processTreeAlive(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32' || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM: a member runs as another user. It is still there.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
