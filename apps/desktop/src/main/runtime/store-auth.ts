import { createHash, randomBytes } from 'node:crypto';
import type { AuthChanged, AuthState } from '../../shared/ipc.js';
import type { SecretCipher } from './secret-cipher.js';
import type { SessionSlot } from './session-slot.js';

/** The custom URL scheme the app registers with the OS to receive the sign-in callback. */
export const AUTH_SCHEME = 'harnessstore';

/** Where the Store's Auth sends the browser once GitHub's consent is given (config.toml allows it). */
export const AUTH_CALLBACK_URL = `${AUTH_SCHEME}://auth-callback`;

/** A sign-in whose browser has not come back after this long fails with `sign_in_timeout`. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

/** An access token that expires within this many seconds is refreshed before it is used. */
export const REFRESH_MARGIN_SECONDS = 60;

/** A Store request with no answer after this long counts as `store_unreachable`. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Signing out revokes the session at the Store, but waits at most this long for it. */
const LOGOUT_TIMEOUT_MS = 5_000;

export type StoreAuthErrorCode =
  | 'encryption_unavailable'
  | 'sign_in_failed'
  | 'sign_in_timeout'
  | 'sign_in_cancelled'
  | 'store_unreachable';

/** Why a sign-in or a Store call for the session failed; its `code` is the IPC error code. */
export class StoreAuthError extends Error {
  readonly code: StoreAuthErrorCode;

  constructor(code: StoreAuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StoreAuthError';
    this.code = code;
  }
}

/**
 * The part of `fetch` the Store's Auth and PostgREST need. The app passes Electron's `net.fetch`,
 * so the OS proxy settings apply; tests pass a fake Store or Node's `fetch`.
 */
export type StoreFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface StoreAuthOptions {
  readonly fetch: StoreFetch;
  /** The Store base URL (Supabase API URL), read on every request. */
  readonly storeBaseUrl: () => string;
  /** The Store's public anon key, sent as `apikey` on every request. */
  readonly anonKey: string;
  /** Encrypts the session (Electron `safeStorage`); without it, nobody can sign in. */
  readonly cipher: SecretCipher;
  /** Where the encrypted session is kept (the `secrets` table). */
  readonly slot: SessionSlot;
  /** Opens a URL in the User's default browser (Electron `shell.openExternal`). */
  readonly openExternal: (url: string) => Promise<void>;
  /** Told of every change of the sign-in state, so the main window can be told too. */
  readonly onChange?: (change: AuthChanged) => void;
  /** The clock that decides when an access token needs refreshing. Default: the system clock. */
  readonly now?: () => Date;
  /** Default: {@link SIGN_IN_TIMEOUT_MS}. */
  readonly signInTimeoutMs?: number;
}

/**
 * The Publisher's sign-in to the Store: Supabase Auth's GitHub provider with PKCE, in the User's
 * own browser, and the resulting session, kept encrypted in the `secrets` table. Electron-free: the
 * app passes `shell.openExternal`, `net.fetch` and `safeStorage`, and routes the
 * `harnessstore://auth-callback` URLs the OS hands it to {@link handleCallback}.
 */
