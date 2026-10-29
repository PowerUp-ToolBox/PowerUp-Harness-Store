-- Business rules that hold whoever writes (P0-07 "Further Notes"): Publisher profiles from GitHub
-- sign-ins, the Harness ID, Harness Version immutability and the fields a Harness copies from its
-- latest published version.

-- A profile for every GitHub user. Only `provider = github` counts: app metadata is set by Auth,
-- never by the user, and email signup is off (config.toml), so nobody can choose a login through
-- signup metadata. Also runs when Auth writes the app metadata after inserting the user (the
-- admin API does), and keeps an existing profile as it is: a login renamed on GitHub keeps the
-- original login in P0, so Harness IDs stay stable.
create function public.create_github_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  login text := lower(new.raw_user_meta_data ->> 'user_name');
begin
  if new.raw_app_meta_data ->> 'provider' is distinct from 'github' or coalesce(login, '') = '' then
    return new;
  end if;
  insert into public.profiles (id, github_login, display_name, avatar_url)
  values (
    new.id,
    login,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger create_github_profile
  after insert or update of raw_app_meta_data on auth.users
  for each row execute function public.create_github_profile();

-- `harness_id` is `<publisher login>/<slug>`, recomputed on every write so it cannot be set to
-- anything else; `updated_at` is the time of the last write.
create function public.harnesses_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.harness_id := (select p.github_login from public.profiles p where p.id = new.publisher_id)
    || '/' || new.slug;
  new.updated_at := now();
  return new;
end;
$$;

create trigger harnesses_before_write
  before insert or update on public.harnesses
  for each row execute function public.harnesses_before_write();

-- Copies the latest published Harness Version (highest semver_key, then latest published_at) onto
-- its Harness: latest_version, latest_published_at, name, summary, tags, icon_path and the search
-- vector, plus the sum of the versions' download counts. With no published version left, only
-- latest_version and latest_published_at become null: the last listing fields stay, and the
-- Harness is hidden by row-level security (latest_version is null).
--
-- It locks the Harness row before reading the versions. Writers of different versions of one
-- Harness (an Unpublish and a Takedown, a download and an Unpublish) do not block each other on
-- the version rows; under READ COMMITTED, versions read before the lock would be a snapshot from
-- before the other writer committed, and the UPDATE would then write a stale latest version or
-- download count. Each statement after the lock sees that commit. Every writer locks the version
-- row first and the Harness row second, so the lock adds no deadlock.
create function public.refresh_harness(target uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  latest public.harness_versions%rowtype;
  downloads bigint;
begin
  perform 1 from public.harnesses h where h.id = target for update;

  select coalesce(sum(v.download_count), 0) into downloads
  from public.harness_versions v
  where v.harness_id = target;

  select * into latest
  from public.harness_versions v
  where v.harness_id = target and v.status = 'published'
  order by v.semver_key desc, v.published_at desc
  limit 1;

  if not found then
    update public.harnesses h
    set latest_version = null, latest_published_at = null, download_count = downloads
    where h.id = target;
    return;
  end if;

  update public.harnesses h
  set
    latest_version = latest.version,
    latest_published_at = latest.published_at,
    name = latest.manifest ->> 'name',
    summary = latest.manifest ->> 'summary',
    tags = array(select jsonb_array_elements_text(coalesce(latest.manifest -> 'tags', '[]'))),
    icon_path = h.harness_id || '/' || latest.version || '/icon.png',
    download_count = downloads,
    -- `simple`: language-neutral, so names and tags match as exact tokens in any language. The
    -- README counts with its first 50 K characters only.
    search =
      setweight(to_tsvector('simple', latest.manifest ->> 'name'), 'A')
      || setweight(
        to_tsvector('simple', array_to_string(
          array(select jsonb_array_elements_text(coalesce(latest.manifest -> 'tags', '[]'))), ' '
        )),
        'B'
      )
      || setweight(to_tsvector('simple', latest.manifest ->> 'summary'), 'C')
      || setweight(to_tsvector('simple', left(latest.readme, 51200)), 'D')
  where h.id = target;
end;
$$;

-- A published Harness Version never changes: only `status`, `download_count` and
-- `unpublished_at` may, whatever the row's status (rows are only ever inserted as published).
-- Status only moves forward: published -> unpublished, and any status -> taken_down.
create function public.harness_versions_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- semver_key is generated from `version`, which is compared, and is not yet recomputed in NEW
  -- when a BEFORE trigger runs.
  mutable constant text[] := array['status', 'download_count', 'unpublished_at', 'semver_key'];
begin
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'Harness Version % is immutable: only status, download_count and unpublished_at may change', old.version
      using errcode = 'restrict_violation';
  end if;
  if new.status is distinct from old.status
    and not (
      (old.status = 'published' and new.status = 'unpublished')
      or new.status = 'taken_down'
    ) then
    raise exception 'Harness Version % cannot go from % to %', old.version, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger harness_versions_before_update
  before update on public.harness_versions
  for each row execute function public.harness_versions_before_update();

-- A new Harness Version must not sort below an existing one of the same Harness (a backstop for
-- the publish function, which checks full semver with validatePackage), then its Harness is
-- refreshed.
create function public.harness_versions_after_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.harness_versions v
    where v.harness_id = new.harness_id and v.id <> new.id and v.semver_key > new.semver_key
  ) then
    raise exception 'Harness Version % is not greater than every earlier version', new.version
      using errcode = 'check_violation';
  end if;
  perform public.refresh_harness(new.harness_id);
  return null;
end;
$$;

create trigger harness_versions_after_insert
  after insert on public.harness_versions
  for each row execute function public.harness_versions_after_insert();

-- Unpublish and Takedown change which version is the latest.
create function public.harness_versions_after_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.refresh_harness(new.harness_id);
  return null;
end;
$$;

create trigger harness_versions_after_status_change
  after update of status on public.harness_versions
  for each row
  when (old.status is distinct from new.status)
  execute function public.harness_versions_after_status_change();

-- None of these is an API: PostgREST would otherwise expose every function in `public` as an RPC
-- to anon and authenticated (Supabase grants EXECUTE to both by default, Postgres to PUBLIC).
-- Trigger functions need no EXECUTE grant to fire. The service role, which does every catalogue
-- write, needs semver_key (the generated column) and refresh_harness (called by the triggers).
revoke execute on function
  public.semver_key(text),
  public.create_github_profile(),
  public.harnesses_before_write(),
  public.refresh_harness(uuid),
  public.harness_versions_before_update(),
  public.harness_versions_after_insert(),
  public.harness_versions_after_status_change()
from public, anon, authenticated;

grant execute on function public.semver_key(text), public.refresh_harness(uuid) to service_role;
