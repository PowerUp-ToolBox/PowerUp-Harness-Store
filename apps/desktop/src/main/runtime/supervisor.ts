import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Gateway } from '@harness-store/gateway';
import type { Platform } from '@harness-store/manifest';
import type {
  HarnessWindowEventName,
  HarnessWindowEvents,
  HarnessWindowInfo,
  TerminalSize,
  WebContentArea,
} from '../../shared/harness-ipc.js';
import type { Locale } from '../../shared/i18n/locale.js';
import type {
  IpcResult,
  LastWorkspace,
  LaunchFailure,
  LaunchStarted,
  LaunchState,
  LaunchStatus,
} from '../../shared/ipc.js';
import { entryFor, type HarnessPaths } from './harness-paths.js';
import type { InstallRow, InstallStore } from './install-store.js';
import { readIcon } from './installer.js';
import { fail, ok } from './ipc-result.js';
import { launchEnvironment } from './launch-env.js';
import {
  KEPT_LAUNCH_LOGS,
  newestLaunchLog,
  openLaunchLog,
  pruneLaunchLogs,
  type LaunchLog,
} from './launch-log.js';
import type { LaunchStore } from './launch-store.js';
import { spawnPiped, type PipedSpawner } from './piped-process.js';
import {
  isConsoleProgram,
  processTreeAlive,
  processTreeEndsWithin,
  signalProcessTree,
  type SignalOutcome,
  type StopSignal,
} from './process-tree.js';
import type { PtyExit, PtyProcess, PtySpawner } from './pty.js';
import {
  DEFAULT_READY_TIMEOUT_SECONDS,
  freePort,
  LOOPBACK,
  pickPort,
  waitForPort,
} from './web-port.js';

/** How long a Harness has to exit after SIGTERM before it gets SIGKILL (architecture §4). */
export const STOP_GRACE_MS = 5000;
/** How long the Supervisor waits for the exit after SIGKILL before it records the launch as ended. */
export const KILL_WAIT_MS = 2000;
/** How long quitting the app waits for every Harness to stop. */
export const STOP_ALL_CAP_MS = 10_000;

/**
 * The Harness windows as the Supervisor drives them: Electron windows in
 * src/main/harness-windows.ts, a fake in tests. A window belongs to one launch, by its launch id.
 */
export interface HarnessWindows {
  /**
   * Opens the window of a terminal launch. Its page reports `terminal.ready` with the terminal's
   * size once it is on screen, and the Supervisor starts the process then. `onClosed` runs once,
   * when the window has closed, whoever closed it.
   */
  openTerminal(window: HarnessWindowSpec, onClosed: () => void): void;
  /**
   * Opens the window of a web launch at once, on its Starting state (the window's own page); the
   * Harness's page comes into it with {@link showWeb} once its port accepts connections, so the
   * User never sees a refused connection. `onClosed` as for {@link openTerminal}.
   */
  openWeb(window: WebWindowSpec, onClosed: () => void): void;
  /**
   * Shows the Harness's page at `url` (`http://127.0.0.1:<port><ui.path>`) in the launch's window,
   * in a view of its own with no preload; only that origin stays inside the window.
   */
  showWeb(launchId: string, url: string): void;
  /** Takes the Harness's page out of the window (its process ended), so the window shows why. */
  hideWeb(launchId: string): void;
  /** Reloads the Harness's page in place. */
  reloadWeb(launchId: string): void;
  /** Where the Harness's page goes in its window, as the window's own page measured it. */
  layoutWeb(launchId: string, area: WebContentArea): void;
  /** Sends an event to the launch's window; dropped when it has none. */
  send<E extends HarnessWindowEventName>(
    launchId: string,
    event: E,
    payload: HarnessWindowEvents[E],
  ): void;
  /** Brings the launch's window to the front, restoring it when minimized; false without one. */
  focus(launchId: string): boolean;
  /** Closes the launch's window, when it has one. */
  close(launchId: string): void;
}

/** What a Harness window is opened with. */
export interface HarnessWindowSpec {
  readonly launchId: string;
  readonly harnessId: string;
  /** The Manifest's display name, for the window title. */
  readonly name: string;
}

/** What a web Harness window is opened with. */
export interface WebWindowSpec extends HarnessWindowSpec {
  /** The Manifest's `ui.window` hints: the first size of the Harness's page. */
  readonly size: { readonly width?: number; readonly height?: number };
}

/**
 * How the Runtime runs a Node Harness: the program and the variables it needs to act as Node. In
 * the app that is Electron's own executable with `ELECTRON_RUN_AS_NODE=1` on macOS and Linux, and
 * the node.exe of Electron's Node version the build ships on Windows (node-runtime.ts), so no
 * system Node is needed; under plain Node in tests, Node itself.
 */
