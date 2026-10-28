import { execFile } from 'node:child_process';

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
 * tree to close) and SIGKILL `taskkill /T /F /PID <pid>`. This path is not tested yet: CI runs on
 * Linux only.
 */
export function signalProcessTree(
  pid: number,
  signal: StopSignal,
  platform: NodeJS.Platform = process.platform,
): void {
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
