#!/usr/bin/env node
/**
 * `node scripts/smoke.mjs [executable [argument ...]]`: the post-build smoke test of a packaged
 * app (P0-13.3). It starts the fake Provider on a port the OS picks, serving `qwen3:8b`, then
 * starts the app electron-builder left unpacked in release/ (`mac-arm64/` or `mac/`,
 * `win-unpacked/`, `linux-unpacked/`; or the executable given, with the arguments after it) with
 * HARNESS_STORE_SMOKE_HARNESS set to examples/hello-term/out and HARNESS_STORE_SMOKE_PROVIDER_URL
 * to the fake. The app then runs src/main/runtime/smoke.ts instead of opening a window: it installs
 * hello-term and runs one turn through its own Model Gateway, on the Node runtime it runs every
 * Node Harness on (src/main/runtime/node-runtime.ts). This script exits with the app's exit code,
 * or 1 when the fake Provider did not get exactly that one chat request, or when the app is still
 * running after 150 s.
 *
 * `node scripts/smoke.mjs --unpackaged` (`pnpm smoke:unpackaged`) runs the same smoke on the
 * unpackaged app, after `pnpm build` only: the Electron of node_modules started on apps/desktop, as
 * `pnpm dev` starts it, which is `node scripts/smoke.mjs <electron> <apps/desktop>`. The `e2e-smoke`
 * CI job runs it, on Windows after scripts/fetch-node.mjs, whose node.exe the app then runs
 * hello-term on.
 *
 * The app gets only the OS's own environment variables (as e2e/support/app.ts passes them), so no
 * API key of the shell reaches it. Linux needs a display: CI runs this under `xvfb-run -a`. Build
 * first: `pnpm build` at the repository root, then `pnpm package` (or `electron-builder --dir`).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { startFakeProvider } from '@harness-store/gateway/testing/fake-provider';

const DESKTOP_DIR = join(import.meta.dirname, '..');
const HELLO_TERM = join(DESKTOP_DIR, '..', '..', 'examples', 'hello-term', 'out');
const RELEASE_DIR = join(DESKTOP_DIR, 'release');
const MODEL = 'qwen3:8b';
const LIMIT_MS = 150_000;

/** Variables the app may see: the OS's own, as e2e/support/app.ts lists them. */
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

/** The unpacked app's executable electron-builder wrote for this OS and architecture. */
function packagedExecutable() {
  const candidates = {
    darwin: (process.arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-arm64']).map((dir) =>
      join(RELEASE_DIR, dir, 'Harness Store.app', 'Contents', 'MacOS', 'Harness Store'),
    ),
    win32: [join(RELEASE_DIR, 'win-unpacked', 'Harness Store.exe')],
    linux: [join(RELEASE_DIR, 'linux-unpacked', 'harness-store')],
  }[process.platform];
  return candidates?.find((path) => existsSync(path));
}

function log(text) {
  console.log(`[smoke.mjs ${new Date().toISOString()}] ${text}`);
}

const unpackaged = process.argv[2] === '--unpackaged';
const executable = unpackaged
  ? createRequire(import.meta.url)('electron')
  : process.argv[2] === undefined
    ? packagedExecutable()
    : resolve(process.argv[2]);
const args = unpackaged ? [DESKTOP_DIR] : process.argv.slice(3);
if (executable === undefined || !existsSync(executable)) {
  console.error(`No packaged app found in ${RELEASE_DIR}: run \`pnpm package\` first.`);
  process.exit(1);
}
if (!existsSync(join(HELLO_TERM, 'manifest.json'))) {
  console.error('examples/hello-term/out/ is not built: run `pnpm build` at the repository root.');
  process.exit(1);
}

const fake = await startFakeProvider({ aliases: { [MODEL]: 'fake/echo' } });
const env = {};
for (const name of PASSED_THROUGH) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
env.HARNESS_STORE_SMOKE_HARNESS = HELLO_TERM;
env.HARNESS_STORE_SMOKE_PROVIDER_URL = fake.url;

log(`Starting ${[executable, ...args].join(' ')} with the fake Provider at ${fake.url}`);
const [code, signal] = await new Promise((done) => {
  let child;
  try {
    child = spawn(executable, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (error) {
    // Such as an executable for another CPU (EBADARCH on an Apple silicon Mac without Rosetta).
    log(`Could not start the app: ${error.message}`);
    done([1, null]);
    return;
  }
  const limit = setTimeout(() => {
    log(`Still running after ${LIMIT_MS / 1000} s: stopping it`);
    child.kill('SIGKILL');
  }, LIMIT_MS);
  child.on('error', (error) => {
    clearTimeout(limit);
    log(`Could not start the app: ${error.message}`);
    done([1, null]);
  });
  child.on('exit', (exitCode, exitSignal) => {
    clearTimeout(limit);
    done([exitCode, exitSignal]);
  });
});
await fake.close();

const chats = fake.requests.filter((request) => request.path === '/v1/chat/completions');
const models = chats.map((request) => request.body?.model);
log(
  `The app exited with ${signal ?? String(code)}; the fake Provider got ${chats.length} chat request(s): ${models.join(', ')}`,
);
if (code === 0 && (chats.length !== 1 || models[0] !== MODEL)) {
  log(`Expected exactly one chat request for ${MODEL}`);
  process.exit(1);
}
process.exit(code === 0 ? 0 : 1);