export interface NodeCommand {
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface SupervisorOptions {
  readonly installs: Pick<InstallStore, 'get' | 'markLaunched' | 'setLastWorkspace'>;
  readonly launches: LaunchStore;
  readonly paths: Pick<HarnessPaths, 'logsDir'>;
  /** This machine's platform as the Manifest names it; null when no Manifest can declare it. */
  readonly platform: Platform | null;
  /** The Model Gateway's `HARNESS_GATEWAY_URL`, `http://127.0.0.1:<port>/v1`. */
  readonly gatewayUrl: string;
  /** Issues and revokes the Gateway Tokens of launches. */
  readonly tokens: Pick<Gateway, 'issueToken' | 'revokeLaunch'>;
  /** The app's UI language now: a launch's `HARNESS_LOCALE` and its token's locale. */
  readonly locale: () => Locale;
  /**
   * Whether an install of the Harness is putting its files in place now (the installer's
   * `isInstalling`); it is not launched then. Default: never.
   */
  readonly isInstalling?: (harnessId: string) => boolean;
  /**
   * Whether some model fills the Harness's `default` Model Slot now. A Harness without one is not
   * launched (docs/ux/flows.md F3): the User sets up a model first.
   */
  readonly defaultSlotBound: (harnessId: string) => boolean;
  readonly windows: HarnessWindows;
  readonly spawnPty: PtySpawner;
  /** Starts a web Harness with its output piped. Default: `child_process.spawn`. */
  readonly spawnProcess?: PipedSpawner;
  /** Asks the OS for a free loopback port, for a web Harness's `HARNESS_PORT`. Default: port 0. */
  readonly freePort?: () => Promise<number>;
  readonly nodeCommand: NodeCommand;
  /** The environment a Harness inherits before the launch contract applies. Default: this process's. */
  readonly environment?: () => Readonly<Record<string, string | undefined>>;
  /** Pushes a launch's new state to the main window (`launch.state`). */
  readonly emit: (status: LaunchStatus) => void;
  /**
   * Opens a file or folder with the OS (Electron's `shell.openPath`), resolving whether the OS
   * opened it. Default: does nothing, and answers that it did.
   */
  readonly openPath?: (path: string) => Promise<boolean>;
  /**
   * Opens the OS folder picker (Electron's `dialog`) at `defaultPath` when given, and resolves the
   * chosen folder's absolute path, or null when the User cancelled. Default: always cancelled.
   */
  readonly pickFolder?: (defaultPath: string | null) => Promise<string | null>;
  readonly now?: () => Date;
  readonly logError?: (message: string, error: unknown) => void;
}

/** The Process Supervisor as the Runtime uses it. */
export interface Supervisor {
  /**
   * `launch.start`, with the Workspace the User chose in the main window's sheet: null or absent
   * when they chose none, which fails a Harness that requires one (`workspace_cancelled`). For a
   * Harness that takes a Workspace, a folder that is not an existing absolute directory answers
   * `invalid_input`; a Harness that declares no Workspace never gets one, and a folder sent for it
   * is ignored, not checked.
   */
  start(harnessId: string, workspace?: string | null): Promise<IpcResult<LaunchStarted>>;
  /**
   * `launch.chooseWorkspace`: the OS folder picker, opened at the Harness's last Workspace while
   * that folder exists; the chosen folder, or null when the User cancelled.
   */
  chooseWorkspace(harnessId: string): Promise<IpcResult<string | null>>;
  /**
   * `launch.lastWorkspace`: the Harness's last Workspace and whether that folder still exists;
   * null when it never had one.
   */
  lastWorkspace(harnessId: string): Promise<IpcResult<LastWorkspace | null>>;
  /** `launch.status`: the latest launch of every Harness launched since the app started. */
  status(): readonly LaunchStatus[];
  /**
   * `launch.openLogs`: opens the Harness's newest launch log with the OS (its latest launch's,
   * else the most recently written one), or its logs folder, created, before it has any.
   */
  openLogs(harnessId: string): Promise<IpcResult<null>>;
  /**
   * `launch.openDataFolder`: opens the Harness's Data Directory in the OS file browser, creating
   * it when missing.
   */
  openDataFolder(harnessId: string): Promise<IpcResult<null>>;
  /** Whether the Harness has a launch that has not ended (it is never installed over then). */
  isRunning(harnessId: string): boolean;
  /**
   * Stops every running Harness with the shutdown sequence, at once, for quitting the app; gives up
   * waiting after {@link STOP_ALL_CAP_MS}. Launches are refused from then on.
   */
  stopAll(): Promise<void>;
  /** The calls of one launch's window; null for a launch the Supervisor does not know. */
  window(launchId: string): LaunchWindow | null;
}

/** What a Harness window may do about its own launch (the Harness window IPC). */
export interface LaunchWindow {
  readonly harnessId: string;
  info(): Promise<HarnessWindowInfo>;
  /**
   * Opens this launch's log file, or the Harness's logs folder (created) before it has one;
   * `open_failed` when the OS could not open it.
   */
  openLogs(): Promise<IpcResult<null>>;
  /**
   * Launches the Harness again once this launch has ended, with this launch's Workspace (the User
   * is not asked again); while it runs, focuses it.
   */
  relaunch(): Promise<IpcResult<LaunchStarted>>;
  /** Closes the window, which stops the Harness while it runs. */
  close(): void;
  /** Reloads a ready web Harness's page in place. */
  reload(): void;
  /** Where a web Harness's page goes in the window. */
  webLayout(area: WebContentArea): void;
  /** Starts the process in a pty of this size, once; later calls resize. */
  terminalReady(size: TerminalSize): void;
  terminalInput(data: string): void;
  terminalResize(size: TerminalSize): void;
}

/** What a Harness process is started with. */
interface SpawnCommand {
  readonly file: string;
  readonly args: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

/** How a launch ends. */
type LaunchEnd =
  { readonly state: 'stopped' } | { readonly state: 'failed'; readonly reason: LaunchFailure };

/** A launch from the moment `launch.start` accepts it. */
interface Launch {
  readonly launchId: string;
  readonly install: InstallRow;
  /** The Workspace's absolute path; null when the launch has none. */
  readonly workspace: string | null;
  readonly startedAt: string;
  state: LaunchState;
  reason?: LaunchFailure;
  exitCode?: number;
  /** The last lines of its log, once it failed `ready_timeout`. */
  logTail?: readonly string[];
  /**
   * Set once the User (closing the window), the app (quitting) or the readiness timeout asked it
   * to stop.
   */
  stopRequested: boolean;
  tokenIssued: boolean;
  log: LaunchLog | null;
  /** The command a terminal launch runs once its window reports its size. */
  command: SpawnCommand | null;
  /**
   * The process, once started. Its `pid` is read each time it is needed: a pty's is 0 on Windows
   * until ConPTY has connected (see {@link PtyProcess.pid}).
   */
  process: { readonly pid: number } | null;
  /** A terminal launch's pty, once started. */
  pty: PtyProcess | null;
  /** A web launch's `HARNESS_PORT`. */
  port: number | null;
  /**
   * Whether its program is a console program on Windows, which the polite step of the shutdown
   * sequence cannot end ({@link signalProcessTree}): set with its command.
   */
  consoleProgram: boolean;
  windowOpen: boolean;
  /** Whether a web launch's page is in its window. */
  webShown: boolean;
  /** Set when the process has exited. */
  processExited: boolean;
  /** Resolves when the process has exited. */
  readonly exited: Promise<void>;
  markExited(): void;
  stopping: Promise<void> | null;
  /** Set when the launch begins to end: its token is revoked, its row and log closed, its end state sent. */
  finished: Promise<void> | null;
  /** Resolves once the launch has ended. */
  readonly ended: Promise<void>;
  markEnded(): void;
}

/**
 * The Process Supervisor (P0-05): launches installed Harnesses following the launch contract of
 * docs/tech/architecture.md §4, one instance per Harness, and stops them with the shutdown
 * sequence. Both UI Kinds, with either runtime kind: a Node Harness's Entry runs on the Runtime's
 * Node (`nodeCommand`), a binary Harness's Entry for this platform is run directly, with the same
 * environment and working directory.
 *
 * A launch goes `preparing` → `spawning` → `ready` → (`stopping` →) `stopped`, or `failed` with a
 * reason, and every change is pushed with `emit` and to the launch's window. Preparing runs the
 * contract's steps in order: the Entry for this platform (`failed(platform_unsupported)`), the
 * Entry file (`failed(spawn_error)`), the Data Directory (created when missing), the Workspace
 * (chosen in the main window before `launch.start`; a Harness that requires one and got none
 * ends `failed(workspace_cancelled)`, and a chosen one is saved as its `last_workspace`), then the
 * Gateway Token, bound to the Workspace too, and the `launches` row (nothing before this step gets
 * either), then the log file, then, for a web UI Kind, a free port. The process runs in the
 * Workspace, or in the Data Directory without one, with the contract's environment:
 * `HARNESS_WORKSPACE` only when there is a Workspace. A terminal window opens next, and the
 * process starts in a pty of the terminal's size once the window reports it. A web window opens
 * at once on its Starting state and the process starts with its output piped to the log
 * (`waiting-ready`); the port is tried every 250 ms, and once it accepts a connection the
 * Harness's page comes into the window (`ready`). One that does not within
 * `ui.readyTimeoutSeconds` is stopped with the shutdown sequence and ends `failed(ready_timeout)`
 * with the last 50 lines of its log.
 *
 * Closing the window stops the Harness: SIGTERM to its process group, SIGKILL to the group after
 * {@link STOP_GRACE_MS} when the process or another process of its group is still there (at once
 * on Windows when the polite step cannot end it, as for every console program), the launch
 * recorded as ended at most {@link KILL_WAIT_MS} later, and it ends `stopped`. A Harness
 * that exits on its own ends `stopped` with code 0 and `failed(exit_nonzero)` otherwise; its
 * window stays open with the exit code (a terminal stays readable; a web page makes way for the
 * Crashed state, or a plain Exited one after code 0). When a process it started still runs in its
 * group once it exited, the group gets the shutdown sequence first (macOS and Linux; on Windows
 * the tree cannot be found once its root has exited). Either way the Gateway Token is revoked and
 * the `launches` row gets `ended_at`, `exit_code` and `token_revoked_at`. A launch is refused
 * while an install of the same Harness is putting its files in place (`harness_installing`).
 */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  const { installs, launches, paths, windows, tokens } = options;
  const now = options.now ?? (() => new Date());
  const environment = options.environment ?? (() => process.env);
  const spawnProcess = options.spawnProcess ?? spawnPiped;
  const askPort = options.freePort ?? freePort;
  const openPath = options.openPath ?? (() => Promise.resolve(true));
  const pickFolder = options.pickFolder ?? (() => Promise.resolve(null));
  const logError =
    options.logError ??
    ((message: string, error: unknown) => {
      console.error(message, error);
    });
  /** Opens `path` with the OS; `open_failed`, naming it, when the OS could not. */
  const open = async (path: string): Promise<IpcResult<null>> =>
    (await openPath(path)) ? ok(null) : fail('open_failed', { path });
  /**
   * Opens `log` when that file exists, else the Harness's logs folder, created: the paths are the
   * Runtime's own, never one a window sent.
   */
  const openLogOrFolder = async (harnessId: string, log: string | null) => {
    if (log !== null && (await isFile(log))) return open(log);
    const folder = paths.logsDir(harnessId);
    await mkdir(folder, { recursive: true });
    return open(folder);
  };
  /** The latest launch of each Harness. */
  const byHarness = new Map<string, Launch>();
  /** The same launches by launch id. */
  const byLaunch = new Map<string, Launch>();
  let closing = false;

