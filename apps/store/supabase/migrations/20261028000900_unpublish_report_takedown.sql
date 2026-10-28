-- The database half of the remaining write paths (P0-07.6): `unpublish` (a Publisher withdraws a
-- Harness Version), `report` (anyone flags a Harness) and `admin/takedown` (a Store administrator
-- removes a Harness Version or a whole Harness), plus what ties them together: the takedown note a
-- Publisher can read on their own versions, and the audit log of takedowns. As in publish_version,
-- the errors these functions raise carry the API error code as their message and the HTTP status
-- in their SQLSTATE (PT<status>), which the Edge Functions map to their response.

-- The takedown note: the administrator's `note`, copied onto every version a takedown changes. It
-- is only ever on a taken-down version, which no public read returns; the owning Publisher reads
-- it through the policy below.
alter table public.harness_versions
  add column takedown_note text check (char_length(takedown_note) <= 2000),
  add constraint harness_versions_takedown_note_only_taken_down
    check (takedown_note is null or status = 'taken_down');

-- The immutability trigger of the catalogue migration, with takedown_note added to what may
-- change. Status still only moves forward: published -> unpublished, any status -> taken_down.
create or replace function public.harness_versions_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- semver_key is generated from `version`, which is compared, and is not yet recomputed in NEW
  -- when a BEFORE trigger runs.
  mutable constant text[] :=
    array['status', 'download_count', 'unpublished_at', 'takedown_note', 'semver_key'];
begin
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'Harness Version % is immutable: only status, download_count, unpublished_at and takedown_note may change', old.version
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

-- The audit log of administrator actions: one row per `admin/takedown` call, whatever it changed
-- (taking down something already taken down is still logged). Featured changes are made in
-- Supabase Studio and not logged in P0.
create type public.admin_action as enum ('takedown_harness', 'takedown_version');

create table public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  -- The administrator. Null once their account is deleted, so the log outlives it.
  admin_id uuid references public.profiles (id) on delete set null,
  action public.admin_action not null,
  -- A Harness is never deleted by the Store (no function does); deleting one by hand takes its
  -- log along.
  target_harness_id uuid not null references public.harnesses (id) on delete cascade,
  -- Set for `takedown_version` only.
  target_version_id uuid references public.harness_versions (id) on delete cascade,
  note text not null check (char_length(note) between 1 and 2000),
  created_at timestamptz not null default now(),
  check ((action = 'takedown_version') = (target_version_id is not null))
);

create index admin_actions_target_idx on public.admin_actions (target_harness_id, created_at);

-- No access for anon or authenticated at all, and no policy: the `admin` function writes it with
-- the service role, administrators read it in Studio.
alter table public.admin_actions enable row level security;

revoke all on table public.admin_actions from anon, authenticated;

grant all on table public.admin_actions to service_role;

-- A Publisher reads their own Harness Versions in any status, with the takedown note: what "My
-- Harnesses" (P0-08) and the Library's takedown warning (P0-12) show. Only versions: a policy that
-- let the owner read their own `harnesses` rows in any status would put their Unpublished-only and
-- taken-down Harnesses into the home rows, search and Publisher page whenever those are read with
-- their session (they repeat no visibility filter, by design).
--
-- Which Harnesses are the caller's is a SECURITY DEFINER function: a policy's subquery on
-- `harnesses` would run under that table's row-level security, which hides exactly the
-- Unpublished-only and taken-down Harnesses whose versions the owner must see. It lives in the
-- `private` schema, which PostgREST does not expose, so it is no RPC.
create schema if not exists private;

revoke all on schema private from public;

grant usage on schema private to authenticated, service_role;

-- The ids of the calling Publisher's Harnesses (none for anon).
create function private.own_harness_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select h.id from public.harnesses h where h.publisher_id = (select auth.uid());
$$;

revoke execute on function private.own_harness_ids() from public, anon;

grant execute on function private.own_harness_ids() to authenticated, service_role;

create policy "Publishers read their own versions"
  on public.harness_versions for select
  to authenticated
  using (harness_id in (select private.own_harness_ids()));

