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
  /**
   * The process id. On Windows it is 0 for a moment after spawning: node-pty learns it once
   * ConPTY has connected, so it is read when needed, not kept from the spawn.
   */
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /**
   * Frees the pty once its process has exited; called once, after the exit. On Windows that closes
   * the pseudoconsole and the pipes to it, which node-pty does only in its `kill`, never when the
   * process exits: without it each launch would leave a console host process behind. Elsewhere it
   * does nothing. Never throws.
   */
  dispose(): void;
}

/** Starts a process in a pty; throws when it cannot (the file cannot be executed, no pty). */
export type PtySpawner = (options: PtySpawnOptions) => PtyProcess;

/**
 * The real spawner: node-pty, a native module (N-API prebuilds for macOS, Linux and Windows, which
 * Node and Electron both load). It is loaded on the first terminal launch, not at startup, so an
 * app whose node-pty cannot load still starts, and only terminal launches fail (`spawn_error`).
 *
 * On macOS and Linux the process becomes a session leader (`setsid`), so its process group is the
 * whole tree the Supervisor signals. `TERM` is `xterm-256color`, what xterm.js understands: node-pty
 * sets it from `name` on macOS and Linux only, so it is in the environment on Windows too.
 */
export const spawnNodePty: PtySpawner = (options) => {
  const pty = createRequire(import.meta.url)('node-pty') as typeof NodePty;
  const child = pty.spawn(options.file, [...options.args], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: { ...options.env, TERM: 'xterm-256color' },
  });
  return {
    get pid() {
      return child.pid;
    },
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
    dispose() {
      if (process.platform === 'win32') closePseudoconsole(child);
    },
  };
};

/**
 * The parts of node-pty's Windows terminal (lib/windowsTerminal.js, lib/windowsPtyAgent.js of the
 * node-pty version package.json pins) that {@link closePseudoconsole} uses. Internal to node-pty,
 * so every one is checked before it is used.
 */
interface WindowsPtyInternals {
  readonly _agent?: {
    readonly _pty?: unknown;
    readonly _useConptyDll?: unknown;
    readonly _ptyNative?: { readonly kill?: unknown };
    readonly _conoutSocketWorker?: { readonly dispose?: unknown };
    readonly inSocket?: { readonly destroy?: unknown };
  };
}

/**
 * Closes the pseudoconsole of a Windows pty whose process has exited: what node-pty's `kill`
 * does, without the step of it that is unsafe after the exit. `kill` (WindowsPtyAgent.kill, without
 * conpty.dll) first forks conpty_console_list_agent to list the processes attached to the console
 * and `process.kill`s each; when that takes over 5 s it kills the Harness's own pid instead. Once
 * the Harness has exited that pid is dead and Windows may already have given it to an unrelated
 * process. So this does only the rest of `kill`, each step guarded:
 * - the native `kill` of the pty's id, which calls ClosePseudoConsole while node-pty still holds
 *   the pseudoconsole (node-pty's exit thread may already have let it go: it then does nothing);
 * - disposing of the worker thread that reads the console's output, which closes that pipe;
 * - destroying the socket that writes its input, which closes that pipe.
 * With both pipes closed the console host exits. Nothing here signals a process. Never throws: a
 * node-pty whose internals differ is left as it is.
 */
function closePseudoconsole(child: NodePty.IPty): void {
  const agent = (child as unknown as WindowsPtyInternals)._agent;
  if (agent === undefined) return;
  const steps = [
    () => {
      const { _ptyNative: native, _pty: id, _useConptyDll: useConptyDll } = agent;
      if (typeof native?.kill === 'function' && typeof id === 'number') {
        const kill = native.kill as (id: number, useConptyDll: boolean) => void;
        kill.call(native, id, useConptyDll === true);
      }
    },
    () => {
      const worker = agent._conoutSocketWorker;
      if (typeof worker?.dispose === 'function') (worker.dispose as () => void).call(worker);
    },
    () => {
      const socket = agent.inSocket;
      if (typeof socket?.destroy === 'function') (socket.destroy as () => void).call(socket);
    },
  ];
  for (const step of steps) {
    try {
      step();
    } catch {
      // Already closed.
    }
  }
}