  const statusOf = (launch: Launch): LaunchStatus => ({
    harnessId: launch.install.harnessId,
    launchId: launch.launchId,
    state: launch.state,
    ...(launch.reason === undefined ? {} : { reason: launch.reason }),
    ...(launch.exitCode === undefined ? {} : { exitCode: launch.exitCode }),
    startedAt: launch.startedAt,
    ...(launch.logTail === undefined ? {} : { logTail: launch.logTail }),
  });

  /**
   * Records a launch's new state and pushes it. A push that fails is logged, never thrown: the
   * shutdown sequence and the end of a launch push states too, and must run to the end.
   */
  const setState = (launch: Launch, state: LaunchState, reason?: LaunchFailure) => {
    launch.state = state;
    launch.reason = reason;
    const status = statusOf(launch);
    try {
      options.emit(status);
      if (launch.windowOpen) windows.send(launch.launchId, 'window.state', status);
    } catch (error) {
      logError(`Could not send the state of launch ${launch.launchId}`, error);
    }
  };

  const runtimeLine = (launch: Launch, text: string) => {
    launch.log?.write('runtime', `${text}\n`);
  };

  /**
   * Ends a launch once: revokes its token and closes its `launches` row (when it got them), closes
   * its log, then sends its end state.
   */
  const finish = (launch: Launch, end: LaunchEnd): Promise<void> => {
    launch.finished ??= (async () => {
      launch.command = null;
      if (launch.tokenIssued) {
        tokens.revokeLaunch(launch.launchId);
        const at = now().toISOString();
        try {
          launches.end(launch.launchId, {
            endedAt: at,
            exitCode: launch.exitCode ?? null,
            tokenRevokedAt: at,
          });
        } catch (error) {
          logError(`Could not record the end of launch ${launch.launchId}`, error);
        }
      }
      await launch.log?.close();
      if (end.state === 'failed' && end.reason === 'ready_timeout') {
        launch.logTail = launch.log?.tail() ?? [];
      }
      if (launch.webShown && launch.windowOpen) windows.hideWeb(launch.launchId);
      setState(launch, end.state, end.state === 'failed' ? end.reason : undefined);
      launch.markEnded();
    })();
    return launch.finished;
  };

