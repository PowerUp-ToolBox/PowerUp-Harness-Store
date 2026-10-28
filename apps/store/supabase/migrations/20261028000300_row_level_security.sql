-- Who may read and write the catalogue. Every write to a catalogue table happens with the service
-- role inside an Edge Function, which bypasses row-level security; anon and authenticated (the
-- desktop app with the anon key or a Publisher's session) can only read what is public and edit
-- their own profile. Two layers say so: table and column privileges (an attempt fails with
-- "permission denied") and row-level security with no write policy (no row would match even if a
-- privilege were granted by mistake).

alter table public.profiles enable row level security;
alter table public.harnesses enable row level security;
alter table public.harness_versions enable row level security;
alter table public.reports enable row level security;
alter table public.download_events enable row level security;

-- Supabase's default privileges grant everything on new tables to anon and authenticated; start
-- from nothing and grant only what is listed below.
revoke all on table
  public.profiles,
  public.harnesses,
  public.harness_versions,
  public.reports,
  public.download_events
from anon, authenticated;

grant all on table
  public.profiles,
  public.harnesses,
  public.harness_versions,
  public.reports,
  public.download_events
to service_role;

-- profiles: the public columns are readable by anyone (is_admin is not). A Publisher may edit
-- their own display name, bio and avatar, and no other column (not is_admin, not github_login).
grant select (id, github_login, display_name, avatar_url, bio, created_at)
  on public.profiles to anon, authenticated;
grant update (display_name, bio, avatar_url) on public.profiles to authenticated;

create policy "Profiles are public"
  on public.profiles for select
  to anon, authenticated
  using (true);

create policy "Publishers edit their own profile"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- harnesses: visible when active and with a published version. This one rule hides taken-down
-- and Unpublished-only Harnesses from Featured, home, search, detail and Publisher pages without
-- any query repeating the filter.
grant select on public.harnesses to anon, authenticated;

create policy "Visible Harnesses are public"
  on public.harnesses for select
  to anon, authenticated
  using (status = 'active' and latest_version is not null);

-- harness_versions: published versions of active Harnesses.
grant select on public.harness_versions to anon, authenticated;

create policy "Published versions of active Harnesses are public"
  on public.harness_versions for select
  to anon, authenticated
  using (
    status = 'published'
    and exists (
      select 1
      from public.harnesses h
      where h.id = harness_versions.harness_id and h.status = 'active'
    )
  );

-- reports and download_events: no access for anon or authenticated at all; the `report` and
-- `download` functions write them with the service role, administrators read them in Studio.
