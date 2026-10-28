/**
 * Ticket P0-07.2: the Publisher's Store sign-in (GitHub OAuth with PKCE in the system browser) and
 * its encrypted session, against a fake Store at the HTTP seam. The same module is driven against
 * the real local Supabase stack in apps/store/test-store/auth.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthChanged } from '../../src/shared/ipc.js';
import { openDatabase } from '../../src/main/runtime/database.js';
import {
  createMemorySessionSlot,
  createSqliteSessionSlot,
  STORE_SESSION_SECRET_ID,
  type SessionSlot,
} from '../../src/main/runtime/session-slot.js';
import {
  AUTH_CALLBACK_URL,
  createStoreAuth,
  type StoreAuth,
  type StoreAuthOptions,
} from '../../src/main/runtime/store-auth.js';
import { createFakeCipher, type FakeCipher } from '../support/fake-cipher.js';
import {
  createFakeStoreAuth,
  FAKE_ANON_KEY,
  FAKE_STORE_URL,
  type FakeStoreAuth,
} from '../support/fake-store-auth.js';

let clock: Date;
let store: FakeStoreAuth;
let cipher: FakeCipher;
let slot: SessionSlot;
let changes: AuthChanged[];

beforeEach(() => {
  clock = new Date('2026-10-28T12:00:00Z');
  store = createFakeStoreAuth(() => clock);
  cipher = createFakeCipher();
  slot = createMemorySessionSlot();
  changes = [];
});

/** The auth module as the Runtime creates it, its browser played by the fake Store. */
function createAuth(
  options: Partial<StoreAuthOptions> & { answer?: string | null } = {},
): StoreAuth {
  const { answer, ...overrides } = options;
  const auth: StoreAuth = createStoreAuth({
    fetch: store.fetch,
    storeBaseUrl: () => FAKE_STORE_URL,
    anonKey: FAKE_ANON_KEY,
    cipher,
    slot,
    openExternal: store.browser((url) => auth.handleCallback(url), answer),
    onChange: (change) => changes.push(change),
    now: () => clock,
    ...overrides,
  });
  return auth;
}

/** The stored session, decrypted. */
function storedSession(): Record<string, unknown> | undefined {
  const ciphertext = slot.read();
  return ciphertext === undefined
    ? undefined
    : (JSON.parse(cipher.reveal(ciphertext)) as Record<string, unknown>);
}

function count(request: string): number {
  return store.requests.filter((line) => line.startsWith(request)).length;
}

describe('signing in', () => {
  it('opens the system browser on the Store GitHub sign-in with a PKCE S256 challenge', async () => {
    const auth = createAuth();
    await auth.signIn();
    expect(store.opened).toHaveLength(1);
    const url = new URL(store.opened[0] ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${FAKE_STORE_URL}/auth/v1/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: 'github',
      redirect_to: AUTH_CALLBACK_URL,
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) as unknown,
      code_challenge_method: 's256',
    });
  });

  it('returns signed in with the Store profile once the browser comes back with a code', async () => {
    store.nextUser = 'user-1';
    store.profiles.set('user-1', {
      github_login: 'octo-cat',
      display_name: 'Octo Cat',
      avatar_url: 'https://avatars.example/octo.png',
    });
    const auth = createAuth();
    const signedIn = {
      signedIn: true,
      githubLogin: 'octo-cat',
      displayName: 'Octo Cat',
      avatarUrl: 'https://avatars.example/octo.png',
    };
    await expect(auth.signIn()).resolves.toEqual(signedIn);
    await expect(auth.whoami()).resolves.toEqual(signedIn);
    expect(changes).toEqual([{ ...signedIn, reason: 'signed_in' }]);
    // The code was exchanged with the verifier, then the profile read with the new token.
    expect(count('POST /auth/v1/token?grant_type=pkce')).toBe(1);
    expect(await auth.accessToken()).toMatch(/^access-/);
  });

  it('stores the session only encrypted, without GitHub’s own token', async () => {
    const auth = createAuth();
    await auth.signIn();
    const ciphertext = slot.read();
    expect(ciphertext).toBeDefined();
    const raw = new TextDecoder().decode(ciphertext);
    expect(raw).not.toContain('access-');
    expect(raw).not.toContain('refresh-');
    const session = storedSession();
    expect(session).toMatchObject({
      accessToken: expect.stringMatching(/^access-/) as unknown,
      refreshToken: expect.stringMatching(/^refresh-/) as unknown,
    });
    expect(JSON.stringify(session)).not.toContain('gho_');
  });

  it('refuses to sign in without OS encryption, before opening the browser', async () => {
    cipher.available = false;
    const auth = createAuth();
    await expect(auth.signIn()).rejects.toMatchObject({ code: 'encryption_unavailable' });
    expect(store.opened).toEqual([]);
    expect(slot.read()).toBeUndefined();
  });

  it('fails when the browser comes back with an error, storing nothing', async () => {
    const auth = createAuth({ answer: 'error=access_denied&error_description=denied' });
    await expect(auth.signIn()).rejects.toMatchObject({ code: 'sign_in_failed' });
    expect(slot.read()).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it('fails when the Store refuses the code (a code not issued for this verifier)', async () => {
    const auth = createAuth({ answer: 'code=forged' });
    await expect(auth.signIn()).rejects.toMatchObject({ code: 'sign_in_failed' });
    expect(slot.read()).toBeUndefined();
  });

  it('fails when the browser cannot be opened', async () => {
    const auth = createAuth({ openExternal: () => Promise.reject(new Error('no browser')) });
    await expect(auth.signIn()).rejects.toMatchObject({ code: 'sign_in_failed' });
  });

  it('times out when the browser never comes back, and ignores a late callback', async () => {
    const auth = createAuth({ answer: null, signInTimeoutMs: 20 });
    await expect(auth.signIn()).rejects.toMatchObject({ code: 'sign_in_timeout' });
    expect(auth.handleCallback(`${AUTH_CALLBACK_URL}?code=late`)).toBe(false);
    expect(count('POST /auth/v1/token')).toBe(0);
  });

  it('a newer sign-in replaces one still waiting for its browser', async () => {
    // The first browser never comes back; the second does.
    const answers: (null | undefined)[] = [null, undefined];
    const auth: StoreAuth = createAuth({
      openExternal: (url) =>
        store.browser((callback) => auth.handleCallback(callback), answers.shift())(url),
    });
    const first = auth.signIn();
    await Promise.resolve();
    const second = auth.signIn();
    await expect(first).rejects.toMatchObject({ code: 'sign_in_cancelled' });
    await expect(second).resolves.toMatchObject({ signedIn: true });
  });

  it('ignores callbacks when no sign-in is waiting, and URLs that are not the callback', () => {
    const auth = createAuth();
    expect(auth.handleCallback(`${AUTH_CALLBACK_URL}?code=stray`)).toBe(false);
    expect(auth.handleCallback('harnessstore://somewhere-else?code=x')).toBe(false);
    expect(auth.handleCallback('not a url')).toBe(false);
    expect(store.requests).toEqual([]);
  });
});