  /** The contract's steps up to opening the window; see {@link createSupervisor}. */
  const prepare = async (launch: Launch) => {
    const { install } = launch;
    const { harnessId, manifest } = install;
    const entry = entryFor(manifest, options.platform);
    if (entry === null || options.platform === null) {
      await finish(launch, { state: 'failed', reason: 'platform_unsupported' });
      return;
    }
    const entryPath = join(install.installPath, ...entry.split('/'));
    if (!(await isFile(entryPath))) {
      logError(`The Entry of ${harnessId} is missing: ${entryPath}`, null);
      await finish(launch, { state: 'failed', reason: 'spawn_error' });
      return;
    }
    await mkdir(install.dataDir, { recursive: true });
    const { workspace } = launch;
    if (manifest.workspace === 'required' && workspace === null) {
      await finish(launch, { state: 'failed', reason: 'workspace_cancelled' });
      return;
    }
    // Saved whenever a folder is used; launching without one keeps the last.
    if (workspace !== null) installs.setLastWorkspace(harnessId, workspace);
    if (stopWasRequested(launch)) {
      await finish(launch, { state: 'stopped' });
      return;
    }

    const locale = options.locale();
    const token = tokens.issueToken({
      harnessId,
      harnessVersion: install.version,
      launchId: launch.launchId,
      locale,
      ...(workspace === null ? {} : { workspace }),
    });
    launch.tokenIssued = true;
    launches.begin({
      launchId: launch.launchId,
      harnessId,
      version: install.version,
      startedAt: launch.startedAt,
    });
    installs.markLaunched(harnessId, launch.startedAt);

    // The Harness keeps its newest logs, this launch's included.
    const logsDir = paths.logsDir(harnessId);
    await mkdir(logsDir, { recursive: true });
    await pruneLaunchLogs(logsDir, KEPT_LAUNCH_LOGS - 1);
    launch.log = openLaunchLog(join(logsDir, `${launch.launchId}.log`), { now });
    const web = manifest.ui.kind === 'web';
    if (web) {
      // Checked and recorded in one step after the OS answers, so two web launches preparing at
      // once never get the same port.
      await pickPort((port) => {
        if (portsInUse(launch).has(port)) return false;
        launch.port = port;
        return true;
      }, askPort);
    }
    if (stopWasRequested(launch)) {
      await finish(launch, { state: 'stopped' });
      return;
    }

    // A Node Entry runs on the Runtime's Node; a binary one is the program itself.
    const node = manifest.runtime.kind === 'node';
    const command = {
      file: node ? options.nodeCommand.path : entryPath,
      args: node ? [entryPath] : [],
      cwd: workspace ?? install.dataDir,
      env: {
        ...launchEnvironment(environment(), {
          gatewayUrl: options.gatewayUrl,
          token,
          harnessId,
          version: install.version,
          dataDir: install.dataDir,
          locale,
          platform: options.platform,
          ...(workspace === null ? {} : { workspace }),
          ...(launch.port === null ? {} : { port: launch.port }),
        }),
        ...(node ? options.nodeCommand.env : {}),
      },
    };
    // ConPTY hosts console programs only, and node.exe is one.
    launch.consoleProgram = launch.port === null || node || isConsoleProgram(command.file);
    launch.windowOpen = true;
    setState(launch, 'spawning');
    const spec = { launchId: launch.launchId, harnessId, name: manifest.name };
    const onClosed = () => {
      launch.windowOpen = false;
      void stop(launch);
    };
    if (launch.port === null) {
      launch.command = command;
      windows.openTerminal(spec, onClosed);
      return;
    }
    windows.openWeb({ ...spec, size: manifest.ui.window ?? {} }, onClosed);
    await runWeb(launch, command, launch.port);
  };

