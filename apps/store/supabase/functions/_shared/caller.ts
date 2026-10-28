/**
 * Who calls a Store Edge Function: the signed-in Publisher behind an `Authorization: Bearer
 * <session JWT>` header, found with Auth's `getUser` and their `profiles` row (docs/tech/api.md,
 * "Errors of the Edge Functions"). The functions pass in the two lookups, made with their service
 * role client, so this stays plain TypeScript with relative imports only (see storage-paths.ts).
 */
import { bearerToken } from './http.ts';
import { isBadToken } from './publish.ts';

/** A signed-in Publisher. */
export interface SignedInUser {
  id: string;
  /** The GitHub login, the publisher segment of their Harness IDs. */
  login: string;
  /** `profiles.is_admin`: a Store administrator. */
  isAdmin: boolean;
}

/** The lookups behind {@link signedInUser}, shaped as supabase-js answers them. */
export interface CallerLookups {
  /** Auth's `getUser(token)`. */
  getUser(token: string): PromiseLike<{
    data: { user: { id: string } | null };
    error: { name?: string; status?: number; code?: string } | null;
  }>;
  /** The user's `profiles` row (`github_login, is_admin`), or null. */
  profile(userId: string): PromiseLike<{
    data: { github_login: string | null; is_admin: boolean } | null;
    error: unknown;
  }>;
}

/**
 * The signed-in Publisher, or undefined for no token, a token Auth refuses, or a user with no
 * profile (no GitHub login): all `401 unauthenticated`. Throws when Auth or the database cannot
 * answer, so an outage is a `500` and never ends the caller's session.
 */
export async function signedInUser(
  authorization: string | null,
  lookups: CallerLookups,
): Promise<SignedInUser | undefined> {
  const token = bearerToken(authorization);
  if (token === undefined) return undefined;
  const { data, error } = await lookups.getUser(token);
  if (error !== null) {
    if (isBadToken(error)) return undefined;
    throw error as Error;
  }
  if (data.user === null) return undefined;
  const profile = await lookups.profile(data.user.id);
  if (profile.error !== null) throw profile.error as Error;
  const login = profile.data?.github_login;
  return login ? { id: data.user.id, login, isAdmin: profile.data?.is_admin === true } : undefined;
}