export interface StoreAuth {
  /**
   * Opens the Store's GitHub sign-in in the browser and resolves once its callback arrives, the
   * code is exchanged for a session, the profile is read and the session is stored encrypted.
   * Rejects with a {@link StoreAuthError}: `encryption_unavailable` before the browser opens,
   * `sign_in_timeout`, `sign_in_cancelled` (a newer sign-in or a sign-out), `sign_in_failed` or
   * `store_unreachable`.
   */
  signIn(): Promise<AuthState>;
  /**
   * Deletes the stored session at once, then revokes it at the Store (best effort, a few seconds
   * at most), refreshing an access token that has expired first since Auth's logout needs a valid
   * one. A sign-in waiting for its callback is cancelled.
   */
  signOut(): Promise<AuthState>;
  /**
   * The signed-in Publisher, with the profile read from the Store now (the stored copy while the
   * Store does not answer). A session the Store refuses is deleted: signed out, and an
   * `auth.changed` with `session_expired`. A session the OS cannot decrypt right now is signed out
   * for this call but kept, for the next call or launch to read.
   */
  whoami(): Promise<AuthState>;
  /**
   * Takes a URL the OS opened the app with. Returns true when it was the callback of the sign-in
   * in progress (which then completes or fails); false for anything else, including a callback
   * when no sign-in is waiting, which is ignored.
   */
  handleCallback(url: string): boolean;
  /**
   * An access token for an authenticated Store call: refreshed (and the rotated session stored
   * again) when it expires within {@link REFRESH_MARGIN_SECONDS}; null when signed out or when the
   * refresh was refused (the session is then deleted and `session_expired` sent). Rejects with
   * `store_unreachable` when the refresh got no answer.
   */
  accessToken(): Promise<string | null>;
  /**
   * For Store calls made with {@link accessToken}: the Store answered 401 to `accessToken`, so
   * the session is no longer valid. Deletes it and sends `session_expired`, but only while it is
   * still the stored session: a 401 for the token of a session that was since refreshed, signed
   * out or replaced by another sign-in changes nothing.
   */
  sessionRejected(accessToken: string): Promise<void>;
}

type Identity = Omit<Extract<AuthState, { signedIn: true }>, 'signedIn'>;

/** What is stored, encrypted. GitHub's own token (`provider_token`) is never kept. */
interface StoredSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** When the access token expires, in Unix seconds. */
  readonly expiresAt: number;
  /** The Supabase user id, which is the `profiles.id`. */
  readonly userId: string;
  /** The profile as last read, for `whoami` while the Store does not answer. */
  readonly identity: Identity;
}

/** The stored session (null: signed out) as of a `generation` and `revision`. */
interface Snapshot {
  readonly session: StoredSession | null;
  readonly generation: number;
  readonly revision: number;
}

const SIGNED_OUT: AuthState = { signedIn: false };

const signedIn = (identity: Identity): AuthState => ({ signedIn: true, ...identity });