  /** The ports of the web launches that have not ended, but `launch`'s own. */
  const portsInUse = (launch: Launch): Set<number> =>
    new Set(
      [...byLaunch.values()].flatMap((other) =>
        other !== launch && other.finished === null && other.port !== null ? [other.port] : [],
      ),
    );

  /** What every process does on exit: record it, then end the launch unless a stop is under way. */
  const onProcessExit = (launch: Launch, { exitCode, signal: number }: PtyExit) => {
    launch.exitCode = exitCode;
    runtimeLine(
      launch,
      number === undefined
        ? `Exited with code ${String(exitCode)}`
        : `Ended by signal ${String(number)} (code ${String(exitCode)})`,
    );
    launch.processExited = true;
    launch.markExited();
    // A stop that was asked for ends the launch itself, once the exit came or it gave up.
    if (launch.stopRequested) return;
    const end: LaunchEnd =
      exitCode === 0 ? { state: 'stopped' } : { state: 'failed', reason: 'exit_nonzero' };
    // A process it started still runs in its group (a server it forked, say): the shutdown
    // sequence stops the group before the launch ends, as nothing could stop it afterwards.
    const child = launch.process;
    if (child !== null && processTreeAlive(child.pid)) {
      runtimeLine(launch, 'Processes it started are still running');
      launch.stopRequested = true;
      launch.stopping = stopProcess(launch, child, end);
      return;
    }
    void finish(launch, end);
  };

