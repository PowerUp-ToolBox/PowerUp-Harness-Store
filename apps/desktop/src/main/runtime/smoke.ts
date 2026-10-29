import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessWindowEventName, HarnessWindowEvents } from '../../shared/harness-ipc.js';
import type { IpcEventName, IpcEvents, LaunchStatus } from '../../shared/ipc.js';
import { startRuntime, type Runtime } from './bootstrap.js';
import { harnessPaths } from './harness-paths.js';
import type { PtySpawner } from './pty.js';
import type { SecretCipher } from './secret-cipher.js';
import type { HarnessWindows, NodeCommand } from './supervisor.js';

/**
 * The post-build smoke run (P0-13.3): a built app, started with the two variables of
 * {@link smokeRequest}, installs a terminal Harness from a folder, binds the `default` Slot to
 * {@link SMOKE_MODEL} on an `ollama` Connection at a fake Provider, launches it, sends one line and
 * expects it echoed back with one Usage Record, then exits 0, or 1 on any failure. Everything but
 * the windows is the real Runtime: the installer, Connections, Default Models, the Process
 * Supervisor, the pty (node-pty), the Model Gateway and the Node a Node Harness runs on (the app's
 * own executable with `ELECTRON_RUN_AS_NODE`), so a build whose native module or Node runtime is
 * missing or broken fails here. apps/desktop/scripts/smoke.mjs starts the fake Provider and the
 * built app; src/main/index.ts gives the run a fresh profile and exits with its result.
 *
 * Only environment variables start it, never a command-line argument, so a `harnessstore:` URL the
 * OS hands the app cannot. It talks to the Provider URL alone, which must be loopback: no Store,
 * no local detection, no stored secret.
 */

/** The folder of the Harness to install and run (examples/hello-term/out in CI). */
export const SMOKE_HARNESS_VARIABLE = 'HARNESS_STORE_SMOKE_HARNESS';
/** The fake Provider's base URL, such as `http://127.0.0.1:53124`. */
export const SMOKE_PROVIDER_VARIABLE = 'HARNESS_STORE_SMOKE_PROVIDER_URL';
/** The model the `default` Slot is bound to, as the fake Provider advertises it. */
export const SMOKE_MODEL = 'qwen3:8b';
/** How long the whole run may take before it counts as failed. */
export const SMOKE_TIMEOUT_MS = 120_000;

/** What a smoke run was asked for. */
export interface SmokeRequest {
  readonly harnessFolder: string;
  readonly providerUrl: string;
}

/** A smoke run the environment asks for, or why it is refused. */
export type SmokeRequestResult =
  | { readonly ok: true; readonly request: SmokeRequest }
  | { readonly ok: false; readonly error: string };

/**
 * The smoke run the environment asks for: null when {@link SMOKE_HARNESS_VARIABLE} is unset or
 * empty, so the app starts as usual; otherwise the request, or why it is refused (no Provider URL,
 * or one that is not `http:` on a loopback host).
 */
export function smokeRequest(
  env: Readonly<Record<string, string | undefined>>,
): SmokeRequestResult | null {
  const harnessFolder = env[SMOKE_HARNESS_VARIABLE];
  if (harnessFolder === undefined || harnessFolder === '') return null;
  const providerUrl = env[SMOKE_PROVIDER_VARIABLE] ?? '';
  let url: URL;
  try {
    url = new URL(providerUrl);
  } catch {
    return { ok: false, error: `${SMOKE_PROVIDER_VARIABLE} must be the fake Provider's URL.` };
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return {
      ok: false,
      error: `${SMOKE_PROVIDER_VARIABLE} must be an http:// URL on a loopback host, not ${providerUrl}.`,
    };
  }
  return { ok: true, request: { harnessFolder, providerUrl } };
}

/** How a smoke run in the app ends: see {@link endSmoke}. */
export interface SmokeEnd {
  /** The temporary profile of the run, deleted here. */
  readonly dataDir: string;
  /** Exits the app with this code (`app.exit`). */
  readonly exit: (code: number) => void;
  /** Prints an error line (stderr in the app). */
  readonly logError: (line: string, error: unknown) => void;
  /** Deletes a folder and everything in it; throws when it cannot. Default: `rmSync`. */
  readonly removeDir?: (dir: string) => void;
}

/**
 * Ends a smoke run in the app: deletes its temporary profile, then exits 0 when the run passed, 1
 * otherwise. The exit never depends on the deletion, which can fail (EBUSY, EPERM) on Windows
 * while Chromium's own processes, alive until the app exits, still hold files in the profile: the
 * error is logged and the folder left in the temp folder, rather than the app staying up with no
 * window until scripts/smoke.mjs kills it and fails a run that passed.
 */
