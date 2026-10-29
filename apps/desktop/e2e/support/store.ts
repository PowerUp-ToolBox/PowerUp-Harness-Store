/**
 * The local Store of the acceptance journey: the Supabase project of apps/store on a local stack
 * in Docker, its Edge Functions served, and the fake GitHub its Auth signs Publishers in with
 * (apps/store/test-store/fake-github.ts), so no step reaches a real service.
 *
 * The stack is started once per run (store.setup.ts) and stopped at the end (store.teardown.ts),
 * keeping its database volume. It is always restarted first with the fake GitHub's values of
 * supabase/.env.example in its environment, which the Supabase CLI prefers to supabase/.env: a real
 * OAuth app configured there for manual testing is left alone, but not used by this run. Each
 * attempt of the journey then seeds the catalogue afresh, so a retry can publish the same version
 * again.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { storeRoot, supabaseBin } from '../../../store/scripts/local-stack.ts';
import {
  signInBrowser,
  startFakeGitHub,
  stopFakeGitHub,
  type GitHubIdentity,
} from '../../../store/test-store/fake-github.ts';
import { osEnvironment } from './app.ts';

const STORE_DIR = storeRoot();
/** The Supabase services the Store does not use, which are not started (as in CI). */
const UNUSED_SERVICES = 'studio,imgproxy,postgres-meta,mailpit,logflare,vector,supavisor';
const FUNCTIONS_READY_MS = 120_000;

/** Where setup leaves what teardown needs, and the Edge Functions' log, in the run's output. */
export const STORE_STATE_DIR = join(import.meta.dirname, '..', 'test-results', 'store');
const STATE_FILE = join(STORE_STATE_DIR, 'state.json');
export const FUNCTIONS_LOG = join(STORE_STATE_DIR, 'functions.log');

/**
 * The Publisher the journey signs in as: `harness-store`, the publisher part of hello-web's
 * Harness ID (`harness-store/hello-web`), so its Harness Package publishes unchanged. The same
 * GitHub account every run, so the Store keeps one profile for it.
 */
export const PUBLISHER: GitHubIdentity = {
  id: 90_000_001,
  login: 'harness-store',
  name: 'Harness Store E2E',
  email: 'harness-store-e2e@fake-github.invalid',
};

/**
 * The Supabase CLI's environment: the OS's, plus the variables of supabase/.env.example, which
 * point Auth's GitHub provider at the fake GitHub, over any value in supabase/.env.
 */
function cliEnvironment(): Record<string, string> {
  const example = readFileSync(join(STORE_DIR, 'supabase', '.env.example'), 'utf8');
  const values = [...example.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/gm)].map(
    ([, key = '', value = '']): [string, string] => [key, value.trim()],
  );
  const env: Record<string, string> = { ...osEnvironment(), SUPABASE_TELEMETRY_DISABLED: '1' };
  // Where the Docker CLI finds the engine, when this machine says so.
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...Object.fromEntries(values) };
}

/** Runs the pinned Supabase CLI in apps/store; throws with its output when it fails. */
function supabase(args: string[]): void {
  run(process.execPath, [supabaseBin(STORE_DIR), ...args], `supabase ${args.join(' ')}`);
}

function run(command: string, args: string[], shown: string): void {
  const result = spawnSync(command, args, {
    cwd: STORE_DIR,
    env: cliEnvironment(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `\`${shown}\` failed (${String(result.status ?? result.signal)}):\n${result.stdout}\n${result.stderr}`,
      { cause: result.error },
    );
  }
}

/**
 * Starts the local Store: Docker must run. Stops a stack left running (keeping its data),
 * starts it with the fake GitHub's values, applies any migration its database lacks, serves the
 * Edge Functions in the background and starts the fake GitHub.
 */
export async function startStore(): Promise<void> {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    throw new Error(
      'The acceptance journey needs Docker for the local Supabase stack: start Docker and run it again.',
    );
  }
  mkdirSync(STORE_STATE_DIR, { recursive: true });
  stopFakeGitHub();
  supabase(['stop']);
  supabase(['start', '-x', UNUSED_SERVICES]);
  supabase(['migration', 'up', '--local']);

  const log = openSync(FUNCTIONS_LOG, 'w');
  const functions = spawn(process.execPath, [supabaseBin(STORE_DIR), 'functions', 'serve'], {
    cwd: STORE_DIR,
    env: cliEnvironment(),
    stdio: ['ignore', log, log],
    // Its own process group on macOS and Linux, so teardown ends the CLI and what it started.
    detached: process.platform !== 'win32',
  });
  closeSync(log);
  functions.unref();
  writeFileSync(STATE_FILE, JSON.stringify({ functionsPid: functions.pid }));
  const deadline = Date.now() + FUNCTIONS_READY_MS;
  while (!readFileSync(FUNCTIONS_LOG, 'utf8').includes('Serving functions on')) {
    if (functions.exitCode !== null || functions.signalCode !== null || Date.now() > deadline) {
      throw new Error(`The Edge Functions did not start:\n${readFileSync(FUNCTIONS_LOG, 'utf8')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await startFakeGitHub();
}

/** Stops what {@link startStore} started, the stack last, keeping its database volume. */
export function stopStore(): void {
  try {
    const { functionsPid } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as {
      functionsPid?: number;
    };
    if (functionsPid !== undefined) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(functionsPid), '/t', '/f'], { stdio: 'ignore' });
      } else {
        process.kill(-functionsPid, 'SIGTERM');
      }
    }
  } catch {
    // Never started, or already gone.
  }
  stopFakeGitHub();
  supabase(['stop']);
}

/**
 * Replaces the catalogue with the seed (apps/store `pnpm seed`): every Harness and stored object
 * is deleted first, the hello-web this journey published on an earlier attempt included.
 */
export function seedStore(): void {
  run(process.execPath, [join('dist', 'scripts', 'seed.js')], 'node dist/scripts/seed.js');
}

/**
 * Makes the app's "open in browser" record the URL instead (no browser opens), for
 * {@link completeSignIn}. Every other part of the sign-in is the app's own.
 */
export async function captureBrowser(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { e2eOpenedUrls?: string[] }).e2eOpenedUrls = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
}

/**
 * Plays the User's browser for the sign-in the app just opened (after {@link captureBrowser}):
 * the Store's Auth, consent on the fake GitHub as {@link PUBLISHER}, and Auth's redirect to
 * `harnessstore://auth-callback`, which the OS then hands to the app (`open-url`, which the app
 * handles the same way on every OS).
 */
export async function completeSignIn(app: ElectronApplication): Promise<void> {
  let opened: string | undefined;
  const deadline = Date.now() + 10_000;
  while (opened === undefined) {
    opened = await app.evaluate(() =>
      (globalThis as { e2eOpenedUrls?: string[] }).e2eOpenedUrls?.shift(),
    );
    if (opened !== undefined) break;
    if (Date.now() > deadline) throw new Error('The app opened no sign-in page in the browser.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let callback: string | undefined;
  await signInBrowser(
    () => PUBLISHER,
    (url) => {
      callback = url;
      return true;
    },
  )(opened);
  if (callback === undefined) throw new Error('The sign-in never came back to the app.');
  await app.evaluate(({ app: electronApp }, url) => {
    electronApp.emit('open-url', { preventDefault: () => undefined }, url);
  }, callback);
}
