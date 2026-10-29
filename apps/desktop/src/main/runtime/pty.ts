import { createRequire } from 'node:module';
import type * as NodePty from 'node-pty';

/** What the Supervisor starts a terminal Harness with. */
export interface PtySpawnOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

/** How a pty's process ended. */
export interface PtyExit {
  /** The exit code; for a process a signal ended, 128 + the signal number (137 after SIGKILL). */
  readonly exitCode: number;
  /** The signal number that ended it, when one did (macOS and Linux). */
  readonly signal?: number;
}

/** A process running in a pseudo-terminal: what the Supervisor needs of node-pty's `IPty`. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

/** Starts a process in a pty; throws when it cannot (the file cannot be executed, no pty). */
export type PtySpawner = (options: PtySpawnOptions) => PtyProcess;

/**
 * The real spawner: node-pty, a native module (N-API prebuilds for macOS, Linux and Windows, which
 * Node and Electron both load). It is loaded on the first terminal launch, not at startup, so an
 * app whose node-pty cannot load still starts, and only terminal launches fail (`spawn_error`).
 *
 * On macOS and Linux the process becomes a session leader (`setsid`), so its process group is the
 * whole tree the Supervisor signals. `TERM` is `xterm-256color`, what xterm.js understands.
 */
export const spawnNodePty: PtySpawner = (options) => {
  const pty = createRequire(import.meta.url)('node-pty') as typeof NodePty;
  const child = pty.spawn(options.file, [...options.args], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: { ...options.env },
  });
  return {
    pid: child.pid,
    onData(listener) {
      child.onData(listener);
    },
    onExit(listener) {
      child.onExit(({ exitCode, signal }) => {
        listener(
          signal !== undefined && signal > 0 ? { exitCode: 128 + signal, signal } : { exitCode },
        );
      });
    },
    write(data) {
      child.write(data);
    },
    resize(cols, rows) {
      child.resize(cols, rows);
    },
  };
};