-- Unpublish (`unpublish` function): the Publisher `publisher` withdraws `target_version` of their
-- Harness `harness` (a Harness ID). Errors, in this order: no such Harness (PT404 not_found),
-- another Publisher's Harness (PT403 forbidden), no such version (PT404 not_found), a taken-down
-- Harness or version (PT409 harness_taken_down). A version already Unpublished is left as it is
-- and is a success (idempotent). The status trigger then moves the Harness's latest_version to the
-- previous published version, or to null: the Harness stays `active` but is hidden.
--
-- The version row is locked before the statuses are checked, so a concurrent Takedown (which
-- updates the versions before the Harness) is either seen or waits; the status trigger locks the
-- Harness row second, as every writer does (see refresh_harness).
--
-- Answers `{ harness_id, version, status: 'unpublished', latest_version }`.
create function public.unpublish_version(publisher uuid, harness text, target_version text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  target public.harnesses%rowtype;
  withdrawn public.harness_versions%rowtype;
begin
  select * into target from public.harnesses h where h.harness_id = unpublish_version.harness;
  if not found then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;
  if target.publisher_id is distinct from unpublish_version.publisher then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;

  select * into withdrawn
  from public.harness_versions v
  where v.harness_id = target.id and v.version = unpublish_version.target_version
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;
  if withdrawn.status = 'taken_down'
    or (select h.status from public.harnesses h where h.id = target.id) = 'taken_down' then
    raise exception using errcode = 'PT409', message = 'harness_taken_down';
  end if;

  if withdrawn.status = 'published' then
    update public.harness_versions v
    set status = 'unpublished', unpublished_at = now()
    where v.id = withdrawn.id;
  end if;

  return jsonb_build_object(
    'harness_id', target.harness_id,
    'version', withdrawn.version,
    'status', 'unpublished',
    'latest_version', (select h.latest_version from public.harnesses h where h.id = target.id)
  );
end;
$$;

-- Report (`report` function): files a Report on the Harness `harness` (a Harness ID, any status),
-- and on its version `target_version` when given. `reporter` is the signed-in Publisher who sent
-- it, or null. Errors: no such Harness or version (PT404 not_found), and the fifth Report within
-- an hour from the same install (`client_info.install_id`) already stored (PT429 rate_limited).
-- That table check is serialised per install id, so it is exact; a Report without an install id
-- is limited by the function's per-IP counter alone. Answers the new Report's id.
create function public.submit_report(
  harness text,
  target_version text,
  reason public.report_reason,
  details text,
  client_info jsonb,
  reporter uuid
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  target uuid;
  version_id uuid;
  install_id text := submit_report.client_info ->> 'install_id';
  report_id uuid;
begin
  select h.id into target from public.harnesses h where h.harness_id = submit_report.harness;
  if not found then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;
  if submit_report.target_version is not null then
    select v.id into version_id
    from public.harness_versions v
    where v.harness_id = target and v.version = submit_report.target_version;
    if not found then
      raise exception using errcode = 'PT404', message = 'not_found';
    end if;
  end if;

  if install_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('report:' || install_id, 0));
    if (
      select count(*)
      from public.reports r
      where r.client_info ->> 'install_id' = install_id
        and r.created_at > clock_timestamp() - interval '1 hour'
    ) >= 5 then
      raise exception using errcode = 'PT429', message = 'rate_limited';
    end if;
  end if;

  insert into public.reports (harness_id, version_id, reporter_id, reason, details, client_info, created_at)
  values (
    target,
    version_id,
    submit_report.reporter,
    submit_report.reason,
    submit_report.details,
    submit_report.client_info,
    clock_timestamp()
  )
  returning id into report_id;
  return report_id;
end;
$$;

-- Takedown (`admin` function, `admin/takedown`): the administrator `admin_id` takes down the
-- Harness `harness` (a Harness ID), or only its version `target_version` when given. Errors: the
-- caller is not an administrator (PT403 forbidden; the function checks first, this is the backstop
-- inside the transaction), no such Harness or version (PT404 not_found).
--
-- Without a version: every version not yet taken down becomes `taken_down` with the note, then the
-- Harness (versions first, Harness second, as every writer locks them). With a version: that
-- version only; the status trigger moves latest_version back to the previous published version.
-- Either way every open Report on the Harness is resolved with the note, and one admin_actions row
-- is written, also when nothing was left to take down.
--
-- Answers `{ harness_id, version, status: 'taken_down', resolved_reports }`.
create function public.take_down(admin_id uuid, harness text, target_version text, note text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  target public.harnesses%rowtype;
  version_id uuid;
  resolved integer;
begin
  if not exists (
    select 1 from public.profiles p where p.id = take_down.admin_id and p.is_admin
  ) then
    raise exception using errcode = 'PT403', message = 'forbidden';
  end if;

  select * into target from public.harnesses h where h.harness_id = take_down.harness;
  if not found then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;

  if take_down.target_version is null then
    update public.harness_versions v
    set status = 'taken_down', takedown_note = take_down.note
    where v.harness_id = target.id and v.status <> 'taken_down';
    update public.harnesses h set status = 'taken_down' where h.id = target.id;
  else
    select v.id into version_id
    from public.harness_versions v
    where v.harness_id = target.id and v.version = take_down.target_version
    for update;
    if not found then
      raise exception using errcode = 'PT404', message = 'not_found';
    end if;
    update public.harness_versions v
    set status = 'taken_down', takedown_note = take_down.note
    where v.id = version_id and v.status <> 'taken_down';
  end if;

  update public.reports r
  set status = 'resolved', resolution_note = take_down.note, resolved_at = now()
  where r.harness_id = target.id and r.status = 'open';
  get diagnostics resolved = row_count;

  insert into public.admin_actions (admin_id, action, target_harness_id, target_version_id, note)
  values (
    take_down.admin_id,
    case when version_id is null then 'takedown_harness' else 'takedown_version' end::public.admin_action,
    target.id,
    version_id,
    take_down.note
  );

  return jsonb_build_object(
    'harness_id', target.harness_id,
    'version', take_down.target_version,
    'status', 'taken_down',
    'resolved_reports', resolved
  );
end;
$$;

-- Not RPCs: only the `unpublish`, `report` and `admin` functions call them, with the service role.
revoke execute on function
  public.harness_versions_before_update(),
  public.unpublish_version(uuid, text, text),
  public.submit_report(text, text, public.report_reason, text, jsonb, uuid),
  public.take_down(uuid, text, text, text)
from public, anon, authenticated;

grant execute on function
  public.unpublish_version(uuid, text, text),
  public.submit_report(text, text, public.report_reason, text, jsonb, uuid),
  public.take_down(uuid, text, text, text)
to service_role;
