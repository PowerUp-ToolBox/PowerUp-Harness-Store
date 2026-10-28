/**
 * Ticket P0-07.2: GitHub sign-in from the desktop app, against the local stack's real Auth. The
 * desktop app's own auth module (apps/desktop/src/main/runtime/store-auth.ts, Electron-free) runs
 * the whole PKCE flow: it opens a browser (fake-github.ts plays it, consenting on the fake
 * GitHub), receives the harnessstore://auth-callback URL, exchanges the code with Auth and reads
 * the Publisher's profile through PostgREST. Only GitHub is faked; Auth, the profile trigger and
 * RLS are the real ones.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_STORE_ANON_KEY } from '../../desktop/src/main/runtime/connectivity.ts';
import type { SecretCipher } from '../../desktop/src/main/runtime/secret-cipher.ts';
import {
  createMemorySessionSlot,
  type SessionSlot,
} from '../../desktop/src/main/runtime/session-slot.ts';
import {
  AUTH_CALLBACK_URL,
  createStoreAuth,
  type StoreAuth,
} from '../../desktop/src/main/runtime/store-auth.ts';
import {
  FAKE_GITHUB_URL,
  signInBrowser,
  startFakeGitHub,
  stopFakeGitHub,
  type GitHubIdentity,
} from './fake-github.ts';
import { call, deleteUser, serviceRest, stack } from './support.ts';

/** A reversible stand-in for Electron's safeStorage: what the slot holds is not the plaintext. */
const cipher: SecretCipher = {
  isAvailable: () => Promise.resolve(true),
  encrypt: (plaintext) =>
    Promise.resolve(new Uint8Array(Buffer.from(plaintext).map((byte) => byte ^ 0x5a))),
  decrypt: (ciphertext) =>
    Promise.resolve(Buffer.from(ciphertext.map((byte) => byte ^ 0x5a)).toString('utf8')),
};

/** A GitHub account no other run has used; the login is mixed case, as GitHub allows. */
function newIdentity(): GitHubIdentity {
  const suffix = randomBytes(4).toString('hex');
  return {
    id: randomInt(1, 2 ** 31),
    login: `Octo-Cat-${suffix}`,
    name: `Octo Cat ${suffix}`,
    email: `octo-${suffix}@fake-github.invalid`,
  };
}

const identity = newIdentity();
const login = identity.login.toLowerCase();
const userIds = new Set<string>();

/** One app run's auth module over `slot`; its browser signs in on the fake GitHub as `identity`. */
function createAuth(slot: SessionSlot, visited: string[] = [], now?: () => Date): StoreAuth {
  const auth: StoreAuth = createStoreAuth({
    fetch: (url, init) => fetch(url, init),
    storeBaseUrl: () => stack.apiUrl,
    anonKey: stack.anonKey,
    cipher,
    slot,
    openExternal: signInBrowser(
      () => identity,
      (url) => auth.handleCallback(url),
      visited,
    ),
    ...(now === undefined ? {} : { now }),
  });
  return auth;
}

/** The Auth user the access token belongs to, or the status Auth refused it with. */
async function authUser(accessToken: string) {
  const reply = await call<{ id: string; app_metadata: { provider?: string } }>(
    { token: accessToken },
    'GET',
    'auth/v1/user',
  );
  return reply;
}

function storedRefreshToken(slot: SessionSlot): Promise<string> {
  const ciphertext = slot.read();
  if (ciphertext === undefined) throw new Error('No stored session');
  return cipher
    .decrypt(ciphertext)
    .then((json) => (JSON.parse(json) as { refreshToken: string }).refreshToken);
}

beforeAll(async () => {
  await startFakeGitHub();
});

afterAll(async () => {
  stopFakeGitHub();
  for (const id of userIds) await deleteUser({ id, userName: login, token: '' });
});

describe('GitHub sign-in from the desktop app', () => {
  const slot = createMemorySessionSlot();

  it('the desktop app’s built-in anon key is the local stack’s', () => {
    expect(LOCAL_STORE_ANON_KEY).toBe(stack.anonKey);
  });

  it('drives the PKCE flow through the system browser and ends with a valid session', async () => {
    const visited: string[] = [];
    const auth = createAuth(slot, visited);

    const state = await auth.signIn();
    expect(state).toEqual({
      signedIn: true,
      githubLogin: login,
      displayName: identity.name,
      avatarUrl: `https://avatars.fake-github.invalid/u/${String(identity.id)}`,
    });

    // The app opened the Store's GitHub sign-in with a PKCE challenge, the browser consented on
    // GitHub (the fake), and Auth sent it back to the app's custom scheme with a code.
    const authorize = new URL(visited[0] ?? '');
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${stack.apiUrl}/auth/v1/authorize`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256');
    expect(visited.some((url) => url.startsWith(`${FAKE_GITHUB_URL}/login/oauth/authorize?`))).toBe(
      true,
    );
    expect(visited.at(-1)).toMatch(new RegExp(`^${AUTH_CALLBACK_URL}\\?code=[0-9a-f-]{36}$`));

    // A valid Supabase session: Auth accepts its access token, for a GitHub user.
    const token = await auth.accessToken();
    expect(token).not.toBeNull();
    const user = await authUser(token ?? '');
    expect(user.status).toBe(200);
    expect(user.body.app_metadata.provider).toBe('github');
    userIds.add(user.body.id);
  });

  it('creates exactly one profiles row, with the lower-cased github_login, even on a second sign-in', async () => {
    const rows = await serviceRest<{ id: string; github_login: string }[]>(
      'GET',
      `profiles?github_login=eq.${login}&select=id,github_login`,
    );
    expect(rows).toHaveLength(1);
    expect(userIds).toContain(rows[0]?.id);

    await createAuth(createMemorySessionSlot()).signIn();
    const again = await serviceRest<{ id: string }[]>(
      'GET',
      `profiles?github_login=ilike.${login}&select=id`,
    );
    expect(again).toEqual(rows.map((row) => ({ id: row.id })));
  });

  it('keeps the session across an app restart: a fresh module on the stored slot is signed in', async () => {
    const restarted = createAuth(slot);
    await expect(restarted.whoami()).resolves.toMatchObject({ signedIn: true, githubLogin: login });
    const token = await restarted.accessToken();
    expect((await authUser(token ?? '')).status).toBe(200);
  });

  it('refreshes an access token about to expire with Auth, and the new one is valid', async () => {
    const before = await storedRefreshToken(slot);
    const tokenBefore = await createAuth(slot).accessToken();
    // A clock 59 minutes ahead: the access token has less than 60 s left.
    const later = createAuth(slot, [], () => new Date(Date.now() + 59 * 60_000));
    const token = await later.accessToken();
    expect(token).not.toBe(tokenBefore);
    expect(await storedRefreshToken(slot)).not.toBe(before);
    expect((await authUser(token ?? '')).status).toBe(200);
  });

  it('signs out: the stored session is gone, whoami is signed out, and Auth revoked it', async () => {
    const auth = createAuth(slot);
    const refreshToken = await storedRefreshToken(slot);

    await expect(auth.signOut()).resolves.toEqual({ signedIn: false });
    expect(slot.read()).toBeUndefined();
    await expect(auth.whoami()).resolves.toEqual({ signedIn: false });
    await expect(auth.accessToken()).resolves.toBeNull();

    const refresh = await call('anon', 'POST', 'auth/v1/token?grant_type=refresh_token', {
      refresh_token: refreshToken,
    });
    expect(refresh.status).toBe(400);
  });
});
