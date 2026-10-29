import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { NodeCommand } from './supervisor.js';

/**
 * The Node runtime of Node Harnesses (docs/tech/architecture.md §4). On macOS and Linux it is the
 * app's own executable with `ELECTRON_RUN_AS_NODE=1`. On Windows it is the official `node.exe` of
 * the same Node version as Electron's, which the build ships in `resources/node/`
 * (apps/desktop/scripts/fetch-node.mjs, electron-builder.yml): the app's executable is a
 * GUI-subsystem program, which Windows never attaches to the pseudoconsole a terminal Harness runs
 * in, so as Node it would read nothing and print nothing there.
 */

/** What {@link defaultNodeCommand} decides with: the facts of the app's process. */
export interface NodeRuntimeContext {
  /** `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** `process.arch`. */
  readonly arch: string;
  /** The app's executable (`process.execPath`). */
  readonly execPath: string;
  /** Whether this is a packaged build, not Electron started on the app's folder in development. */
  readonly isPackaged: boolean;
  /** The packaged app's `resources` folder (`process.resourcesPath`). */
  readonly resourcesPath: string;
  /** The app's own folder in development: apps/desktop, where `vendor/` is. */
  readonly appPath: string;
  /** The Node version Electron runs (`process.versions.node`), which the shipped node.exe has too. */
  readonly nodeVersion: string;
  /** Whether a file is there. */
  readonly exists: (path: string) => boolean;
}

/** The Node command Node Harnesses run on, with what the Runtime reports about it. */
export interface NodeRuntime {
  readonly command: NodeCommand;
  /** The Node version it runs, as the diagnostics show it. */
  readonly nodeVersion: string;
  /** Something wrong with it, logged once at startup; absent when nothing is. */
  readonly warning?: string;
}

/** Where the development app finds the node.exe fetch-node.mjs downloaded. */
export function vendoredNodePath(appPath: string, arch: string): string {
  return join(appPath, 'vendor', 'node', `win32-${arch}`, 'node.exe');
}

/**
 * The Node command of Node Harnesses, terminal and web alike:
 * - macOS and Linux: the app's executable with `ELECTRON_RUN_AS_NODE=1`.
 * - Windows, packaged: `resources/node/node.exe`. When it is missing the command is kept, so every
 *   launch of a Node Harness fails with a spawn error naming it (and the smoke run fails the
 *   build); the app's executable is never used instead, as it cannot work in a pty.
 * - Windows, in development: `vendor/node/win32-<arch>/node.exe`, or else `node.exe` on PATH with a
 *   warning, as its Node version may not be Electron's.
 */
export function defaultNodeCommand(context: NodeRuntimeContext): NodeRuntime {
  const { nodeVersion } = context;
  if (context.platform !== 'win32') {
    return { command: { path: context.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }, nodeVersion };
  }
  if (context.isPackaged) {
    const bundled = join(context.resourcesPath, 'node', 'node.exe');
    return {
      command: { path: bundled, env: {} },
      nodeVersion,
      ...(context.exists(bundled)
        ? {}
        : { warning: `${bundled} is missing: no Node Harness can be launched.` }),
    };
  }
  const vendored = vendoredNodePath(context.appPath, context.arch);
  if (context.exists(vendored)) return { command: { path: vendored, env: {} }, nodeVersion };
  return {
    command: { path: 'node.exe', env: {} },
    nodeVersion: 'node.exe on PATH',
    warning:
      `${vendored} is missing: Node Harnesses run on node.exe from PATH, whose version may not be ` +
      `Electron's Node ${nodeVersion}. Run \`pnpm --filter @harness-store/desktop run fetch-node\`.`,
  };
}

/**
 * {@link defaultNodeCommand} for this process. In the app the facts come from Electron's `process`:
 * packaged unless the executable is Electron's own (`electron`, `electron.exe`), as Electron's
 * `app.isPackaged` decides; the app's folder is two above this code, which is bundled into
 * `out/main/` (as src/main/index.ts finds its preloads). Under plain Node (tests), Node itself, on
 * every platform.
 */
export function nodeRuntimeOfThisProcess(): NodeRuntime {
  const nodeVersion = process.versions.node;
  const electron = (process.versions as Partial<Record<string, string>>).electron;
  if (electron === undefined) {
    return { command: { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }, nodeVersion };
  }
  const executable = basename(process.execPath).toLowerCase();
  return defaultNodeCommand({
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    isPackaged: executable !== 'electron' && executable !== 'electron.exe',
    resourcesPath: process.resourcesPath,
    appPath: join(import.meta.dirname, '..', '..'),
    nodeVersion,
    exists: existsSync,
  });
}