describe('the stored session', () => {
  let dir: string;
  let opened: DatabaseSync[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-store-auth-'));
    opened = [];
  });
  afterEach(() => {
    for (const db of opened) if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One app run: the SQLite database of `dir`, freshly opened. */
  function launch(): { auth: StoreAuth; db: DatabaseSync } {
    const db = openDatabase(join(dir, 'harness-store.sqlite'));
    opened.push(db);
    slot = createSqliteSessionSlot(db);
    return { auth: createAuth(), db };
  }

  it('survives an app restart: the reopened encrypted store still holds a usable session', async () => {
    const first = launch();
    const signedIn = await first.auth.signIn();
    first.db.close();

    const second = launch();
    await expect(second.auth.whoami()).resolves.toEqual(signedIn);
    // Usable: the Store accepted its access token for the profile read just now.
    expect(store.requests.at(-1)).toMatch(/^GET \/rest\/v1\/profiles\?id=eq\./);
    const row = second.db
      .prepare('SELECT ciphertext FROM secrets WHERE id = ?')
      .get(STORE_SESSION_SECRET_ID) as { ciphertext: Uint8Array } | undefined;
    expect(row).toBeDefined();
    expect(cipher.reveal(row?.ciphertext ?? new Uint8Array())).toContain('"refreshToken"');
  });

  it('sign out deletes the secrets row; after a restart the app is signed out', async () => {
    const first = launch();
    await first.auth.signIn();
    await expect(first.auth.signOut()).resolves.toEqual({ signedIn: false });
    const rows = first.db.prepare('SELECT id FROM secrets').all();
    expect(rows).toEqual([]);
    first.db.close();

    const second = launch();
    await expect(second.auth.whoami()).resolves.toEqual({ signedIn: false });
  });

  it('deletes a stored row that decrypts to something that is not a session', async () => {
    const { auth, db } = launch();
    slot.write(await cipher.encrypt('{"not":"a session"}'));
    await expect(auth.whoami()).resolves.toEqual({ signedIn: false });
    expect(db.prepare('SELECT id FROM secrets').all()).toEqual([]);
  });

  it('keeps a session the OS cannot decrypt at launch (a denied keychain prompt) for the next launch', async () => {
    const first = launch();
    const signedIn = await first.auth.signIn();
    first.db.close();

    cipher.available = false;
    const second = launch();
    await expect(second.auth.whoami()).resolves.toEqual({ signedIn: false });
    await expect(second.auth.accessToken()).resolves.toBeNull();
    expect(second.db.prepare('SELECT id FROM secrets').all()).toEqual([
      { id: STORE_SESSION_SECRET_ID },
    ]);
    expect(changes.map((change) => change.reason)).toEqual(['signed_in']);
    second.db.close();

    cipher.available = true;
    const third = launch();
    await expect(third.auth.whoami()).resolves.toEqual(signedIn);
  });
});

describe('signing out', () => {
  it('clears the session, revokes it at the Store and reports signed out', async () => {
    const auth = createAuth();
    await auth.signIn();
    const refreshToken = String(storedSession()?.refreshToken);
    changes.length = 0;

    await expect(auth.signOut()).resolves.toEqual({ signedIn: false });
    expect(slot.read()).toBeUndefined();
    expect(changes).toEqual([{ signedIn: false, reason: 'signed_out' }]);
    expect(count('POST /auth/v1/logout?scope=local')).toBe(1);
    expect(store.isRefreshTokenValid(refreshToken)).toBe(false);
    await expect(auth.whoami()).resolves.toEqual({ signedIn: false });
    await expect(auth.accessToken()).resolves.toBeNull();
  });

  it('revokes the session even when its access token has expired (refreshed for the logout only)', async () => {
    const auth = createAuth();
    await auth.signIn();
    clock = new Date(clock.getTime() + 2 * 3600 * 1000);

    await expect(auth.signOut()).resolves.toEqual({ signedIn: false });
    expect(store.requests.slice(-2)).toEqual([
      'POST /auth/v1/token?grant_type=refresh_token',
      'POST /auth/v1/logout?scope=local',
    ]);
    expect(store.liveRefreshTokens()).toBe(0);
    expect(slot.read()).toBeUndefined();
  });

  it('still signs out locally when the Store does not answer', async () => {
    const auth = createAuth();
    await auth.signIn();
    store.offline = true;
    await expect(auth.signOut()).resolves.toEqual({ signedIn: false });
    expect(slot.read()).toBeUndefined();
  });

  it('cancels a sign-in still waiting for its browser', async () => {
    const auth = createAuth({ answer: null });
    const pending = auth.signIn();
    await Promise.resolve();
    await auth.signOut();
    await expect(pending).rejects.toMatchObject({ code: 'sign_in_cancelled' });
  });

  it('does nothing visible when nobody is signed in', async () => {
    const auth = createAuth();
    await expect(auth.signOut()).resolves.toEqual({ signedIn: false });
    expect(changes).toEqual([]);
    expect(store.requests).toEqual([]);
  });
});

describe('an expiring session', () => {
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };

  it('is refreshed within 60 s of expiry, once for concurrent callers, and re-encrypted', async () => {
    const auth = createAuth();
    await auth.signIn();
    const before = storedSession();
    advance(3600 - 30);

    const [token, state] = await Promise.all([auth.accessToken(), auth.whoami()]);
    expect(count('POST /auth/v1/token?grant_type=refresh_token')).toBe(1);
    const after = storedSession();
    expect(after?.refreshToken).not.toBe(before?.refreshToken);
    expect(token).toBe(after?.accessToken);
    expect(state).toMatchObject({ signedIn: true });
    expect(store.isRefreshTokenValid(String(before?.refreshToken))).toBe(false);
  });

  it('is not refreshed while it has more than 60 s left', async () => {
    const auth = createAuth();
    await auth.signIn();
    advance(3600 - 120);
    await auth.whoami();
    expect(count('POST /auth/v1/token?grant_type=refresh_token')).toBe(0);
  });

  it('a refused refresh signs out with session_expired', async () => {
    const auth = createAuth();
    await auth.signIn();
    changes.length = 0;
    store.revokeRefreshTokens();
    advance(3600);

    await expect(auth.whoami()).resolves.toEqual({ signedIn: false });
    expect(slot.read()).toBeUndefined();
    expect(changes).toEqual([{ signedIn: false, reason: 'session_expired' }]);
    await expect(auth.accessToken()).resolves.toBeNull();
  });

  it('a refresh with no answer keeps the session and the last known profile', async () => {
    const auth = createAuth();
    const signedIn = await auth.signIn();
    store.offline = true;
    advance(3600);

    await expect(auth.whoami()).resolves.toEqual(signedIn);
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'store_unreachable' });
    expect(slot.read()).toBeDefined();
    expect(changes.map((change) => change.reason)).toEqual(['signed_in']);
  });

  it('an access token the Store refuses (401 on a call) signs out with session_expired', async () => {
    const auth = createAuth();
    await auth.signIn();
    changes.length = 0;
    await auth.sessionRejected(String(await auth.accessToken()));
    expect(slot.read()).toBeUndefined();
    expect(changes).toEqual([{ signedIn: false, reason: 'session_expired' }]);
    await expect(auth.whoami()).resolves.toEqual({ signedIn: false });
  });
});

