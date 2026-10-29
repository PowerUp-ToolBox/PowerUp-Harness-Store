import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallRow } from '../../src/main/runtime/install-store.js';
import type { SignalOutcome, StopSignal } from '../../src/main/runtime/process-tree.js';
import type { PtyExit, PtyProcess } from '../../src/main/runtime/pty.js';
import { createSupervisor, STOP_GRACE_MS } from '../../src/main/runtime/supervisor.js';
import type { LaunchStatus } from '../../src/shared/ipc.js';
import { manifestWith } from '../support/manifest.js';

/**
 * Tickets P0-05.2 and P0-13: the Supervisor on its own, with every collaborator faked, for what the
 * Runtime cannot reach on demand over IPC or show with a real process: an install of the Harness
 * that is putting its files in place, when a pty is disposed of, and a stop whose polite step
 * Windows refuses. The process tree is faked too, so no real process is ever signalled.
 */

/** What the faked process tree answers to each stop step; set by each test. */
const tree: { onSignal: (signal: StopSignal) => SignalOutcome } = vi.hoisted(() => ({
  onSignal: (): SignalOutcome => 'sent',
}));
vi.mock('../../src/main/runtime/process-tree.js', () => ({
  signalProcessTree: (_pid: number, signal: StopSignal) => Promise.resolve(tree.onSignal(signal)),
  processTreeEndsWithin: () => Promise.resolve(true),
  processTreeAlive: () => false,
}));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-supervisor-'));
  tree.onSignal = () => 'sent';
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A pty that runs nothing: the test ends its "process" with {@link FakePty.exit}. `events` gets
 * `exit` when it does, before its exit listeners run, and `dispose` on each dispose.
 */
interface FakePty {
  readonly pty: PtyProcess;
  exit(exitCode: number): void;
  readonly disposals: () => number;
}

function fakePty(events: string[]): FakePty {
  const listeners: ((exit: PtyExit) => void)[] = [];
  let disposals = 0;
  return {
    pty: {
      pid: 4242,
      onData: () => undefined,
      onExit: (listener) => {
        listeners.push(listener);
      },
      write: () => undefined,
      resize: () => undefined,
      dispose: () => {
        disposals += 1;
        events.push('dispose');
      },
    },
    exit(exitCode) {
      events.push('exit');
      for (const listener of listeners) listener({ exitCode });
    },
    disposals: () => disposals,
  };
}

/** The one fake pty a launch spawned. */
function only(ptys: readonly FakePty[]): FakePty {
  const [pty] = ptys;
  if (pty === undefined || ptys.length !== 1) throw new Error(`${String(ptys.length)} ptys`);
  return pty;
}

function setup(options: { entry?: boolean } = {}) {
  const manifest = { ...manifestWith({ default: {} }), ui: { kind: 'terminal' as const } };
  const install: InstallRow = {
    harnessId: 'acme/hello',
    version: '1.0.0',
    manifest,
    // No Entry there: a launch that goes ahead fails spawn_error before any token or window.
    installPath: join(root, 'harnesses', 'acme', 'hello', '1.0.0'),
    dataDir: join(root, 'data', 'acme', 'hello'),
    installedAt: '2026-10-28T09:00:00.000Z',
    lastLaunchedAt: null,
    lastWorkspace: null,
    consentedPermissions: manifest.permissions,
    source: 'local',
    storeStatus: null,
    installedVersionTakenDown: false,
    takedownAcknowledged: false,
    availableVersion: null,
    availableManifest: null,
  };
  if (options.entry === true) {
    mkdirSync(join(install.installPath, 'dist'), { recursive: true });
    writeFileSync(join(install.installPath, 'dist', 'index.js'), '');
  }
  const emitted: LaunchStatus[] = [];
  const opened: string[] = [];
  /** What happened, in order: the fake pty's `exit` and `dispose`, `ended` (the row), signals. */
  const events: string[] = [];
  const ptys: FakePty[] = [];
  let installing = options.entry !== true;
  const supervisor = createSupervisor({
    installs: {
      get: () => install,
      markLaunched: () => undefined,
      setLastWorkspace: () => undefined,
    },
    launches: {
      begin: () => undefined,
      end: () => {
        events.push('ended');
      },
      closeOpen: () => 0,
    },
    paths: { logsDir: (harnessId) => join(root, 'logs', harnessId) },
    platform: 'linux-x64',
    gatewayUrl: 'http://127.0.0.1:1/v1',
    tokens: { issueToken: () => 'token', revokeLaunch: () => undefined },
    locale: () => 'en',
    isInstalling: () => installing,
    defaultSlotBound: () => true,
    windows: {
      openTerminal: (spec) => {
        opened.push(spec.launchId);
        // The window reports its terminal's size at once, as a real one does once it has loaded.
        queueMicrotask(() =>
          supervisor.window(spec.launchId)?.terminalReady({ cols: 80, rows: 24 }),
        );
      },
      openWeb: (spec) => {
        opened.push(spec.launchId);
      },
      showWeb: () => undefined,
      hideWeb: () => undefined,
      reloadWeb: () => undefined,
      layoutWeb: () => undefined,
      send: () => undefined,
      focus: () => false,
      close: () => undefined,
    },
    spawnPty: () => {
      const fake = fakePty(events);
      ptys.push(fake);
      return fake.pty;
    },
    nodeCommand: { path: process.execPath, env: {} },
    emit: (status) => emitted.push(status),
    logError: () => undefined,
  });
  return {
    supervisor,
    emitted,
    opened,
    events,
    ptys,
    installDone: () => {
      installing = false;
    },
  };
}

