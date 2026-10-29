/**
 * Ticket P0-07.2 over IPC: `auth.signIn`, `auth.whoami`, `auth.signOut` and the `auth.changed`
 * event on the real Runtime bootstrap (SQLite in a temporary userData), with the Store faked at
 * the HTTP seam and its browser played by the test.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { openDatabase } from '../../src/main/runtime/database.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { STORE_SESSION_SECRET_ID } from '../../src/main/runtime/session-slot.js';
import { createSqliteSettingsStore } from '../../src/main/runtime/settings-store.js';
import { createFakeCipher, type FakeCipher } from '../support/fake-cipher.js';
import {
  createFakeStoreAuth,
  FAKE_ANON_KEY,
  FAKE_STORE_URL,
  type FakeStoreAuth,
} from '../support/fake-store-auth.js';
import { offlineProviderFetch } from '../support/provider-fetch.js';

const MAIN_WINDOW = {};

let dataDir: string;
let store: FakeStoreAuth;
let cipher: FakeCipher;
/** The `auth.changed` events pushed to the window. */
let events: { event: string; payload: unknown }[];
let started: Runtime[];

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-auth-ipc-')), 'userData');
  store = createFakeStoreAuth();
  cipher = createFakeCipher();
  events = [];
  started = [];
  // The Store base URL is a setting (P0-11's Settings screen); here it is the fake Store's.
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, 'harness-store.sqlite'));
  try {
    createSqliteSettingsStore(db).write('store_base_url', FAKE_STORE_URL);
  } finally {
    db.close();
  }
});
afterEach(async () => {
  await Promise.all(started.map((runtime) => runtime.shutdown()));
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

/** One app launch on `dataDir`; the browser hands its callback to this Runtime, as the OS would. */
async function launch(): Promise<Runtime> {
  // The browser is created before the Runtime it calls back into.
  const opened: { runtime?: Runtime } = {};
  const runtime = await startRuntime({
    dataDir,
    version: '1.2.3',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    providerFetch: offlineProviderFetch,
    secretCipher: cipher,
    storeFetch: store.fetch,
    storeAnonKey: FAKE_ANON_KEY,
    openExternal: store.browser((url) => opened.runtime?.auth.handleCallback(url) ?? false),
    emit: (event, payload) => {
      if (event === 'auth.changed') events.push({ event, payload });
    },
  });
  opened.runtime = runtime;
  started.push(runtime);
  return runtime;
}

function call(runtime: Runtime, method: string) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method });
}

/** The ciphertext rows of the `secrets` table, read straight from the SQLite file. */
function secretIds(): string[] {
  const db = new DatabaseSync(join(dataDir, 'harness-store.sqlite'));
  try {
    return (db.prepare('SELECT id FROM secrets').all() as { id: string }[]).map((row) => row.id);
  } finally {
    db.close();
  }
}

describe('Store sign-in over IPC', () => {
  it('signs in, stays signed in across a restart, and signs out', async () => {
    const first = await launch();
    await expect(call(first, 'auth.whoami')).resolves.toEqual({
      ok: true,
      data: { signedIn: false },
    });

    const signedIn = await call(first, 'auth.signIn');
    expect(signedIn).toMatchObject({
      ok: true,
      data: { signedIn: true, githubLogin: expect.stringMatching(/^octo-/) as unknown },
    });
    expect(store.opened).toHaveLength(1);
    expect(events).toEqual([
      {
        event: 'auth.changed',
        payload: { ...(signedIn.ok ? (signedIn.data as object) : {}), reason: 'signed_in' },
      },
    ]);
    expect(secretIds()).toEqual([STORE_SESSION_SECRET_ID]);
    await first.shutdown();

    // A fresh Runtime on the same userData: the encrypted session is read back and still works.
    const second = await launch();
    await expect(call(second, 'auth.whoami')).resolves.toEqual(signedIn);

    await expect(call(second, 'auth.signOut')).resolves.toEqual({
      ok: true,
      data: { signedIn: false },
    });
    await expect(call(second, 'auth.whoami')).resolves.toEqual({
      ok: true,
      data: { signedIn: false },
    });
    expect(secretIds()).toEqual([]);
    expect(events.at(-1)).toEqual({
      event: 'auth.changed',
      payload: { signedIn: false, reason: 'signed_out' },
    });
  });

  it('answers encryption_unavailable without OS encryption, and opens no browser', async () => {
    cipher.available = false;
    const runtime = await launch();
    await expect(call(runtime, 'auth.signIn')).resolves.toMatchObject({
      ok: false,
      error: { code: 'encryption_unavailable', messageKey: 'error.encryption_unavailable' },
    });
    expect(store.opened).toEqual([]);
    expect(secretIds()).toEqual([]);
  });
});
