import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultNodeCommand,
  nodeRuntimeOfThisProcess,
  vendoredNodePath,
  type NodeRuntimeContext,
} from '../../src/main/runtime/node-runtime.js';

/**
 * The Node runtime of Node Harnesses (src/main/runtime/node-runtime.ts): the app's own executable
 * as Node on macOS and Linux, the node.exe of Electron's Node version on Windows, packaged or in
 * development, and never the app's executable on Windows, which gets no console in a pty.
 */

const RESOURCES = join('/', 'app', 'resources');
const APP = join('/', 'src', 'apps', 'desktop');
const BUNDLED = join(RESOURCES, 'node', 'node.exe');

function context(overrides: Partial<NodeRuntimeContext> = {}): NodeRuntimeContext {
  return {
    platform: 'win32',
    arch: 'x64',
    execPath: join('/', 'app', 'Harness Store.exe'),
    isPackaged: true,
    resourcesPath: RESOURCES,
    appPath: APP,
    nodeVersion: '24.22.1',
    exists: () => true,
    ...overrides,
  };
}

describe('defaultNodeCommand', () => {
  it('is the app executable as Node on macOS and Linux, packaged or not, whatever exists', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      for (const isPackaged of [true, false]) {
        const execPath = join('/', 'app', 'harness-store');
        expect(
          defaultNodeCommand(context({ platform, isPackaged, execPath, exists: () => false })),
        ).toEqual({
          command: { path: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
          nodeVersion: '24.22.1',
        });
      }
    }
  });

  it('is the bundled resources/node/node.exe of a packaged Windows build, without ELECTRON_RUN_AS_NODE', () => {
    const asked: string[] = [];
    const exists = (path: string) => {
      asked.push(path);
      return true;
    };
    expect(defaultNodeCommand(context({ exists }))).toEqual({
      command: { path: BUNDLED, env: {} },
      nodeVersion: '24.22.1',
    });
    expect(asked).toEqual([BUNDLED]);
  });

  it('keeps the bundled node.exe when a packaged Windows build lacks it, with a warning naming it', () => {
    const runtime = defaultNodeCommand(context({ exists: () => false }));
    // A launch then fails with a spawn error; the app's own executable is never used instead.
    expect(runtime.command).toEqual({ path: BUNDLED, env: {} });
    expect(runtime.warning).toContain(BUNDLED);
  });

  it('is the vendored node.exe of the architecture in development on Windows', () => {
    for (const arch of ['x64', 'arm64']) {
      const vendored = join(APP, 'vendor', 'node', `win32-${arch}`, 'node.exe');
      expect(vendoredNodePath(APP, arch)).toBe(vendored);
      expect(
        defaultNodeCommand(
          context({
            arch,
            isPackaged: false,
            execPath: join(APP, 'node_modules', 'electron', 'dist', 'electron.exe'),
            exists: (path) => path === vendored,
          }),
        ),
      ).toEqual({ command: { path: vendored, env: {} }, nodeVersion: '24.22.1' });
    }
  });

  it('falls back to node.exe on PATH in development on Windows without a vendored one, warning', () => {
    const runtime = defaultNodeCommand(context({ isPackaged: false, exists: () => false }));
    expect(runtime.command).toEqual({ path: 'node.exe', env: {} });
    expect(runtime.nodeVersion).toBe('node.exe on PATH');
    expect(runtime.warning).toContain(vendoredNodePath(APP, 'x64'));
    expect(runtime.warning).toContain('fetch-node');
  });

  it('never runs a Node Harness on the app executable on Windows', () => {
    for (const isPackaged of [true, false]) {
      for (const present of [true, false]) {
        const execPath = join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
        const { command } = defaultNodeCommand(
          context({ isPackaged, execPath, exists: () => present }),
        );
        expect(command.path).not.toBe(execPath);
        expect(command.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
      }
    }
  });
});

describe('nodeRuntimeOfThisProcess', () => {
  it('is Node itself under plain Node, on every platform', () => {
    expect(nodeRuntimeOfThisProcess()).toEqual({
      command: { path: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } },
      nodeVersion: process.versions.node,
    });
  });
});
