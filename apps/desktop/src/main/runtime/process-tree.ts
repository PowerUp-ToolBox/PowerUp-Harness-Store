import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** The two steps of the shutdown sequence: ask (SIGTERM), then force (SIGKILL). */
export type StopSignal = 'SIGTERM' | 'SIGKILL';

/**
 * What a step of the shutdown sequence came to. `refused`: Windows' polite step (`taskkill` without
 * /F) answered that it could not end the tree, as it always does for a console process, so waiting
 * out the grace period for an exit is pointless. `sent` otherwise, whatever then happens.
 */
export type SignalOutcome = 'sent' | 'refused';

/** taskkill's exit code when no process has the pid: it exited before taskkill ran. */
const TASKKILL_NOT_FOUND = 128;

/**
 * Sends `signal` to a Harness process and every process it started, so stopping a Harness never
 * leaves its children running.
 *
 * On macOS and Linux a Harness leads its own process group (a pty makes it a session leader; a
 * piped child is spawned detached), so the signal goes to the group, `-pid`. When the group is
 * gone, the process alone is tried; a process that has already exited is not an error. Resolves
 * `sent` at once.
 *
 * On Windows there are no signals: SIGTERM is `taskkill /T /PID <pid>` and SIGKILL `taskkill /T /F
 * /PID <pid>`. Without /F, taskkill asks every window of the tree to close, so it cannot end a
 * console process, which has none: every Harness in a pty (ConPTY hosts console programs only), and
 * node.exe behind a web Harness. It then exits with an error, and this resolves `refused` once it
 * has (taskkill's exit code, not its text, which is in the OS's language). A pid no process has
 * any more is `sent`: the process exited, and its exit is on its way.
 *
 * A pid that is not a process's (0 or less) is never signalled (`sent`): `kill(0)` would reach the
 * Runtime's own process group.
 */
export function signalProcessTree(
  pid: number,
  signal: StopSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<SignalOutcome> {
  if (pid <= 0) return Promise.resolve('sent');
  if (platform === 'win32') {
    const force = signal === 'SIGKILL' ? ['/F'] : [];
    return new Promise((resolve) => {
      execFile(
        'taskkill',
        ['/T', ...force, '/PID', String(pid)],
        { windowsHide: true },
        (error) => {
          // A numeric code is taskkill's own; a string one (ENOENT) means it never ran, and the
          // shutdown sequence then goes on as it would without an answer.
          const code = typeof error?.code === 'number' ? error.code : 0;
          resolve(
            signal === 'SIGTERM' && code !== 0 && code !== TASKKILL_NOT_FOUND ? 'refused' : 'sent',
          );
        },
      );
    });
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
  return Promise.resolve('sent');
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