export function createStoreAuth(options: StoreAuthOptions): StoreAuth {
  const { cipher, slot, onChange } = options;
  const now = options.now ?? (() => new Date());
  const nowSeconds = () => Math.floor(now().getTime() / 1000);
  const signInTimeoutMs = options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS;

  /** The sign-in waiting for its callback, if any. */
  let pending: { finish(result: string | StoreAuthError): void } | null = null;
  /**
   * Bumped by every sign-in, sign-out and expiry. A step that awaited something (a decrypt
   * included) writes the session or answers from it only if it is unchanged, so a sign-out is
   * never undone by a refresh, whoami or sign-in that was already under way.
   */
  let generation = 0;
  /**
   * Bumped by every write or deletion of the stored session, refreshes included, so a step that
   * only updates the stored copy never writes back a session a refresh has rotated meanwhile.
   */
  let revision = 0;
  /** The refresh in flight: refresh tokens rotate, so two callers must share one refresh. */
  let refreshing: Promise<Snapshot> | null = null;

  async function request(
    path: string,
    init: { method?: string; token?: string; body?: unknown },
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<{ status: number; body: unknown }> {
    const base = options.storeBaseUrl().replace(/\/+$/, '');
    try {
      const response = await options.fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          apikey: options.anonKey,
          ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        // Not JSON: the callers treat it as an unexpected answer.
      }
      return { status: response.status, body };
    } catch (cause) {
      throw new StoreAuthError('store_unreachable', `The Store did not answer ${path}.`, { cause });
    }
  }

  /** Whether an answer means the Store is not answering properly, rather than refusing. */
  const unavailable = (status: number) => status === 429 || status >= 500;

  /** The signed-in profile, or null when the Store refuses the token or has no profile for it. */
  async function readProfile(accessToken: string, userId: string): Promise<Identity | null> {
    const reply = await request(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=github_login,display_name,avatar_url`,
      { token: accessToken },
    );
    if (reply.status === 401 || reply.status === 403) return null;
    if (reply.status !== 200) {
      throw new StoreAuthError(
        'store_unreachable',
        `The profile read answered ${String(reply.status)}.`,
      );
    }
    const row: unknown = Array.isArray(reply.body) ? reply.body[0] : undefined;
    return identityFrom(row);
  }

  /**
   * The stored session, decrypted. A ciphertext that decrypts to something that is not a session
   * is deleted. One that does not decrypt is kept and counts as signed out for this call only:
   * `safeStorage` also fails while the OS keychain is unavailable for a moment (a denied macOS
   * keychain prompt, a Linux keyring not unlocked yet), and the next call or launch can read it.
   * The next sign-in or sign-out replaces it.
   */
  async function load(): Promise<StoredSession | null> {
    const started = revision;
    const ciphertext = slot.read();
    if (ciphertext === undefined) return null;
    let plaintext: string;
    try {
      plaintext = await cipher.decrypt(ciphertext);
    } catch {
      return null;
    }
    let session: StoredSession | null = null;
    try {
      session = parseStoredSession(JSON.parse(plaintext));
    } catch {
      // Not JSON: not a session.
    }
    if (session === null && revision === started) clear();
    return session;
  }

  /**
   * The stored session with the state it belongs to. A sign-in, sign-out, refresh or expiry that
   * happens while it is being decrypted makes it read again, so a caller never acts on a session
   * that was replaced or deleted in the meantime.
   */
  async function current(): Promise<Snapshot> {
    for (;;) {
      const at = { generation, revision };
      const session = await load();
      if (generation === at.generation && revision === at.revision) return { session, ...at };
    }
  }

  function write(ciphertext: Uint8Array): void {
    revision += 1;
    slot.write(ciphertext);
  }

  function clear(): void {
    revision += 1;
    slot.clear();
  }

  /**
   * Encrypts and stores `session`, unless the sign-in state changed since `expected.generation`
   * or, when given, the stored session changed since `expected.revision`. Returns the revision it
   * wrote, else null.
   */
  async function save(
    session: StoredSession,
    expected: { readonly generation: number; readonly revision?: number },
  ): Promise<number | null> {
    let ciphertext: Uint8Array;
    try {
      ciphertext = await cipher.encrypt(JSON.stringify(session));
    } catch (cause) {
      throw new StoreAuthError(
        'encryption_unavailable',
        'The session cannot be stored encrypted.',
        { cause },
      );
    }
    if (generation !== expected.generation) return null;
    if (expected.revision !== undefined && revision !== expected.revision) return null;
    write(ciphertext);
    return revision;
  }

  function expire(): void {
    generation += 1;
    clear();
    onChange?.({ signedIn: false, reason: 'session_expired' });
  }

  /** The stored session, refreshed first when its access token is about to expire. */
  async function freshSession(): Promise<Snapshot> {
    const snapshot = await current();
    const { session } = snapshot;
    if (session === null || session.expiresAt - nowSeconds() > REFRESH_MARGIN_SECONDS) {
      return snapshot;
    }
    refreshing ??= (async () => {
      try {
        const reply = await request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          body: { refresh_token: session.refreshToken },
        });
        if (generation !== snapshot.generation) return await current();
        if (unavailable(reply.status)) {
          throw new StoreAuthError(
            'store_unreachable',
            `The refresh answered ${String(reply.status)}.`,
          );
        }
        const tokens = reply.status === 200 ? tokensFrom(reply.body, nowSeconds()) : null;
        if (tokens === null) {
          expire();
          return { session: null, generation, revision };
        }
        // The old refresh token no longer works, so the rotated session is stored whatever
        // else was stored meanwhile for this sign-in (a newer profile copy is read again later).
        const next: StoredSession = { ...tokens, identity: session.identity };
        const written = await save(next, { generation: snapshot.generation });
        return written === null
          ? await current()
          : { session: next, generation: snapshot.generation, revision: written };
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /**
   * Revokes `session` at the Store. Auth's logout takes only an unexpired access token, so one
   * that expires soon is first exchanged for a new one (not stored: the session is already gone
   * from this machine). Best effort, and within {@link LOGOUT_TIMEOUT_MS} in all.
   */
  async function revoke(session: StoredSession): Promise<void> {
    const deadline = Date.now() + LOGOUT_TIMEOUT_MS;
    const remaining = () => Math.max(1, deadline - Date.now());
    let accessToken = session.accessToken;
    if (session.expiresAt - nowSeconds() <= REFRESH_MARGIN_SECONDS) {
      const reply = await request(
        '/auth/v1/token?grant_type=refresh_token',
        { method: 'POST', body: { refresh_token: session.refreshToken } },
        remaining(),
      );
      const tokens = reply.status === 200 ? tokensFrom(reply.body, nowSeconds()) : null;
      // Refused: the Store already ended the session. No answer: nothing more to try.
      if (tokens === null) return;
      accessToken = tokens.accessToken;
    }
    await request(
      '/auth/v1/logout?scope=local',
      { method: 'POST', token: accessToken },
      remaining(),
    );
  }

  /** Opens the browser on `url` and resolves with the code of the callback that comes back. */
  function waitForCallback(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const entry = {
        finish(result: string | StoreAuthError) {
          if (pending !== entry) return;
          pending = null;
          clearTimeout(timer);
          if (typeof result === 'string') resolve(result);
          else reject(result);
        },
      };
      const timer = setTimeout(() => {
        entry.finish(
          new StoreAuthError('sign_in_timeout', 'The browser did not come back in time.'),
        );
      }, signInTimeoutMs);
      pending = entry;
      options.openExternal(url).catch((cause: unknown) => {
        entry.finish(
          new StoreAuthError('sign_in_failed', 'The browser could not be opened.', { cause }),
        );
      });
    });
  }

  function cancelPending(): void {
    pending?.finish(new StoreAuthError('sign_in_cancelled', 'The sign-in was replaced.'));
  }

  return {
    async signIn() {
      if (!(await cipher.isAvailable())) {
        throw new StoreAuthError(
          'encryption_unavailable',
          'The OS offers no encryption for the session.',
        );
      }
      cancelPending();
      generation += 1;
      const started = generation;
      // PKCE (RFC 7636): the code the browser brings back is worthless without this verifier,
      // which never leaves this process.
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const authorize = new URLSearchParams({
        provider: 'github',
        redirect_to: AUTH_CALLBACK_URL,
        code_challenge: challenge,
        code_challenge_method: 's256',
      });
      const base = options.storeBaseUrl().replace(/\/+$/, '');
      const code = await waitForCallback(`${base}/auth/v1/authorize?${authorize.toString()}`);

      const reply = await request('/auth/v1/token?grant_type=pkce', {
        method: 'POST',
        body: { auth_code: code, code_verifier: verifier },
      });
      if (unavailable(reply.status)) {
        throw new StoreAuthError(
          'store_unreachable',
          `The code exchange answered ${String(reply.status)}.`,
        );
      }
      const tokens = reply.status === 200 ? tokensFrom(reply.body, nowSeconds()) : null;
      if (tokens === null) {
        throw new StoreAuthError(
          'sign_in_failed',
          `The Store refused the sign-in code (${String(reply.status)}).`,
        );
      }
      const identity = await readProfile(tokens.accessToken, tokens.userId);
      if (identity === null) {
        throw new StoreAuthError('sign_in_failed', 'The Store has no Publisher profile for it.');
      }
      if ((await save({ ...tokens, identity }, { generation: started })) === null) {
        throw new StoreAuthError('sign_in_cancelled', 'The sign-in was replaced.');
      }
      const state = signedIn(identity);
      onChange?.({ ...state, reason: 'signed_in' });
      return state;
    },

    async signOut() {
      cancelPending();
      generation += 1;
      const ciphertext = slot.read();
      if (ciphertext === undefined) return SIGNED_OUT;
      clear();
      onChange?.({ signedIn: false, reason: 'signed_out' });
      try {
        const session = parseStoredSession(JSON.parse(await cipher.decrypt(ciphertext)));
        if (session !== null) await revoke(session);
      } catch {
        // Best effort: the session is gone from this machine whatever the Store answered.
      }
      return SIGNED_OUT;
    },

    async whoami() {
      const stateNow = async () => {
        const { session } = await current();
        return session === null ? SIGNED_OUT : signedIn(session.identity);
      };
      let snapshot: Snapshot;
      try {
        snapshot = await freshSession();
      } catch (error) {
        if (!(error instanceof StoreAuthError) || error.code !== 'store_unreachable') throw error;
        return stateNow();
      }
      const { session } = snapshot;
      if (session === null) return SIGNED_OUT;
      let identity: Identity | null;
      try {
        identity = await readProfile(session.accessToken, session.userId);
      } catch (error) {
        if (!(error instanceof StoreAuthError) || error.code !== 'store_unreachable') throw error;
        return stateNow();
      }
      // A sign-in, sign-out or expiry while the profile was read: answer for the state now.
      if (generation !== snapshot.generation) return stateNow();
      if (identity === null) {
        expire();
        return SIGNED_OUT;
      }
      if (!sameIdentity(identity, session.identity)) {
        // Only if no refresh stored a rotated session meanwhile; the next whoami tries again.
        await save({ ...session, identity }, snapshot);
      }
      return signedIn(identity);
    },

    handleCallback(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      if (parsed.protocol !== `${AUTH_SCHEME}:` || parsed.hostname !== 'auth-callback')
        return false;
      if (pending === null) return false;
      // Auth puts the PKCE code (or an error) in the query; an error may also come in the fragment.
      const params = new URLSearchParams(parsed.search);
      for (const [key, value] of new URLSearchParams(parsed.hash.slice(1))) {
        if (!params.has(key)) params.set(key, value);
      }
      const error = params.get('error');
      const code = params.get('code');
      if (error !== null || code === null || code === '') {
        const detail = params.get('error_description') ?? error ?? 'no code';
        pending.finish(new StoreAuthError('sign_in_failed', `The sign-in failed: ${detail}`));
      } else {
        pending.finish(code);
      }
      return true;
    },

    async accessToken() {
      return (await freshSession()).session?.accessToken ?? null;
    },

    async sessionRejected(accessToken) {
      const { session, generation: at } = await current();
      if (session?.accessToken === accessToken && generation === at) expire();
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/** A `profiles` row (`github_login, display_name, avatar_url`) as an identity, else null. */
function identityFrom(row: unknown): Identity | null {
  if (!isRecord(row)) return null;
  const { github_login: githubLogin, display_name: displayName, avatar_url: avatarUrl } = row;
  if (typeof githubLogin !== 'string' || githubLogin === '') return null;
  if (!isNullableString(displayName) || !isNullableString(avatarUrl)) return null;
  return { githubLogin, displayName, avatarUrl };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.githubLogin === b.githubLogin &&
    a.displayName === b.displayName &&
    a.avatarUrl === b.avatarUrl
  );
}

/** The session of an Auth token answer (`grant_type=pkce` or `refresh_token`), else null. */
function tokensFrom(body: unknown, nowSeconds: number): Omit<StoredSession, 'identity'> | null {
  if (!isRecord(body) || !isRecord(body.user)) return null;
  const { access_token: accessToken, refresh_token: refreshToken } = body;
  const { expires_at: expiresAt, expires_in: expiresIn } = body;
  const userId = body.user.id;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') return null;
  if (typeof userId !== 'string') return null;
  const expiry =
    typeof expiresAt === 'number'
      ? expiresAt
      : typeof expiresIn === 'number'
        ? nowSeconds + expiresIn
        : null;
  if (expiry === null) return null;
  return { accessToken, refreshToken, expiresAt: expiry, userId };
}

function parseStoredSession(value: unknown): StoredSession | null {
  if (!isRecord(value)) return null;
  const { accessToken, refreshToken, expiresAt, userId } = value;
  const identity = isRecord(value.identity) ? value.identity : null;
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') return null;
  if (typeof expiresAt !== 'number' || typeof userId !== 'string' || identity === null) return null;
  const { githubLogin, displayName, avatarUrl } = identity;
  if (typeof githubLogin !== 'string' || !isNullableString(displayName)) return null;
  if (!isNullableString(avatarUrl)) return null;
  return {
    accessToken,
    refreshToken,
    expiresAt,
    userId,
    identity: { githubLogin, displayName, avatarUrl },
  };
}
