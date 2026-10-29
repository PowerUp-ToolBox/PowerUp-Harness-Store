-- The database half of the `download` Edge Function and the update check (P0-07.4): counting a
-- download without storing who made it, and `latest_versions`, which tells the desktop app for a
-- batch of installed Harnesses what their latest published version is, without any download.

-- Records one download of a published Harness Version, in one transaction: a download_events row
-- (version, platform, app version, time; never an IP address or a user), and one more download on
-- the version and on its Harness. The `download` function calls it after resolving the version and
-- signing its URL; under the row locks it checks again that the version is still published and
-- its Harness still visible, so an Unpublish or a Takedown that committed in between is a 404
-- (`not_found`, SQLSTATE PT404) and nothing is counted.
--
-- The version row is locked first and the Harness row second, as every writer does (see
-- refresh_harness). harnesses.download_count is incremented here rather than recomputed: a
-- concurrent refresh_harness either ran before (and this adds one to its sum) or waits for this
-- commit (and its sum includes it).
create function public.record_download(version_id uuid, platform text, app_version text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  target uuid;
begin
  update public.harness_versions v
  set download_count = v.download_count + 1
  where v.id = record_download.version_id and v.status = 'published'
  returning v.harness_id into target;
  if not found then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;

  update public.harnesses h
  set download_count = h.download_count + 1
  where h.id = target and h.status = 'active' and h.latest_version is not null;
  if not found then
    raise exception using errcode = 'PT404', message = 'not_found';
  end if;

  insert into public.download_events (version_id, platform, app_version)
  values (record_download.version_id, record_download.platform, record_download.app_version);
end;
$$;

-- Not an RPC: only the `download` function calls it, with the service role.
revoke execute on function public.record_download(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.record_download(uuid, text, text) to service_role;

-- The update check (api.md "Reads"): one row per requested Harness ID, in the order given, with
--   store_status    'available', 'unpublished' (no published version left), 'taken_down' or
--                   'not_found' (no such Harness);
--   latest_version  the latest published version, only when available;
--   manifest        that version's full stored Manifest (permissions, runtime, entry, changelog:
--                   what diffForReconsent compares), only when available.
-- At most 1000 IDs per call (PostgREST's max_rows).
--
-- SECURITY DEFINER: row-level security hides taken-down and Unpublished-only Harnesses, whose
-- status the desktop app must still learn. It never returns anything of a version that is not the
-- latest published one, and nothing of a Harness that is not available besides its status. No
-- version-level Takedown is reported (P0), not even one of the latest version: refresh_harness then
-- moves latest_version back to the previous published version (possibly lower than the installed
-- one) or to null ('unpublished').
create function public.latest_versions(harness_ids text[])
returns table (harness_id text, store_status text, latest_version text, manifest jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if cardinality(harness_ids) > 1000 then
    raise exception 'latest_versions takes at most 1000 Harness IDs, got %', cardinality(harness_ids)
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with requested as (
    select r.id, r.ord, h.status, h.latest_version, v.manifest
    from unnest(harness_ids) with ordinality as r(id, ord)
    left join public.harnesses h on h.harness_id = r.id
    left join public.harness_versions v
      on v.harness_id = h.id and v.version = h.latest_version and v.status = 'published'
  ),
  classified as (
    select
      requested.*,
      case
        when requested.status is null then 'not_found'
        when requested.status = 'taken_down' then 'taken_down'
        when requested.manifest is null then 'unpublished'
        else 'available'
      end as store_status
    from requested
  )
  select
    c.id,
    c.store_status,
    case when c.store_status = 'available' then c.latest_version end,
    case when c.store_status = 'available' then c.manifest end
  from classified c
  order by c.ord;
end;
$$;

-- A public RPC: the desktop app calls it with the anon key.
revoke execute on function public.latest_versions(text[]) from public;
grant execute on function public.latest_versions(text[]) to anon, authenticated, service_role;
