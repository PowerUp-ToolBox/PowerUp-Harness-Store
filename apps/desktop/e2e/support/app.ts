/**
 * The app under test and the fakes around it: the built desktop app (electron-vite's out/, so
 * `app.isPackaged` is false) launched by Playwright on a fresh profile with a scrubbed
 * environment, and the fake Ollama it detects.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';

/** apps/desktop. */
export const DESKTOP_DIR = join(import.meta.dirname, '..', '..');
/** The repository root. */
export const REPO_DIR = join(DESKTOP_DIR, '..', '..');
/** hello-web's built Harness folder (P0-06.3): what the journeys publish and install. */
export const HELLO_WEB_FOLDER = join(REPO_DIR, 'examples', 'hello-web', 'out');

/** The model the fake Ollama advertises, as a User would have pulled it. */
export const OLLAMA_MODEL = 'qwen3:8b';
/** Ollama's port, which the app probes unless told otherwise. */
const OLLAMA_PORT = 11434;

/**
 * Variables a launched app may see: the OS's own (paths, temp folders, the display and the
 * session bus a Linux keyring answers on). Everything else in the shell running the tests, API
 * keys included, never reaches the app or a Harness it starts.
 */
const PASSED_THROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'ProgramFiles',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
];

/** The OS part of this process's environment, as {@link PASSED_THROUGH} lists it. */
export function osEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Starts the fake Provider as Ollama: on `E2E_OLLAMA_PORT` (default 11434, Ollama's own), serving
 * {@link OLLAMA_MODEL} as an echo, so the reply to a message is that message. A port in use
 * fails with what to do about it.
 */
export async function startFakeOllama(): Promise<FakeProvider> {
  const port = Number(process.env.E2E_OLLAMA_PORT ?? OLLAMA_PORT);
  try {
    return await startFakeProvider({ port, aliases: { [OLLAMA_MODEL]: 'fake/echo' } });
  } catch (error) {
    throw new Error(
      `The fake Ollama could not listen on 127.0.0.1:${String(port)}, probably because a real ` +
        'Ollama (or another program) uses it. Stop it, or set E2E_OLLAMA_PORT to a free port.',
      { cause: error },
    );
  }
}

export interface LaunchedApp {
  readonly app: ElectronApplication;
  /** The main window. */
  readonly window: Page;
  /** Closes the app, keeps its logs with the test's output on failure, deletes the profile. */
  close(): Promise<void>;
}

/**
 * Launches the built desktop app on a new, empty profile (`HARNESS_STORE_USER_DATA_DIR`): no
 * Connection, no install, no session. The app looks for Ollama where `ollama` listens.
 */
export async function launchApp(ollama: FakeProvider, testInfo: TestInfo): Promise<LaunchedApp> {
  const main = join(DESKTOP_DIR, 'out', 'main', 'index.js');
  if (!existsSync(main)) {
    throw new Error(`${main} is missing: run \`pnpm build\` at the repository root first.`);
  }
  const profile = mkdtempSync(join(tmpdir(), 'harness-store-e2e-'));
  const env: Record<string, string> = {
    ...osEnvironment(),
    HARNESS_STORE_USER_DATA_DIR: profile,
  };
  // Only when the fake cannot be where Ollama is: otherwise detection runs exactly as shipped.
  if (ollama.port !== OLLAMA_PORT) env.HARNESS_STORE_DEV_OLLAMA_URL = ollama.url;
  // On Linux the session's encryption needs a keyring on the session bus: CI's acceptance job
  // starts GNOME Keyring on one, which Chromium uses only when told to (it would otherwise fall
  // back to `basic_text`, and the app then refuses to keep a session). With no session bus (the
  // smoke job) there is no keyring to ask, and nothing in that journey is encrypted.
  const keyring =
    process.platform === 'linux' && env.DBUS_SESSION_BUS_ADDRESS !== undefined
      ? ['--password-store=gnome-libsecret']
      : [];
  const executablePath = createRequire(import.meta.url)('electron') as string;
  const app = await _electron.launch({ executablePath, args: [main, ...keyring], env });
  const window = await app.firstWindow();
  return {
    app,
    window,
    async close() {
      try {
        await app.close();
      } finally {
        const logs = join(profile, 'logs');
        if (testInfo.status !== testInfo.expectedStatus && existsSync(logs)) {
          cpSync(logs, testInfo.outputPath('profile-logs'), { recursive: true });
        }
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
  };
}

/**
 * Makes the OS folder picker answer `folder`, as the User choosing it would. The native dialog is
 * the one screen Playwright cannot drive; the app's own screens around it are clicked as usual.
 */
export async function answerFolderPicker(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);
}
