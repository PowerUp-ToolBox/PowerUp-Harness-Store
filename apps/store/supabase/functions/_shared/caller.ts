/**
 * Who calls a Store Edge Function: the signed-in Publisher behind an `Authorization: Bearer
 * <session JWT>` header, found with Auth's `getUser` and their `profiles` row (docs/tech/api.md,
 * "Errors of the Edge Functions"). The functions pass in their service role client, read through
 * the small part of supabase-js it uses, so this stays plain TypeScript with relative imports only
 * (see storage-paths.ts).
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

/** The `profiles` columns {@link signedInUser} reads. */
interface CallerProfile {
  github_login: string | null;
  is_admin: boolean;
}

/** The lookups behind {@link signedInUser}, shaped as supabase-js answers them. */
export interface CallerLookups {
  /** Auth's `getUser(token)`. */
  getUser(token: string): PromiseLike<{
    data: { user: { id: string } | null };
    error: { name?: string; status?: number; code?: string } | null;
  }>;
  /** The user's `profiles` row (`github_login, is_admin`), or null. */
  profile(userId: string): PromiseLike<{ data: CallerProfile | null; error: unknown }>;
}

/** The query {@link callerLookups} makes on `profiles`, as supabase-js's builder answers it. */
interface ProfilesTable {
  select(columns: 'github_login, is_admin'): {
    eq(
      column: 'id',
      value: string,
    ): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> };
  };
}

/**
 * The part of a supabase-js client {@link callerLookups} uses, declared structurally so this
 * module needs no import of supabase-js. Comparing supabase-js's query builder types with a
 * structural type is too deep for tsc (TS2589), so `from` is read as {@link ProfilesTable};
 * test/moderation.test.ts runs the lookups on a real client.
 */
export interface CallerClient {
  auth: { getUser(token: string): ReturnType<CallerLookups['getUser']> };
  from(relation: 'profiles'): object;
}

/**
 * The lookups of a service role client: Auth's `getUser` and the user's `profiles` row. The one
 * definition every function that authenticates its caller uses.
 */
export function callerLookups(client: CallerClient): CallerLookups {
  return {
    getUser: (token) => client.auth.getUser(token),
    profile: (id) =>
      (client.from('profiles') as ProfilesTable)
        .select('github_login, is_admin')
        .eq('id', id)
        .maybeSingle()
        .then(({ data, error }) => ({ data: data as CallerProfile | null, error })),
  };
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
