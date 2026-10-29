#!/usr/bin/env node
/**
 * `node scripts/fetch-node.mjs [--platform <platform>] [--arch <arch>]`: puts the Node runtime of
 * Windows builds in place (docs/tech/architecture.md §4). On Windows, Node Harnesses run on the
 * official node.exe of the same Node version as Electron's, not on the app's own executable: that
 * is a GUI-subsystem program, which Windows never attaches to the pseudoconsole of a terminal
 * Harness, so as Node it would read nothing and print nothing there.
 *
 * It asks the installed Electron for its Node version (`ELECTRON_RUN_AS_NODE=1 electron -p
 * process.versions.node`), downloads https://nodejs.org/dist/v<version>/win-<arch>/node.exe,
 * checks it against the SHA-256 of that release's SHASUMS256.txt and writes it to
 * vendor/node/win32-<arch>/node.exe, with node.json recording the version and hash. A file already
 * there whose version and hash match is kept, without any download. electron-builder.yml ships it
 * as resources/node/node.exe; the development app runs it from vendor/ (src/main/runtime/
 * node-runtime.ts). Any other target platform has nothing to fetch, and the script exits 0.
 *
 * The target defaults to this machine's platform and architecture; `--platform win32` fetches the
 * Windows runtime from another OS. Exits 1 when Electron's Node version cannot be read, a download
 * fails, or a hash does not match (the file is then not written).
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

/** The body of a GET, retried a few times on a network error or a 5xx. */
async function download(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      if (response.status < 500 || attempt === ATTEMPTS) {
        fail(`GET ${url} answered ${String(response.status)}`);
      }
    } catch (error) {
      if (attempt === ATTEMPTS) fail(`GET ${url} failed: ${error.message}`);
    }
    log(`GET ${url} failed, trying again`);
  }
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
const dir = join(DESKTOP_DIR, 'vendor', 'node', `win32-${arch}`);
const target = join(dir, 'node.exe');
const record = join(dir, 'node.json');

if (existsSync(target) && existsSync(record)) {
  const kept = JSON.parse(readFileSync(record, 'utf8'));
  if (kept.version === version && kept.sha256 === sha256(readFileSync(target))) {
    log(`${target} is Node ${version} already.`);
    process.exit(0);
  }
}

const sums = (await download(`${DIST}/v${version}/SHASUMS256.txt`)).toString('utf8');
const expected = /^([0-9a-f]{64}) {2}(.+)$/gm;
const entry = [...sums.matchAll(expected)].find(([, , file]) => file === `win-${arch}/node.exe`);
if (entry === undefined) fail(`SHASUMS256.txt of Node ${version} lists no win-${arch}/node.exe.`);
const url = `${DIST}/v${version}/win-${arch}/node.exe`;
log(`Downloading ${url}`);
const bytes = await download(url);
const actual = sha256(bytes);
if (actual !== entry[1]) {
  fail(`${url} has SHA-256 ${actual}, but SHASUMS256.txt says ${entry[1]}: not written.`);
}
mkdirSync(dir, { recursive: true });
writeFileSync(`${target}.partial`, bytes);
renameSync(`${target}.partial`, target);
writeFileSync(record, `${JSON.stringify({ version, sha256: actual }, null, 2)}\n`);
log(`Wrote ${target} (Node ${version}, SHA-256 ${actual}).`);
