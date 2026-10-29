-- The update check learns a Takedown of the installed version (P0-12.2 follow-up). Before, it
-- reported the Harness's status alone, so a User who installed exactly the version an
-- administrator took down was never warned while the Harness stayed active.
--
-- `latest_versions` takes, optionally, the installed version of each requested Harness and
-- answers that version's status too. Called with `harness_ids` alone it answers as before, with
-- the new column null, so every existing caller keeps working. PostgREST picks a function by its
-- argument names, and the new argument has a default, so the old function is dropped and
-- replaced rather than overloaded (two candidates for `{ harness_ids }` would be ambiguous).
drop function public.latest_versions(text[]);

-- The update check (api.md "Reads"): one row per requested Harness ID, in the order given, with
--   store_status              'available', 'unpublished' (no published version left),
--                             'taken_down' or 'not_found' (no such Harness);
--   latest_version            the latest published version, only when available;
--   manifest                  that version's full stored Manifest (permissions, runtime, entry,
--                             changelog: what diffForReconsent compares), only when available;
--   installed_version_status  the status ('published', 'unpublished' or 'taken_down') of the
--                             version at the same position of `installed_versions`; null when
--                             none was given there, or the Harness or that version is unknown.
-- `installed_versions`, when given, has as many entries as `harness_ids`, aligned by position
-- (null entries allowed); a different length is refused (SQLSTATE 22023). At most 1000 IDs per
-- call (PostgREST's max_rows).
--
-- SECURITY DEFINER: row-level security hides taken-down and Unpublished-only Harnesses, and
-- Unpublished and taken-down versions, whose status the desktop app must still learn. It never
-- returns anything of a version besides the latest published one's version and Manifest and the
-- asked version's status, nothing of a Harness that is not available besides its status, and
-- never a takedown note. A version-level Takedown shows only in `installed_version_status`:
-- refresh_harness moves latest_version back to the previous published version (possibly lower
-- than the installed one) or to null ('unpublished').
create function public.latest_versions(
  harness_ids text[],
  installed_versions text[] default null
)
returns table (
  harness_id text,
  store_status text,
  latest_version text,
  manifest jsonb,
  installed_version_status text
)
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
  if installed_versions is not null
    and cardinality(installed_versions) is distinct from cardinality(harness_ids) then
    raise exception 'latest_versions takes as many installed versions as Harness IDs, got % and %',
      cardinality(installed_versions), cardinality(harness_ids)
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with requested as (
    select r.id, r.ord, h.status, h.latest_version, v.manifest, iv.status as installed_status
    from unnest(harness_ids, installed_versions) with ordinality as r(id, installed, ord)
    left join public.harnesses h on h.harness_id = r.id
    left join public.harness_versions v
      on v.harness_id = h.id and v.version = h.latest_version and v.status = 'published'
    left join public.harness_versions iv on iv.harness_id = h.id and iv.version = r.installed
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
    case when c.store_status = 'available' then c.manifest end,
    c.installed_status::text
  from classified c
  order by c.ord;
end;
$$;

-- A public RPC: the desktop app calls it with the anon key.
revoke execute on function public.latest_versions(text[], text[]) from public;
grant execute on function public.latest_versions(text[], text[])
to anon, authenticated, service_role;
