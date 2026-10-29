import { execFile } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** The two steps of the shutdown sequence: ask (SIGTERM), then force (SIGKILL). */
export type StopSignal = 'SIGTERM' | 'SIGKILL';

/**
 * What a step of the shutdown sequence came to. `refused`: on Windows, the polite step cannot end
 * the tree, so waiting out the grace period for an exit is pointless. `sent` otherwise, whatever
 * then happens.
 */
export type SignalOutcome = 'sent' | 'refused';

/** What {@link signalProcessTree} needs to know of the Harness besides its pid. */
export interface SignalOptions {
  /**
   * Whether the Harness is a console program on Windows ({@link isConsoleProgram}): every
   * terminal Harness (ConPTY hosts console programs only) and every Node Harness (node.exe).
   */
  readonly consoleProgram?: boolean;
  readonly platform?: NodeJS.Platform;
}

/** taskkill's exit code when no process has the pid: it exited before taskkill ran. */
const TASKKILL_NOT_FOUND = 128;

/** How long taskkill may run before it is ended. */
const TASKKILL_TIMEOUT_MS = 10_000;

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
 * /PID <pid>`. Without /F, taskkill only asks the tree's windows to close. A console program has
 * none of its own: taskkill finds its console's window, answers that it sent the request, and the
 * program runs on (every stop used to wait out the grace period for nothing; asking a real console
 * window to close would also end every other program attached to that console). So for a console
 * program SIGTERM sends nothing and resolves `refused` at once. For another program, `refused` is
 * when taskkill exits with an error, as it does for a program without a window (its exit code is
 * read, not its text, which is in the OS's language); a pid no process has any more is `sent`: the
 * process exited, and its exit is on its way.
 *
 * A pid that is not a process's (0 or less) is never signalled (`sent`): `kill(0)` would reach the
 * Runtime's own process group.
 */
export function signalProcessTree(
  pid: number,
  signal: StopSignal,
  options: SignalOptions = {},
): Promise<SignalOutcome> {
  const { consoleProgram = false, platform = process.platform } = options;
  if (pid <= 0) return Promise.resolve('sent');
  if (platform === 'win32') {
    if (signal === 'SIGTERM' && consoleProgram) return Promise.resolve('refused');
    const force = signal === 'SIGKILL' ? ['/F'] : [];
    return new Promise((resolve) => {
      execFile(
        'taskkill',
        ['/T', ...force, '/PID', String(pid)],
        // A taskkill that hangs on a wedged tree is ended; its outcome then counts as no answer.
        { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
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

/** The PE subsystem of a console program, IMAGE_SUBSYSTEM_WINDOWS_CUI. */
const WINDOWS_CUI = 3;

/**
 * Whether `file` is a Windows console program: a PE executable whose subsystem is the console's
 * (the GUI's is 2). False off Windows, and for a file that cannot be read or is no PE executable.
 */
export function isConsoleProgram(
  file: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const header = Buffer.alloc(4096);
    const read = readSync(fd, header, 0, header.length, 0);
    if (read < 0x40 || header.toString('latin1', 0, 2) !== 'MZ') return false;
    const pe = header.readUInt32LE(0x3c);
    // After the PE signature (4 bytes) and the COFF header (20), the optional header, whose
    // Subsystem field is at offset 68 in PE32 and PE32+ alike.
    const subsystem = pe + 4 + 20 + 68;
    if (subsystem + 2 > read || header.toString('latin1', pe, pe + 4) !== 'PE\0\0') return false;
    return header.readUInt16LE(subsystem) === WINDOWS_CUI;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
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