export function endSmoke(passed: boolean, end: SmokeEnd): void {
  const removeDir =
    end.removeDir ??
    ((dir: string) => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  try {
    removeDir(end.dataDir);
  } catch (error) {
    end.logError(`[smoke] Could not delete the temporary profile ${end.dataDir}`, error);
  } finally {
    end.exit(passed ? 0 : 1);
  }
}

export interface SmokeOptions extends SmokeRequest {
  /** The app data root of the run: a new, empty folder the caller deletes afterwards. */
  readonly dataDir: string;
  /** The desktop app's version. */
  readonly version: string;
  /** Prints one line of progress (stdout in the app). */
  readonly log: (line: string) => void;
  /**
   * How the Node Harness runs. Default: this process's executable with `ELECTRON_RUN_AS_NODE=1`,
   * as the app runs every Node Harness.
   */
  readonly nodeCommand?: NodeCommand;
  /** Starts the Harness in a pty. Default: node-pty. */
  readonly spawnPty?: PtySpawner;
  /** The environment the Harness inherits before the launch contract. Default: this process's. */
  readonly harnessEnvironment?: () => Readonly<Record<string, string | undefined>>;
  /** Default: {@link SMOKE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** The terminal size the headless window reports. */
const SIZE = { cols: 100, rows: 30 };

/**
 * Runs the smoke turn; resolves true when it passed. Never rejects: a failure is logged with the
 * Harness's terminal output and its launch log, and resolves false. The Runtime is shut down (the
 * Harness stopped, the database closed) before it resolves, either way.
 */
export async function runSmoke(options: SmokeOptions): Promise<boolean> {
  const { log } = options;
  const started = Date.now();
  const step = (text: string) => {
    log(`[smoke +${((Date.now() - started) / 1000).toFixed(1)}s] ${text}`);
  };
  const windows = createHeadlessWindows();
  const usage: string[] = [];
  /** Set as the run goes: the Runtime, the installed Harness and its launch's latest state. */
  const state: { runtime?: Runtime; harnessId?: string; launch?: LaunchStatus } = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the run failed or timed out: a wait still polling then stops. */
  let abandoned = false;
  const timeoutMs = options.timeoutMs ?? SMOKE_TIMEOUT_MS;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${String(timeoutMs / 1000)} s`));
    }, timeoutMs);
  });

  const run = async () => {
    const runtime = await startRuntime({
      dataDir: options.dataDir,
      version: options.version,
      osLocale: () => 'en',
      quit: () => undefined,
      logError: (message, error) => {
        step(`${message}: ${String(error)}`);
      },
      // No Store: the connectivity, update and sign-in calls fail at once, never leaving the machine.
      fetch: refuseStore,
      storeFetch: refuseStore,
      providerFetch: (input, init) => globalThis.fetch(input, init),
      localProbeTargets: [],
      secretCipher: NO_SECRETS,
      emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => {
        if (event === 'launch.state') state.launch = payload as LaunchStatus;
        if (event === 'usage.recorded')
          usage.push((payload as IpcEvents['usage.recorded']).harnessId);
      },
      harnessWindows: windows,
      ...(options.nodeCommand === undefined ? {} : { nodeCommand: options.nodeCommand }),
      ...(options.spawnPty === undefined ? {} : { spawnPty: options.spawnPty }),
      ...(options.harnessEnvironment === undefined
        ? {}
        : { harnessEnvironment: options.harnessEnvironment }),
    });
    state.runtime = runtime;
    windows.attach(runtime);
    const { services, supervisor } = runtime;
    if (runtime.status.state === 'failed') {
      throw new Error(
        `The Runtime did not start: ${runtime.status.stage}, ${runtime.status.detail}`,
      );
    }
    step(`Runtime started, Model Gateway on port ${String(runtime.gatewayPort())}`);

    const connection = await services.connections.add({
      providerId: 'ollama',
      baseUrl: options.providerUrl,
    });
    if (!connection.ok) throw new Error(`Adding the Connection failed: ${connection.error.code}`);
    const bound = services.bindings.setGlobal({
      slot: 'default',
      target: { connectionId: connection.data.id, model: SMOKE_MODEL },
    });
    if (!bound.ok) throw new Error(`Binding the Default Model failed: ${bound.error.code}`);
    step(`Default Model: ${connection.data.id}/${SMOKE_MODEL} at ${options.providerUrl}`);

    const installed = await services.installs.installFromFolder(options.harnessFolder);
    if (!installed.ok) throw new Error(`Installing failed: ${installed.error.code}`);
    const { harnessId } = installed.data;
    state.harnessId = harnessId;
    step(`Installed ${harnessId} ${installed.data.version} from ${options.harnessFolder}`);

    const startedLaunch = await supervisor.start(harnessId, null);
    if (!startedLaunch.ok) throw new Error(`Launching failed: ${startedLaunch.error.code}`);
    const { launchId } = startedLaunch.data;
    /** Polls until `done`; throws once the launch has ended without it. */
    const waitFor = async (what: string, done: () => boolean) => {
      while (!done()) {
        if (abandoned) throw new Error('Abandoned');
        const { launch } = state;
        if (launch?.launchId === launchId && ['stopped', 'failed'].includes(launch.state)) {
          const reason = launch.reason === undefined ? '' : ` (${launch.reason})`;
          const code =
            launch.exitCode === undefined ? '' : `, exit code ${String(launch.exitCode)}`;
          throw new Error(`The Harness ended ${launch.state}${reason}${code} before ${what}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    await waitFor('its prompt', () => windows.screen(launchId).includes('> '));
    step(`Launched ${launchId}; the Harness printed its prompt`);
    const message = `smoke ${randomUUID()}`;
    supervisor.window(launchId)?.terminalInput(`${message}\r`);
    // Once as typed, once as the fake Provider's echo through the Model Gateway.
    await waitFor('the answer', () => windows.screen(launchId).split(message).length - 1 >= 2);
    await waitFor('its Usage Record', () => usage.includes(harnessId));
    const [record] = services.usage.query({
      from: null,
      to: null,
      harnessId,
      groupBy: ['model'],
    });
    if (usage.length !== 1 || record?.model !== SMOKE_MODEL || record.requests !== 1) {
      throw new Error(`Expected one Usage Record on ${SMOKE_MODEL}, got ${JSON.stringify(record)}`);
    }
    step(`Answer received ("${message}") and one Usage Record on ollama/${SMOKE_MODEL}`);
  };

  let passed = false;
  try {
    await Promise.race([run(), timedOut]);
    passed = true;
  } catch (error) {
    abandoned = true;
    step(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    for (const launchId of windows.launchIds()) {
      step(`Terminal output of ${launchId}:\n${windows.screen(launchId)}`);
    }
    const { harnessId, launch } = state;
    if (harnessId !== undefined && launch !== undefined) {
      const path = join(harnessPaths(options.dataDir).logsDir(harnessId), `${launch.launchId}.log`);
      const text = await readFile(path, 'utf8').catch(() => '(no launch log)');
      step(`Launch log ${path}:\n${text}`);
    }
  } finally {
    clearTimeout(timer);
    // Stops the Harness (the shutdown sequence) and closes the database.
    await state.runtime?.shutdown();
  }
  step(passed ? 'PASSED' : 'The smoke run failed');
  return passed;
}

/** The smoke run stores no secret: an Ollama Connection has no key. */
const NO_SECRETS: SecretCipher = {
  isAvailable: () => Promise.resolve(false),
  encrypt: () => Promise.reject(new Error('The smoke run stores no secret.')),
  decrypt: () => Promise.reject(new Error('The smoke run stores no secret.')),
};

const refuseStore = () => Promise.reject(new TypeError('The smoke run talks to no Store.'));

/**
 * Harness windows without a window: a terminal window's page reports itself ready at once, and
 * what the pty prints is kept, without the terminal's control sequences, for {@link screen}. A web
 * Harness has no page to show, so the smoke run takes terminal Harnesses only: its window closes
 * at once, which stops it.
 */
function createHeadlessWindows() {
  let runtime: Runtime | null = null;
  const output = new Map<string, string>();
  const onClose = new Map<string, () => void>();
  const closeWindow = (launchId: string) => {
    const onClosed = onClose.get(launchId);
    onClose.delete(launchId);
    onClosed?.();
  };
  return {
    attach(started: Runtime) {
      runtime = started;
    },
    launchIds: () => [...output.keys()],
    /** What the pty of `launchId` printed, without CSI and OSC sequences or carriage returns. */
    screen: (launchId: string) =>
      (output.get(launchId) ?? '')
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // eslint-disable-line no-control-regex
        .replace(/\x1b\][^\x07]*\x07/g, '') // eslint-disable-line no-control-regex
        .replace(/\r/g, ''),
    openTerminal(spec, onClosed) {
      output.set(spec.launchId, '');
      onClose.set(spec.launchId, onClosed);
      queueMicrotask(() => runtime?.supervisor.window(spec.launchId)?.terminalReady(SIZE));
    },
    openWeb(spec, onClosed) {
      onClose.set(spec.launchId, onClosed);
      queueMicrotask(() => {
        closeWindow(spec.launchId);
      });
    },
    showWeb: () => undefined,
    hideWeb: () => undefined,
    reloadWeb: () => undefined,
    layoutWeb: () => undefined,
    send<E extends HarnessWindowEventName>(
      launchId: string,
      event: E,
      payload: HarnessWindowEvents[E],
    ) {
      if (event === 'terminal.data' && output.has(launchId)) {
        output.set(launchId, (output.get(launchId) ?? '') + (payload as string));
      }
    },
    focus: (launchId) => onClose.has(launchId),
    close: closeWindow,
  } satisfies HarnessWindows & Record<string, unknown>;
}
