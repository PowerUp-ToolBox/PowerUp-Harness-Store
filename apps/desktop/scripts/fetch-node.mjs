#!/usr/bin/env node
/**
 * `node scripts/fetch-node.mjs [--platform <platform>] [--arch <arch>]`: puts the Node runtime of
 * Windows builds in place (docs/tech/architecture.md §4). On Windows, Node Harnesses run on the
 * official node.exe of the same Node version as Electron's, not on the app's own executable: that
 * is a GUI-subsystem program, which Windows never attaches to the pseudoconsole of a terminal
 * Harness, so as Node it would read nothing and print nothing there.
 *
 * It asks the installed Electron for its Node version (`ELECTRON_RUN_AS_NODE=1 electron -p
 * process.versions.node`), downloads https://nodejs.org/dist/v<version>/win-<arch>/node.exe and
 * writes it to vendor/node/win32-<arch>/node.exe, with node.json recording the version and hash.
 * Its SHA-256 must be the one pinned for that version and architecture in node-sha256.json, next
 * to this script, and the one that release's SHASUMS256.txt lists: the pin, reviewed in the
 * repository, is what a compromised download server cannot change along with the file. A file
 * already there whose version and hash match the pin is kept, without any download.
 * electron-builder.yml ships it as resources/node/node.exe (its beforePack hook, pack-hooks.mjs,
 * runs this script for the architecture it packages); the development app runs it from vendor/
 * (src/main/runtime/node-runtime.ts). Any other target platform has nothing to fetch, and the
 * script exits 0.
 *
 * When Electron is updated to another Node version, the script stops with the lines to add to
 * node-sha256.json: each node.exe's SHA-256, taken from https://nodejs.org/dist/v<version>/
 * SHASUMS256.txt after checking that file's signature (SHASUMS256.txt.asc, signed by a Node
 * releaser's key, https://github.com/nodejs/node#release-keys).
 *
 * The target defaults to this machine's platform and architecture; `--platform win32` fetches the
 * Windows runtime from another OS. Each download is given 120 s, and one that times out, fails on
 * the network or answers a 5xx is tried again, 3 times in all. Exits 1 when Electron's Node version
 * cannot be read, it has no pin, a download fails, or a hash does not match (the file is then not
 * written).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const DESKTOP_DIR = join(import.meta.dirname, '..');
const DIST = 'https://nodejs.org/dist';
/** The architectures Node publishes a node.exe for. */
const WINDOWS_ARCHES = ['x64', 'arm64'];
const ATTEMPTS = 3;
/** How long one download may take, node.exe (some 80 MB) included. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** The SHA-256 of each node.exe, by Node version and then by `win32-<arch>`. */
const PINS_FILE = join(import.meta.dirname, 'node-sha256.json');

function log(text) {
  console.log(`[fetch-node] ${text}`);
}

function fail(text) {
  console.error(`[fetch-node] ${text}`);
  process.exit(1);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Electron's Node version, such as `24.22.1`, from the Electron this package installed. */
function electronNodeVersion() {
  const electron = createRequire(join(DESKTOP_DIR, 'package.json'))('electron');
  const result = spawnSync(electron, ['-p', 'process.versions.node'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  const version = result.stdout?.trim() ?? '';
  if (result.status !== 0 || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(
      `Could not read Electron's Node version from ${electron}: ${result.error?.message ?? (result.stderr || `exit ${String(result.status)}`)}`,
    );
  }
  return version;
}

/** The body of a GET, retried a few times on a timeout, a network error or a 5xx. */
async function download(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      if (response.status < 500 || attempt === ATTEMPTS) {
        fail(`GET ${url} answered ${String(response.status)}`);
      }
    } catch (error) {
      const why =
        error.name === 'TimeoutError'
          ? `timed out after ${String(DOWNLOAD_TIMEOUT_MS / 1000)} s`
          : error.message;
      if (attempt === ATTEMPTS) fail(`GET ${url} failed: ${why}`);
      log(`GET ${url} failed (${why}), trying again`);
      continue;
    }
    log(`GET ${url} failed, trying again`);
  }
}

/** The pinned SHA-256 of node.exe of `version` for `arch`; exits with how to add it when none is. */
function pinnedSha256(version, arch) {
  const pins = JSON.parse(readFileSync(PINS_FILE, 'utf8'));
  const pinned = pins[version]?.[`win32-${arch}`];
  if (typeof pinned === 'string' && /^[0-9a-f]{64}$/.test(pinned)) return pinned;
  fail(
    [
      `No SHA-256 is pinned for Node ${version} win-${arch}/node.exe in ${PINS_FILE}.`,
      `Electron's Node version changed: pin the new node.exe files before fetching them. Check the`,
      `signature of https://nodejs.org/dist/v${version}/SHASUMS256.txt.asc against the Node`,
      `release keys (https://github.com/nodejs/node#release-keys), then add the lines it lists for`,
      `win-x64/node.exe and win-arm64/node.exe to ${PINS_FILE}:`,
      `  "${version}": { "win32-arm64": "<sha256>", "win32-x64": "<sha256>" }`,
    ].join('\n'),
  );
}

const { values } = parseArgs({
  options: { platform: { type: 'string' }, arch: { type: 'string' } },
});
const platform = values.platform ?? process.platform;
const arch = values.arch ?? process.arch;
if (platform !== 'win32') {
  log(`Nothing to fetch for ${platform}: Node Harnesses run on the app's own executable there.`);
  process.exit(0);
}
if (!WINDOWS_ARCHES.includes(arch)) fail(`No node.exe is published for win32-${arch}.`);

const version = electronNodeVersion();
const pinned = pinnedSha256(version, arch);
const dir = join(DESKTOP_DIR, 'vendor', 'node', `win32-${arch}`);
const target = join(dir, 'node.exe');
const record = join(dir, 'node.json');

if (existsSync(target) && existsSync(record)) {
  const kept = JSON.parse(readFileSync(record, 'utf8'));
  if (kept.version === version && sha256(readFileSync(target)) === pinned) {
    log(`${target} is Node ${version} already.`);
    process.exit(0);
  }
}

const sums = (await download(`${DIST}/v${version}/SHASUMS256.txt`)).toString('utf8');
const expected = /^([0-9a-f]{64}) {2}(.+)$/gm;
const entry = [...sums.matchAll(expected)].find(([, , file]) => file === `win-${arch}/node.exe`);
if (entry === undefined) fail(`SHASUMS256.txt of Node ${version} lists no win-${arch}/node.exe.`);
if (entry[1] !== pinned) {
  fail(
    `SHASUMS256.txt of Node ${version} lists ${entry[1]} for win-${arch}/node.exe, but ` +
      `${PINS_FILE} pins ${pinned}: not downloaded.`,
  );
}
const url = `${DIST}/v${version}/win-${arch}/node.exe`;
log(`Downloading ${url}`);
const bytes = await download(url);
const actual = sha256(bytes);
if (actual !== pinned) {
  fail(`${url} has SHA-256 ${actual}, but the pin and SHASUMS256.txt say ${pinned}: not written.`);
}
mkdirSync(dir, { recursive: true });
writeFileSync(`${target}.partial`, bytes);
renameSync(`${target}.partial`, target);
writeFileSync(record, `${JSON.stringify({ version, sha256: actual }, null, 2)}\n`);
log(`Wrote ${target} (Node ${version}, SHA-256 ${actual}).`);
