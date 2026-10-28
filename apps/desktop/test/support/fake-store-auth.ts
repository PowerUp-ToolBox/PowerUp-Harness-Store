import { createHash, randomUUID } from 'node:crypto';
import type { StoreFetch } from '../../src/main/runtime/store-auth.js';

export const FAKE_STORE_URL = 'http://store.test';
export const FAKE_ANON_KEY = 'fake-anon-key';

/** A Publisher as the Store's `profiles` row has them. */
export interface FakeProfile {
  github_login: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface FakeStoreAuth {
  /** The Store's Auth and PostgREST `profiles`, at the HTTP seam. */
  readonly fetch: StoreFetch;
  /** `METHOD /path?query` of every request, in order. */
  readonly requests: string[];
  /** The profile of each user id. */
  readonly profiles: Map<string, FakeProfile>;
  /** While true, every request fails as a network error. */
  offline: boolean;
  /** The user the next completed consent signs in as; a new one per call unless given. */
  nextUser: string;
  /**
   * Plays the User's browser for `openExternal`: checks the URL is the Store's GitHub sign-in
   * with PKCE, "consents" and hands the callback URL to `deliver`, as the OS would. With `answer`,
   * the browser comes back with that query instead of a code (e.g. `error=access_denied`), and
   * with `answer: null` it never comes back.
   */
  browser(
    deliver: (url: string) => boolean,
    answer?: string | null,
  ): (url: string) => Promise<void>;
  /** The URLs the browser was opened on. */
  readonly opened: string[];
  /** Revokes every refresh token, as GoTrue does when a session ends elsewhere. */
  revokeRefreshTokens(): void;
  /** Whether a refresh token is still accepted. */
  isRefreshTokenValid(token: string): boolean;
  /** How many refresh tokens are still accepted, whoever they were issued to. */
  liveRefreshTokens(): number;
  /**
   * Holds every request starting with `request` (`METHOD /path`) until the returned function is
   * called; the request is recorded at once.
   */
  hold(request: string): () => void;
}

/**
 * A fake of the Store's Supabase Auth (authorize, PKCE code exchange, refresh with rotation,
 * logout) and of the PostgREST `profiles` read, checking what the real ones check: the anon key,
 * the PKCE verifier against its S256 challenge, single-use codes and refresh tokens, and access
 * token expiry on the clock `now`.
 */
export function createFakeStoreAuth(now: () => Date = () => new Date()): FakeStoreAuth {
  const requests: string[] = [];
  const opened: string[] = [];
  const profiles = new Map<string, FakeProfile>();
  /** Authorization code → its PKCE challenge and user. */
  const codes = new Map<string, { challenge: string; userId: string }>();
  const accessTokens = new Map<string, { userId: string; expiresAt: number }>();
  const refreshTokens = new Map<string, string>();
  let counter = 0;
  const holds: { prefix: string; released: Promise<void> }[] = [];
  const seconds = () => Math.floor(now().getTime() / 1000);

  const json = (status: number, body: unknown) =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const issue = (userId: string) => {
    counter += 1;
    const accessToken = `access-${String(counter)}`;
    const refreshToken = `refresh-${String(counter)}`;
    const expiresAt = seconds() + 3600;
    accessTokens.set(accessToken, { userId, expiresAt });
    refreshTokens.set(refreshToken, userId);
    return json(200, {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expiresAt,
      refresh_token: refreshToken,
      user: { id: userId, app_metadata: { provider: 'github' } },
      // GitHub's own token, which the app must not keep.
      provider_token: 'gho_github-token',
    });
  };

  const bearerUser = (headers: Headers): string | null => {
    const token = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    const entry = token === undefined ? undefined : accessTokens.get(token);
    return entry !== undefined && entry.expiresAt > seconds() ? entry.userId : null;
  };

  /** The answer of the fake Store to one request. */
  const respond = (target: URL, method: string, init: RequestInit): Response => {
    const headers = new Headers(init.headers);
    if (target.origin !== FAKE_STORE_URL || headers.get('apikey') !== FAKE_ANON_KEY) {
      return json(401, { message: 'Invalid API key' });
    }
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const grant = target.searchParams.get('grant_type');
    if (method === 'POST' && target.pathname === '/auth/v1/token' && grant === 'pkce') {
      const code = codes.get(String(body.auth_code));
      codes.delete(String(body.auth_code));
      const verifier = String(body.code_verifier);
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (code?.challenge !== challenge) {
        return json(400, { error_code: 'flow_state_not_found' });
      }
      return issue(code.userId);
    }
    if (method === 'POST' && target.pathname === '/auth/v1/token' && grant === 'refresh_token') {
      const token = String(body.refresh_token);
      const userId = refreshTokens.get(token);
      if (userId === undefined) {
        return json(400, { error_code: 'refresh_token_not_found' });
      }
      refreshTokens.delete(token);
      return issue(userId);
    }
    if (method === 'POST' && target.pathname === '/auth/v1/logout') {
      const userId = bearerUser(headers);
      if (userId === null) return json(401, { message: 'invalid JWT' });
      for (const [token, owner] of refreshTokens) if (owner === userId) refreshTokens.delete(token);
      return json(204, null);
    }
    if (method === 'GET' && target.pathname === '/rest/v1/profiles') {
      const userId = bearerUser(headers);
      if (userId === null) return json(401, { code: 'PGRST301' });
      const id = target.searchParams.get('id')?.replace(/^eq\./, '');
      const profile = id === undefined ? undefined : profiles.get(id);
      return json(200, profile === undefined ? [] : [profile]);
    }
    return json(404, { message: 'Not found' });
  };

  const fake: FakeStoreAuth = {
    requests,
    profiles,
    opened,
    offline: false,
    nextUser: '',
    async fetch(url, init) {
      const target = new URL(url);
      const method = init.method ?? 'GET';
      const line = `${method} ${target.pathname}${target.search}`;
      requests.push(line);
      for (const hold of holds) if (line.startsWith(hold.prefix)) await hold.released;
      if (fake.offline) throw new TypeError('fetch failed');
      return respond(target, method, init);
    },
    browser(deliver, answer) {
      return (url) => {
        opened.push(url);
        const target = new URL(url);
        const challenge = target.searchParams.get('code_challenge');
        if (
          `${target.origin}${target.pathname}` !== `${FAKE_STORE_URL}/auth/v1/authorize` ||
          target.searchParams.get('provider') !== 'github' ||
          target.searchParams.get('code_challenge_method') !== 's256' ||
          challenge === null
        ) {
          return Promise.reject(new Error(`Unexpected sign-in URL ${url}`));
        }
        const redirect = target.searchParams.get('redirect_to') ?? '';
        if (answer === null) return Promise.resolve();
        // The browser comes back a moment later, as the OS delivers the URL after the consent.
        setTimeout(() => {
          if (answer !== undefined) {
            deliver(`${redirect}?${answer}`);
            return;
          }
          const userId = fake.nextUser === '' ? randomUUID() : fake.nextUser;
          if (!profiles.has(userId)) {
            profiles.set(userId, {
              github_login: `octo-${userId.slice(0, 8)}`,
              display_name: 'Octo Cat',
              avatar_url: 'https://avatars.example/octo.png',
            });
          }
          const code = randomUUID();
          codes.set(code, { challenge, userId });
          deliver(`${redirect}?code=${code}`);
        }, 1);
        return Promise.resolve();
      };
    },
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
    isRefreshTokenValid: (token) => refreshTokens.has(token),
    liveRefreshTokens: () => refreshTokens.size,
    hold(request) {
      let release!: () => void;
      const entry = {
        prefix: request,
        released: new Promise<void>((resolve) => {
          release = () => {
            holds.splice(holds.indexOf(entry), 1);
            resolve();
          };
        }),
      };
      holds.push(entry);
      return release;
    },
  };
  return fake;
}
