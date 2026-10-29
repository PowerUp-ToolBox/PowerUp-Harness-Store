/**
 * electron-builder's `beforePack` and `afterPack` hooks (electron-builder.yml), which make a
 * Windows build ship the Node runtime of its Node Harnesses, resources/node/node.exe
 * (docs/tech/architecture.md §4), or fail. electron-builder copies `extraResources` that are not
 * there without a word, and a build without node.exe could launch no Node Harness.
 *
 * - beforePack, for each Windows architecture it packages, runs scripts/fetch-node.mjs for that
 *   very architecture (`--arch x64`, `--arm64`, or the machine's when none is given), before the
 *   files are copied. It keeps a node.exe already in vendor/ that is right, without a download.
 * - afterPack fails the build when the packaged app has no resources/node/node.exe, or an empty one.
 *
 * Any other platform ships no node.exe, and both do nothing there.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

/** electron-builder's `Arch` enum, by value: `context.arch` is a number. */
const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal'];

/** The architecture of a pack context, as Node names it. */
function archOf(context) {
  return ARCH_NAMES[context.arch] ?? String(context.arch);
}

/** @param {import('electron-builder').AfterPackContext} context The same pack context. */
export function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const arch = archOf(context);
  const script = join(import.meta.dirname, 'fetch-node.mjs');
  const result = spawnSync(process.execPath, [script, '--platform', 'win32', '--arch', arch], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `scripts/fetch-node.mjs failed for win32-${arch} (${result.error?.message ?? `exit ${String(result.status)}`}): ` +
        'the build would ship no Node runtime.',
    );
  }
}

/** @param {import('electron-builder').AfterPackContext} context */
export function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const node = join(context.appOutDir, 'resources', 'node', 'node.exe');
  let size = 0;
  try {
    size = statSync(node).size;
  } catch {
    // Missing: size stays 0.
  }
  if (size === 0) {
    throw new Error(
      `${node} is missing or empty: a Windows build must ship the Node runtime of Node Harnesses. ` +
        `Run \`pnpm --filter @harness-store/desktop run fetch-node --arch ${archOf(context)}\` ` +
        '(the beforePack hook should have), then package again.',
    );
  }
}
