/**
 * Ticket P0-08.1: the life of the Publish flow's folder watcher, with a fake `fs.watch` whose
 * events the tests send. A watcher that failed, could not start, or lost its folder (Linux
 * reports the folder's own deletion or move as a 'rename' of '') is replaced by the next
 * validation of that folder; a run that a newer one replaced never takes the watch from it. The
 * watch starts once the build has listed the folder within the limit, so a folder too large to
 * list is never watched; on Linux, each folder listed is watched on its own (Node emulates a
 * recursive watch by walking the whole tree, excluded folders included, synchronously). A publish
 * that succeeds (P0-08.2) ends the watch before it answers; one that fails keeps it.
 */
import { EventEmitter } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, type watch } from 'node:fs';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPublishService,
  type PublishService,
  type PublishServiceOptions,
} from '../../src/main/runtime/publish.js';

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
  readonly options: unknown;
  readonly watcher: FakeWatcher;
  readonly send: (event: 'rename' | 'change', filename: string | null) => void;
}

let root: string;
let folder: string;
let watches: Watch[];
/** The next calls of `watch` throw, as `fs.watch` does when the OS has no watches left. */
let refusals: number;
/** Calls of `watch` that succeed before the refusals start. */
let granted: number;
let changes: string[];
let service: PublishService;

const fakeWatch = (
  path: string,
  options: unknown,
  listener: (event: 'rename' | 'change', filename: string | null) => void,
) => {
  if (granted > 0) granted -= 1;
  else if (refusals > 0) {
    refusals -= 1;
    throw Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' });
  }
  const watcher = new FakeWatcher();
  watches.push({ path, options, watcher, send: listener });
  return watcher;
};

/** The service under test; one recursive watch unless `overrides` says otherwise. */
function createService(overrides: Partial<PublishServiceOptions> = {}): PublishService {
  return createPublishService({
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
    recursiveWatch: true,
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-watch-'));
  folder = join(root, 'my-harness');
  cpSync(FIXTURE, folder, { recursive: true });
  watches = [];
  refusals = 0;
  granted = 0;
  changes = [];
  service = createService();
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

describe('a publish of the watched folder', () => {
  /** The service, signed in, with a `publish` function answering `status` at once. */
  function publishing(status: number) {
    service.close();
    service = createService({
      auth: {
        login: () => Promise.resolve(null),
        accessToken: () => Promise.resolve('access-token'),
        sessionRejected: () => Promise.resolve(),
      },
      upload: () =>
        Promise.resolve({
          kind: 'answered',
          status,
          body: status === 201 ? { harness_id: 'acme/fixture-web', version: '1.0.0' } : null,
        }),
    });
  }

  it('that succeeds ends the watch before it answers, a change about to be reported included', async () => {
    publishing(201);
    const { archiveId } = await validate();
    live()[0]?.send('change', 'README.md');
    await expect(service.publish({ archiveId: archiveId ?? '', jobId: 'job' })).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(live()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 3));
    expect(changes).toEqual([]);
  });

  it('that fails keeps watching: a change is validated again', async () => {
    publishing(500);
    const { archiveId } = await validate();
    await expect(service.publish({ archiveId: archiveId ?? '', jobId: 'job' })).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    live()[0]?.send('change', 'README.md');
    await reported();
  });
});

describe('a folder too large to list', () => {
  /** More files than the build lists: 4 here, against the fixture's 4 plus these. */
  function overfill() {
    mkdirSync(join(folder, 'more'));
    for (let index = 0; index < 3; index++) writeFileSync(join(folder, 'more', String(index)), 'x');
  }

  it('is never watched', async () => {
    service.close();
    service = createService({ maxListedEntries: 4 });
    overfill();
    const data = await validate();
    expect(data.problems.map((problem) => problem.messageKey)).toEqual([
      'archive_too_many_files.not_counted',
    ]);
    expect(watches).toEqual([]);
  });

  it('stops being watched once it grows past the limit', async () => {
    service.close();
    service = createService({ maxListedEntries: 4 });
    await validate();
    expect(live()).toHaveLength(1);
    overfill();
    await validate();
    expect(live()).toEqual([]);
  });
});

describe('on Linux: one watch per folder listed', () => {
  beforeEach(() => {
    service.close();
    service = createService({ recursiveWatch: false });
    mkdirSync(join(folder, 'src', 'lib'), { recursive: true });
    writeFileSync(join(folder, 'src', 'lib', 'util.mjs'), '// util\n');
    mkdirSync(join(folder, '.git', 'objects'), { recursive: true });
    mkdirSync(join(folder, 'node_modules', '.cache', 'big'), { recursive: true });
    mkdirSync(join(folder, 'vendor', 'deep'), { recursive: true });
    writeFileSync(join(folder, '.harnessignore'), 'vendor/\n');
  });

  it('never watches an excluded folder, nor anything recursively', async () => {
    await validate();
    expect(watches.map((entry) => entry.path)).toEqual(
      ['', 'assets', 'node_modules', 'src', 'src/lib'].map((relative) =>
        relative === '' ? folder : join(folder, ...relative.split('/')),
      ),
    );
    expect(watches.map((entry) => entry.options)).toEqual(
      watches.map(() => ({ recursive: false })),
    );
  });

  it('reports a change in a subfolder by its path in the folder, and ignores excluded names', async () => {
    await validate();
    const lib = watches.find((entry) => entry.path === join(folder, 'src', 'lib'));
    const modules = watches.find((entry) => entry.path === join(folder, 'node_modules'));
    lib?.send('change', 'util.mjs.swp');
    modules?.send('rename', '.cache');
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS * 3));
    expect(changes).toEqual([]);
    lib?.send('change', 'util.mjs');
    await reported();
  });

  it('replaces its watches on every listing, so a new folder is watched too', async () => {
    await validate();
    const first = [...watches];
    mkdirSync(join(folder, 'src', 'new'));
    await validate();
    expect(first.every((entry) => entry.watcher.closed)).toBe(true);
    expect(live().map((entry) => entry.path)).toContain(join(folder, 'src', 'new'));
  });

  it('a change the old watches were about to report is still reported', async () => {
    await validate();
    watches[0]?.send('change', 'README.md');
    await validate();
    await reported();
  });

  it('a watch that cannot start leaves none behind, and the next validation tries again', async () => {
    granted = 2;
    refusals = 1;
    await validate();
    expect(watches).toHaveLength(2);
    expect(live()).toEqual([]);
    await validate();
    expect(live()).toHaveLength(5);
  });
});
