/**
 * Gateway Tokens: what a Harness process presents as `Authorization: Bearer <token>`, and the
 * pluggable verifier that turns one back into the claims it was issued with. The in-memory
 * default holds per-launch random tokens; the P2 cloud Gateway can swap in a JWT verifier
 * without touching routing.
 */
import { createHash } from 'node:crypto';

/** What a Gateway Token stands for. Fixed when the token is issued. */
export interface GatewayTokenClaims {
  /** The Harness ID of the launched Harness. */
  harnessId: string;
  /** Its Harness Version. */
  harnessVersion: string;
  /** The launch the token belongs to; one launch may hold several tokens. */
  launchId: string;
  /** When the Gateway issued the token, epoch milliseconds. */
  issuedAt: number;
  /** The app's UI locale at launch (BCP 47, e.g. `en`, `zh-CN`), reported by `/v1/harness/context`. */
  locale: string;
  /** Absolute path of the Workspace chosen at launch, when the Harness has one. */
  workspace?: string;
}

/**
 * Issues, checks and revokes Gateway Tokens. `verify` runs on every request, so it must be fast
 * and must not leak through timing which tokens exist.
 */
export interface TokenVerifier {
  /** Issues a new token for `claims` and returns it. */
  issue(claims: GatewayTokenClaims): string;
  /** The claims of a live token; `null` for an unknown, malformed or revoked one. */
  verify(token: string): GatewayTokenClaims | null;
  /** Revokes one token. Unknown tokens are ignored. */
  revoke(token: string): void;
  /** Revokes every token issued for `launchId`. */
  revokeLaunch(launchId: string): void;
}

/**
 * SHA-256 of a token, hex. Tokens are only ever stored and looked up by this hash: a lookup
 * keyed by the raw token would compare the attacker's guess against real tokens in
 * data-dependent time, while a lookup by hash reveals nothing usable about any token.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 32 random bytes (256 bits) from Web Crypto, base64url without padding. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * The default verifier: random tokens in a table that lives as long as the process. Tokens have
 * no time-based expiry; they live until revoked.
 */
export function createInMemoryTokenVerifier(): TokenVerifier {
  const byHash = new Map<string, Readonly<GatewayTokenClaims>>();
  return {
    issue(claims) {
      const token = generateToken();
      byHash.set(hashToken(token), Object.freeze({ ...claims }));
      return token;
    },
    verify(token) {
      return byHash.get(hashToken(token)) ?? null;
    },
    revoke(token) {
      byHash.delete(hashToken(token));
    },
    revokeLaunch(launchId) {
      for (const [hash, claims] of byHash) {
        if (claims.launchId === launchId) byHash.delete(hash);
      }
    },
  };
}