describe('createSupervisor', () => {
  it('launches nothing while an install of the Harness puts its files in place', async () => {
    const { supervisor, emitted, opened, installDone } = setup();

    await expect(supervisor.start('acme/hello')).resolves.toMatchObject({
      ok: false,
      error: { code: 'harness_installing', messageKey: 'error.harness_installing' },
    });
    expect(emitted).toEqual([]);
    expect(opened).toEqual([]);
    expect(supervisor.isRunning('acme/hello')).toBe(false);

    installDone();
    const started = supervisor.start('acme/hello');
    await expect(started).resolves.toMatchObject({ ok: true, data: { outcome: 'started' } });
    await expect.poll(() => emitted.at(-1)?.state).toBe('failed');
  });
});

describe('the pty of a terminal launch', () => {
  /** Starts acme/hello and waits until its fake pty runs. */
  async function launched() {
    const context = setup({ entry: true });
    const started = await context.supervisor.start('acme/hello');
    expect(started).toMatchObject({ ok: true, data: { outcome: 'started' } });
    await expect.poll(() => context.ptys.length).toBe(1);
    const pty = only(context.ptys);
    return { ...context, pty };
  }

  it('is disposed of once, after its exit, when the Harness exits on its own', async () => {
    const { supervisor, emitted, events, pty } = await launched();
    expect(pty.disposals()).toBe(0);

    pty.exit(0);
    await expect.poll(() => emitted.at(-1)?.state).toBe('stopped');
    expect(pty.disposals()).toBe(1);
    expect(events.indexOf('dispose')).toBeGreaterThan(events.indexOf('exit'));

    // Ending the launch, closing its window or quitting never disposes of it again.
    await supervisor.stopAll();
    expect(pty.disposals()).toBe(1);
    expect(events.filter((event) => event === 'dispose')).toHaveLength(1);
  });

  it('is disposed of once, after its exit, when the Harness is stopped', async () => {
    const { supervisor, events, pty } = await launched();
    tree.onSignal = (signal) => {
      events.push(signal);
      // The Harness exits on SIGTERM, a moment later.
      if (signal === 'SIGTERM')
        setTimeout(() => {
          pty.exit(143);
        }, 20);
      return 'sent';
    };

    const stopping = supervisor.stopAll();
    await expect.poll(() => events).toContain('SIGTERM');
    // Asked to stop, still running: nothing is disposed of before its exit.
    expect(pty.disposals()).toBe(0);
    await stopping;

    expect(pty.disposals()).toBe(1);
    expect(events).toEqual(['SIGTERM', 'exit', 'dispose', 'ended']);
  });

  it('is disposed of once when the stop had to force it', async () => {
    const { supervisor, events, pty } = await launched();
    tree.onSignal = (signal) => {
      events.push(signal);
      if (signal === 'SIGKILL') pty.exit(137);
      // Windows' polite taskkill cannot end a console process.
      return signal === 'SIGTERM' ? 'refused' : 'sent';
    };

    await supervisor.stopAll();

    expect(pty.disposals()).toBe(1);
    expect(events).toEqual(['SIGTERM', 'SIGKILL', 'exit', 'dispose', 'ended']);
  });
});

describe('the shutdown sequence', () => {
  it('forces the stop at once, without the grace period, when the polite step is refused', async () => {
    const context = setup({ entry: true });
    await context.supervisor.start('acme/hello');
    await expect.poll(() => context.ptys.length).toBe(1);
    const pty = only(context.ptys);
    const sent: { signal: StopSignal; at: number }[] = [];
    tree.onSignal = (signal) => {
      sent.push({ signal, at: Date.now() });
      if (signal === 'SIGKILL')
        setTimeout(() => {
          pty.exit(1);
        }, 0);
      return signal === 'SIGTERM' ? 'refused' : 'sent';
    };

    const began = Date.now();
    await context.supervisor.stopAll();

    expect(sent.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect((sent[1]?.at ?? Infinity) - began).toBeLessThan(STOP_GRACE_MS / 5);
    expect(context.emitted.at(-1)).toMatchObject({ state: 'stopped' });
  });

  it('waits out the grace period after a polite step that was not refused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const context = setup({ entry: true });
      await context.supervisor.start('acme/hello');
      await vi.waitFor(() => {
        expect(context.ptys).toHaveLength(1);
      });
      const pty = only(context.ptys);
      const sent: StopSignal[] = [];
      tree.onSignal = (signal) => {
        sent.push(signal);
        if (signal === 'SIGKILL') pty.exit(137);
        // macOS and Linux, or a Windows Harness with a window: asked, and it ignores it.
        return 'sent';
      };

      const stopping = context.supervisor.stopAll();
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 100);
      expect(sent).toEqual(['SIGTERM']);
      await vi.advanceTimersByTimeAsync(200);
      expect(sent).toEqual(['SIGTERM', 'SIGKILL']);
      await stopping;
    } finally {
      vi.useRealTimers();
    }
  });
});
