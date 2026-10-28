import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { PtyExit } from './pty.js';

/** What the Supervisor starts a web Harness with. */
export interface PipedSpawnOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** A process with its stdout and stderr piped to the Runtime and no stdin. */
export interface PipedProcess {
  readonly pid: number;
  /** Output as it comes, decoded as UTF-8, by stream. */
  onOutput(listener: (source: 'out' | 'err', text: string) => void): void;
  /** How it ended: as a pty reports it, 128 + the signal number for a process a signal ended. */
  onExit(listener: (exit: PtyExit) => void): void;
}

/** Starts a process; rejects when it cannot be started (no such file, not executable). */
export type PipedSpawner = (options: PipedSpawnOptions) => Promise<PipedProcess>;

/** How long the exit waits for the output still in the pipes after the process has exited. */
const DRAIN_MS = 250;

/**
 * The real spawner of web UI Kind Harnesses: `child_process.spawn` with stdin ignored and stdout
 * and stderr piped, for the launch log. On macOS and Linux the process is spawned detached, so it
 * leads its own process group and the shutdown sequence signals the whole tree; on Windows it is
 * not (a detached process gets a console window of its own there) and taskkill /T stops the tree.
 *
 * The exit is reported once the pipes are closed, or {@link DRAIN_MS} after the process exited
 * when a process it started still holds them open, so its last output reaches the log first.
 */
export const spawnPiped: PipedSpawner = (options) =>
  new Promise((resolve, reject) => {
    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const outputListeners: ((source: 'out' | 'err', text: string) => void)[] = [];
    // Output before the Supervisor listens waits for it.
    let early: [source: 'out' | 'err', text: string][] | null = [];
    const output = (source: 'out' | 'err') => (text: string) => {
      if (early !== null) early.push([source, text]);
      for (const listener of outputListeners) listener(source, text);
    };
    child.stdout.on('data', output('out'));
    child.stderr.on('data', output('err'));

    let exit: PtyExit | null = null;
    const exitListeners: ((exit: PtyExit) => void)[] = [];
    let reported = false;
    const report = () => {
      if (reported || exit === null) return;
      reported = true;
      for (const listener of exitListeners) listener(exit);
    };
    child.once('exit', (code, signal) => {
      const number = signal === null ? undefined : constants.signals[signal];
      exit =
        number === undefined ? { exitCode: code ?? 1 } : { exitCode: 128 + number, signal: number };
      setTimeout(report, DRAIN_MS);
    });
    child.once('close', report);

    child.on('error', (error) => {
      // An error after the spawn (a failed kill, say) is not one of starting; the exit follows.
      if (child.pid === undefined) reject(error);
    });
    child.once('spawn', () => {
      const { pid } = child;
      if (pid === undefined) return;
      resolve({
        pid,
        onOutput(listener) {
          for (const [source, text] of early ?? []) listener(source, text);
          early = null;
          outputListeners.push(listener);
        },
        onExit(listener) {
          exitListeners.push(listener);
          if (reported && exit !== null) listener(exit);
        },
      });
    });
  });