  /**
   * Starts a web launch's process with its output piped to the log, then waits for its port; see
   * {@link createSupervisor}.
   */
  const runWeb = async (launch: Launch, command: SpawnCommand, port: number) => {
    let child: Awaited<ReturnType<PipedSpawner>>;
    try {
      child = await spawnProcess(command);
    } catch (error) {
      runtimeLine(launch, `Could not start ${command.file}: ${messageOf(error)}`);
      logError(`Could not start ${launch.install.harnessId}`, error);
      await finish(launch, { state: 'failed', reason: 'spawn_error' });
      return;
    }
    launch.process = child;
    runtimeLine(
      launch,
      `Started ${[command.file, ...command.args].join(' ')} (pid ${String(child.pid)}), port ${String(port)}`,
    );
    child.onOutput((source, text) => {
      launch.log?.write(source, text);
    });
    child.onExit((exit) => {
      onProcessExit(launch, exit);
    });
    // The window closed, or the app began quitting, while it was starting.
    if (stopWasRequested(launch)) {
      launch.stopping ??= stopProcess(launch, child, { state: 'stopped' });
      return;
    }
    setState(launch, 'waiting-ready');

    const { ui } = launch.install.manifest;
    const seconds = ui.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS;
    const outcome = await waitForPort(
      port,
      seconds * 1000,
      () => launch.stopRequested || launch.processExited || launch.finished !== null,
    );
    if (outcome === 'ready') {
      launch.webShown = true;
      windows.showWeb(launch.launchId, `http://${LOOPBACK}:${String(port)}${ui.path ?? '/'}`);
      runtimeLine(launch, `Accepting connections on ${LOOPBACK}:${String(port)}`);
      setState(launch, 'ready');
    } else if (outcome === 'timeout') {
      runtimeLine(
        launch,
        `Did not accept connections on ${LOOPBACK}:${String(port)} within ${String(seconds)} s`,
      );
      launch.stopRequested = true;
      launch.stopping ??= stopProcess(launch, child, {
        state: 'failed',
        reason: 'ready_timeout',
      });
    }
    // Cancelled: the process exited, or a stop is under way; either one ends the launch.
  };

  /** Starts the process of a terminal launch in a pty of the window's size. */
  const spawnIn = (launch: Launch, size: TerminalSize) => {
    const { command } = launch;
    if (command === null || launch.finished !== null) return;
    launch.command = null;
    let child: PtyProcess;
    try {
      child = options.spawnPty({ ...command, ...size });
    } catch (error) {
      runtimeLine(launch, `Could not start ${command.file}: ${messageOf(error)}`);
      logError(`Could not start ${launch.install.harnessId}`, error);
      void finish(launch, { state: 'failed', reason: 'spawn_error' });
      return;
    }
    launch.pty = child;
    launch.process = child;
    // On Windows the pid is not known yet (see PtyProcess.pid); the signal lines name it.
    const started = `Started ${[command.file, ...command.args].join(' ')}`;
    runtimeLine(launch, child.pid > 0 ? `${started} (pid ${String(child.pid)})` : started);
    child.onData((data) => {
      launch.log?.write('pty', data);
      if (launch.windowOpen) windows.send(launch.launchId, 'terminal.data', data);
    });
    child.onExit((exit) => {
      onProcessExit(launch, exit);
      child.dispose();
    });
    setState(launch, 'ready');
  };

  /**
   * The shutdown sequence of a launch whose process runs. SIGKILL goes to the process group when
   * the process, or any process of its group, is still there after the grace period: a process
   * the Harness started may ignore SIGTERM although the Harness itself exits on it. On Windows,
   * when the polite step cannot end the tree (a console program, see {@link signalProcessTree}),
   * the forced step follows at once instead of after the grace period.
   */
  const stopProcess = async (launch: Launch, child: { readonly pid: number }, end: LaunchEnd) => {
    setState(launch, 'stopping');
    // A pty whose pid is not known yet (Windows, just spawned) gets nothing now; SIGKILL, after
    // the grace period, reads it again.
    const signal = (name: StopSignal): Promise<SignalOutcome> => {
      const { pid } = child;
      if (pid <= 0) {
        runtimeLine(launch, `Could not send ${name}: the process id is not known yet`);
        return Promise.resolve('sent');
      }
      runtimeLine(launch, `Sent ${name} to ${String(pid)} and its children`);
      return signalProcessTree(pid, name, { consoleProgram: launch.consoleProgram });
    };
    // Settles only when the polite step was refused: it then cuts the grace period short.
    const refused = signal('SIGTERM').then((outcome) => {
      if (outcome === 'sent') return NEVER;
      runtimeLine(launch, 'SIGTERM cannot end it on Windows: SIGKILL follows now');
      return undefined;
    });
    const graceEnds = Date.now() + STOP_GRACE_MS;
    const exitedInTime = await settlesWithin(launch.exited, STOP_GRACE_MS, refused);
    if (!exitedInTime || !(await processTreeEndsWithin(child.pid, graceEnds - Date.now()))) {
      // Not awaited: a taskkill that hangs must not keep the launch from being recorded as ended.
      void signal('SIGKILL');
      if (!(await settlesWithin(launch.exited, KILL_WAIT_MS))) {
        runtimeLine(launch, 'The process did not report its exit; the launch is recorded as ended');
      }
    }
    await finish(launch, end);
  };