describe('whoami', () => {
  it('is signed out with no stored session, without asking the Store', async () => {
    const auth = createAuth();
    await expect(auth.whoami()).resolves.toEqual({ signedIn: false });
    expect(store.requests).toEqual([]);
  });

  it('follows the profile as the Store has it now, and stores the new copy', async () => {
    store.nextUser = 'user-2';
    const auth = createAuth();
    await auth.signIn();
    const profile = store.profiles.get('user-2');
    if (profile === undefined) throw new Error('No profile');
    profile.display_name = 'Renamed';

    await expect(auth.whoami()).resolves.toMatchObject({ displayName: 'Renamed' });
    expect(storedSession()?.identity).toMatchObject({ displayName: 'Renamed' });
    store.offline = true;
    await expect(auth.whoami()).resolves.toMatchObject({ displayName: 'Renamed' });
  });

  it('signs out a session whose Publisher profile no longer exists', async () => {
    store.nextUser = 'user-3';
    const auth = createAuth();
    await auth.signIn();
    store.profiles.delete('user-3');
    await expect(auth.whoami()).resolves.toEqual({ signedIn: false });
    expect(changes.at(-1)).toEqual({ signedIn: false, reason: 'session_expired' });
  });

  it('treats a session it cannot decrypt (a reset keychain) as signed out, until a new sign-in', async () => {
    const auth = createAuth();
    await auth.signIn();
    const unreadable = new TextEncoder().encode('not this cipher');
    slot.write(unreadable);
    changes.length = 0;
    await expect(auth.whoami()).resolves.toEqual({ signedIn: false });
    await auth.sessionRejected('access-1');
    // Kept (it may be readable again later) but never reported as a session that expired.
    expect(slot.read()).toBe(unreadable);
    expect(changes).toEqual([]);
    await expect(auth.signIn()).resolves.toMatchObject({ signedIn: true });
    await expect(auth.whoami()).resolves.toMatchObject({ signedIn: true });
  });
});

