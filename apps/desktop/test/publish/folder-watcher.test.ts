/**
 * Ticket P0-08.1: the life of the Publish flow's folder watcher, with a fake `fs.watch` whose
 * events the tests send. A watcher that failed, could not start, or lost its folder (Linux
 * reports the folder's own deletion or move as a 'rename' of '') is replaced by the next
 * validation of that folder; a run that a newer one replaced never takes the watch from it.
 */
import { EventEmitter } from 'node:events';
import { cpSync, mkdtempSync, rmSync, writeFileSync, type watch } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublishService, type PublishService } from '../../src/main/runtime/publish.js';

/** `stat` of a path held here waits for its promise: the tests decide which run answers first. */
const statGate = vi.hoisted(() => ({ held: new Map<string, Promise<unknown>>() }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>();
  const stat = async (...args: Parameters<typeof actual.stat>) => {
    await statGate.held.get(String(args[0]));
    return actual.stat(...args);
  };
  return { ...actual, stat, default: { ...actual, stat } };
});

const FIXTURE = join(import.meta.dirname, '../fixtures/harnesses/fixture-web');
const DEBOUNCE_MS = 20;

class FakeWatcher extends EventEmitter {
  closed = false;
  close() {
    this.closed = true;
  }
}

interface Watch {
  readonly path: string;
  readonly watcher: FakeWatcher;
  readonly send: (event: 'rename' | 'change', filename: string | null) => void;
}

let root: string;
let folder: string;
let watches: Watch[];
/** The next calls of `watch` throw, as `fs.watch` does when the OS has no watches left. */
let refusals: number;
let changes: string[];
let service: PublishService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-watch-'));
  folder = join(root, 'my-harness');
  cpSync(FIXTURE, folder, { recursive: true });
  watches = [];
  refusals = 0;
  changes = [];
  const fakeWatch = (
    path: string,
    _options: unknown,
    listener: (event: 'rename' | 'change', filename: string | null) => void,
  ) => {
    if (refusals > 0) {
      refusals -= 1;
      throw Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });
    }
    const watcher = new FakeWatcher();
    watches.push({ path, watcher, send: listener });
    return watcher;
  };
  service = createPublishService({
    fetch: () => Promise.reject(new Error('no Store in these tests')),
    storeBaseUrl: () => 'http://store.invalid',
    anonKey: 'fake-anon-key',
    auth: {
      login: () => Promise.resolve(null),
      accessToken: () => Promise.resolve(null),
      sessionRejected: () => Promise.resolve(),
    },
    onFolderChanged: (path) => changes.push(path),
    debounceMs: DEBOUNCE_MS,
    watch: fakeWatch as unknown as typeof watch,
  });
});
afterEach(() => {
  service.close();
  statGate.held.clear();
  rmSync(root, { recursive: true, force: true });
});

async function validate(path = folder) {
  const result = await service.validateFolder(path);
  if (!result.ok) throw new Error(`validateFolder failed: ${result.error.code}`);
  return result.data;
}

const reported = () =>
  vi.waitFor(
    () => {
      expect(changes).toEqual([folder]);
    },
    { timeout: 2000, interval: 5 },
  );

const live = () => watches.filter((entry) => !entry.watcher.closed);

describe('the folder watcher', () => {
  it('watches a folder once, however often it is validated', async () => {
    await validate();
    await validate();
    expect(watches.map((entry) => entry.path)).toEqual([folder]);
  });

  it('is replaced by the next validation of the same folder after it failed', async () => {
    await validate();
    watches[0]?.watcher.emit('error', new Error('EPERM'));
    expect(watches[0]?.watcher.closed).toBe(true);
    await reported();

    await validate();
    expect(live().map((entry) => entry.path)).toEqual([folder]);
    changes.length = 0;
    live()[0]?.send('change', 'README.md');
    await reported();
  });

  it('is tried again on the next validation when it could not start', async () => {
    refusals = 1;
    await validate();
    expect(watches).toEqual([]);
    await validate();
    expect(live().map((entry) => entry.path)).toEqual([folder]);
  });

  it('the folder itself deleted or moved, with a .harnessignore: one report, then a new watcher', async () => {
    writeFileSync(join(folder, '.harnessignore'), 'dist/\n');
    await validate();
    const [first] = watches;
    first?.send('change', 'dist/index.js');
    first?.send('change', '');
    expect(first?.watcher.closed).toBe(false);
    await reported();

    changes.length = 0;
    // Linux's recursive watcher names the folder itself '' (path.relative of the root).
    expect(() => first?.send('rename', '')).not.toThrow();
    expect(first?.watcher.closed).toBe(true);
    await reported();

    await validate();
    expect(live()).toHaveLength(1);
    expect(live()[0]).not.toBe(first);
  });

  it('a run a newer one replaced does not take the watch, even when its folder answers last', async () => {
    const other = join(root, 'other-harness');
    cpSync(FIXTURE, other, { recursive: true });
    const { promise, resolve: release } = Promise.withResolvers<undefined>();
    statGate.held.set(folder, promise);
    const older = service.validateFolder(folder);
    await validate(other);
    release(undefined);
    await expect(older).resolves.toMatchObject({ ok: false, error: { code: 'package_invalid' } });
    expect(watches.map((entry) => entry.path)).toEqual([other]);
    expect(live().map((entry) => entry.path)).toEqual([other]);
  });
});