  /** Stops a launch at whatever step it is; resolves once it has ended. */
  const stop = (launch: Launch): Promise<void> => {
    if (launch.finished !== null) return launch.finished;
    if (launch.stopping !== null) return launch.stopping;
    launch.stopRequested = true;
    const child = launch.process;
    if (child !== null) {
      launch.stopping = stopProcess(launch, child, { state: 'stopped' });
      return launch.stopping;
    }
    // A terminal launch waiting for its window to report its size: nothing runs yet.
    if (launch.command !== null) return finish(launch, { state: 'stopped' });
    // Preparing, or a web launch's process starting: its next step sees `stopRequested` and ends
    // the launch there.
    return launch.ended;
  };

  const start = async (
    harnessId: string,
    chosen: string | null = null,
  ): Promise<IpcResult<LaunchStarted>> => {
    const install = installs.get(harnessId);
    if (install === undefined) return fail('not_installed');
    // A Harness that declares no Workspace never gets one: a folder sent for it is not checked.
    const folder = (install.manifest.workspace ?? 'none') === 'none' ? null : chosen;
    // The folder the User chose in the main window, checked again here: it may have gone since.
    // The check is async, so a folder on a network share that no longer answers never blocks the
    // main process; one that runs already is only focused, and is not checked.
    const running = byHarness.get(harnessId)?.finished === null;
    if (folder !== null && !running && !(await isAbsoluteDirectory(folder))) {
      return fail('invalid_input', { method: 'launch.start' });
    }
    // Synchronous from here: whether it runs already, and what it launches with, are decided in
    // one step, after anything that happened while the folder was checked.
    return launchNow(harnessId, folder);
  };

  /**
   * {@link start} once its Workspace has been checked: `folder` is null or an existing folder,
   * unless the Harness runs, which is then only focused.
   */
  const launchNow = (harnessId: string, folder: string | null): IpcResult<LaunchStarted> => {
    const install = installs.get(harnessId);
    if (install === undefined) return fail('not_installed');
    const current = byHarness.get(harnessId);
    if (current?.finished === null) {
      // One instance per Harness: bring it to the front. One that is stopping is left to stop.
      if (current.state !== 'stopping') windows.focus(current.launchId);
      return ok({ outcome: 'focused', launchId: current.launchId });
    }
    if (closing) return fail('internal_error', { method: 'launch.start' });
    // Its files are being replaced: it would run from a folder about to be deleted.
    if (options.isInstalling?.(harnessId) === true) return fail('harness_installing');
    if (!options.defaultSlotBound(harnessId)) return fail('slot_unbound', { slot: 'default' });
    // A reinstall while the folder was checked may have changed what the Manifest declares.
    const workspace =
      folder === null || (install.manifest.workspace ?? 'none') === 'none' ? null : resolve(folder);

    // The window of the previous launch, still open on its exit code, makes way for the new one.
    if (current !== undefined) {
      if (current.windowOpen) windows.close(current.launchId);
      byLaunch.delete(current.launchId);
    }
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    let markEnded: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    const launch: Launch = {
      launchId: randomUUID(),
      install,
      workspace,
      startedAt: now().toISOString(),
      state: 'preparing',
      stopRequested: false,
      tokenIssued: false,
      log: null,
      command: null,
      process: null,
      pty: null,
      port: null,
      consoleProgram: false,
      windowOpen: false,
      webShown: false,
      processExited: false,
      exited,
      markExited,
      stopping: null,
      finished: null,
      ended,
      markEnded,
    };
    byHarness.set(harnessId, launch);
    byLaunch.set(launch.launchId, launch);
    setState(launch, 'preparing');
    prepare(launch).catch((error: unknown) => {
      logError(`Could not launch ${harnessId}`, error);
      runtimeLine(launch, `Could not start: ${messageOf(error)}`);
      const end: LaunchEnd = { state: 'failed', reason: 'spawn_error' };
      // A process already started is stopped with the shutdown sequence before the launch ends,
      // so it never runs on, unseen, beside a new launch of the same Harness.
      if (launch.process !== null && !launch.processExited) {
        launch.stopRequested = true;
        launch.stopping ??= stopProcess(launch, launch.process, end);
      } else {
        void finish(launch, end);
      }
      if (launch.windowOpen) windows.close(launch.launchId);
    });
    return ok({ outcome: 'started', launchId: launch.launchId });
  };