describe('calls that overlap', () => {
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1000);
  };

  it('a sign-out while the session is being decrypted is not undone by a refresh', async () => {
    const auth = createAuth();
    await auth.signIn();
    changes.length = 0;
    advance(3600 - 30);

    const release = cipher.holdDecrypts();
    const token = auth.accessToken();
    const state = auth.whoami();
    const signedOut = auth.signOut();
    release();

    await expect(token).resolves.toBeNull();
    await expect(state).resolves.toEqual({ signedIn: false });
    await signedOut;
    expect(slot.read()).toBeUndefined();
    expect(changes).toEqual([{ signedIn: false, reason: 'signed_out' }]);
    await expect(auth.whoami()).resolves.toEqual({ signedIn: false });
  });

  it('a sign-out while whoami decrypts the session answers signed out', async () => {
    const auth = createAuth();
    await auth.signIn();
    const release = cipher.holdDecrypts();
    const state = auth.whoami();
    const signedOut = auth.signOut();
    release();
    await expect(state).resolves.toEqual({ signedIn: false });
    await signedOut;
    expect(slot.read()).toBeUndefined();
  });

  it('a new profile copy never writes back a refresh token that a refresh rotated meanwhile', async () => {
    store.nextUser = 'user-4';
    const auth = createAuth();
    await auth.signIn();
    const profile = store.profiles.get('user-4');
    if (profile === undefined) throw new Error('No profile');
    profile.display_name = 'Renamed';
    advance(3600 - 90);

    // whoami reads the session (90 s left: no refresh) and waits for the profile...
    const release = store.hold('GET /rest/v1/profiles');
    const state = auth.whoami();
    await vi.waitFor(() => {
      expect(count('GET /rest/v1/profiles')).toBe(2);
    });
    // ...while another call refreshes it, which rotates the refresh token.
    advance(60);
    await auth.accessToken();
    const rotated = String(storedSession()?.refreshToken);
    release();

    await expect(state).resolves.toMatchObject({ displayName: 'Renamed' });
    expect(storedSession()?.refreshToken).toBe(rotated);
    expect(store.isRefreshTokenValid(rotated)).toBe(true);
    // The next whoami stores the new profile copy, with the rotated token.
    await expect(auth.whoami()).resolves.toMatchObject({ displayName: 'Renamed' });
    expect(storedSession()).toMatchObject({
      refreshToken: rotated,
      identity: { displayName: 'Renamed' },
    });
  });

  it('a 401 for the token of an earlier sign-in leaves the current one alone', async () => {
    const auth = createAuth();
    await auth.signIn();
    const earlier = String(await auth.accessToken());
    await auth.signOut();
    await auth.signIn();
    changes.length = 0;

    await auth.sessionRejected(earlier);
    expect(changes).toEqual([]);
    await expect(auth.whoami()).resolves.toMatchObject({ signedIn: true });
  });
});