  return {
    start,
    async chooseWorkspace(harnessId) {
      const install = installs.get(harnessId);
      if (install === undefined) return fail('not_installed');
      const last = install.lastWorkspace;
      const from = last !== null && (await isDirectory(last)) ? last : null;
      return ok(await pickFolder(from));
    },
    async lastWorkspace(harnessId) {
      const install = installs.get(harnessId);
      if (install === undefined) return fail('not_installed');
      const path = install.lastWorkspace;
      return ok(path === null ? null : { path, exists: await isDirectory(path) });
    },
    status: () => [...byHarness.values()].map(statusOf),
    async openLogs(harnessId) {
      if (installs.get(harnessId) === undefined) return fail('not_installed');
      const latest = byHarness.get(harnessId)?.log?.path;
      const log =
        latest !== undefined && (await isFile(latest))
          ? latest
          : await newestLaunchLog(paths.logsDir(harnessId));
      return openLogOrFolder(harnessId, log);
    },
    async openDataFolder(harnessId) {
      const install = installs.get(harnessId);
      if (install === undefined) return fail('not_installed');
      await mkdir(install.dataDir, { recursive: true });
      return open(install.dataDir);
    },
    isRunning: (harnessId) => byHarness.get(harnessId)?.finished === null,
    async stopAll() {
      closing = true;
      const running = [...byHarness.values()].filter((launch) => launch.finished === null);
      await settlesWithin(
        Promise.all(running.map(stop)).then(() => undefined),
        STOP_ALL_CAP_MS,
      );
    },
    window(launchId) {
      const launch = byLaunch.get(launchId);
      if (launch === undefined) return null;
      const { harnessId } = launch.install;
      return {
        harnessId,
        async info() {
          return {
            harnessId,
            name: launch.install.manifest.name,
            uiKind: launch.install.manifest.ui.kind,
            readyTimeoutSeconds:
              launch.install.manifest.ui.kind === 'web'
                ? (launch.install.manifest.ui.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS)
                : null,
            iconDataUrl: await readIcon(launch.install.installPath),
            locale: options.locale(),
            status: statusOf(launch),
          };
        },
        openLogs: () => openLogOrFolder(harnessId, launch.log?.path ?? null),
        relaunch: () => start(harnessId, launch.workspace),
        close() {
          windows.close(launchId);
        },
        reload() {
          if (launch.webShown && launch.state === 'ready') windows.reloadWeb(launchId);
        },
        webLayout(area) {
          if (launch.port !== null && launch.windowOpen) windows.layoutWeb(launchId, area);
        },
        terminalReady(size) {
          if (launch.pty === null) spawnIn(launch, size);
          else resize(launch, size);
        },
        terminalInput(data) {
          if (launch.pty === null || launch.finished !== null || launch.stopping !== null) return;
          try {
            launch.pty.write(data);
          } catch {
            // The process is exiting; its exit ends the launch.
          }
        },
        terminalResize(size) {
          resize(launch, size);
        },
      };
    },
  };
}

/** Whether a stop was asked for meanwhile (read across awaits, so never narrowed). */
function stopWasRequested(launch: Launch): boolean {
  return launch.stopRequested;
}

function resize(launch: Launch, size: TerminalSize): void {
  if (launch.pty === null || launch.finished !== null) return;
  try {
    launch.pty.resize(size.cols, size.rows);
  } catch {
    // The process is exiting; its exit ends the launch.
  }
}

/** A promise that never settles: nothing cuts a wait short. */
const NEVER = new Promise<never>(() => undefined);

/** Whether `promise` settles within `ms`; false as soon as `cutShort` settles first. */
async function settlesWithin(
  promise: Promise<void>,
  ms: number,
  cutShort: Promise<void> = NEVER,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout, cutShort.then(() => false)]);
  } finally {
    clearTimeout(timer);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `path` is an absolute path to an existing folder. */
async function isAbsoluteDirectory(path: string): Promise<boolean> {
  if (!isAbsolute(path) || path.includes('\0')) return false;
  return isDirectory(path);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Supervisor of a Runtime that cannot launch: its database or Model Gateway did not start
 * (the window shows only the startup error screen), or no Harness windows can be opened (tests
 * that do not launch). Launching answers `not_implemented`.
 */
export function createSupervisorStub(): Supervisor {
  return {
    start: () => Promise.resolve(fail('not_implemented', { method: 'launch.start' })),
    chooseWorkspace: () =>
      Promise.resolve(fail('not_implemented', { method: 'launch.chooseWorkspace' })),
    lastWorkspace: () =>
      Promise.resolve(fail('not_implemented', { method: 'launch.lastWorkspace' })),
    status: () => [],
    openLogs: () => Promise.resolve(fail('not_implemented', { method: 'launch.openLogs' })),
    openDataFolder: () =>
      Promise.resolve(fail('not_implemented', { method: 'launch.openDataFolder' })),
    isRunning: () => false,
    stopAll: () => Promise.resolve(),
    window: () => null,
  };
}
