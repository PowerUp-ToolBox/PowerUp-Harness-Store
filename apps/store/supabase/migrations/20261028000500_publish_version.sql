-- The database half of the `publish` Edge Function (P0-07.3). The function validates the Harness
-- Package with validatePackage and uploads its objects; publish_version then writes every row of
-- the publish in one transaction, under a lock, so concurrent publishes cannot pass the rate limit
-- or the version check together. Errors it raises carry the API error code as their message and
-- the HTTP status in their SQLSTATE (PT<status>), which the function maps to its response.

-- How many more Harness Versions `publisher` may publish now: 20 per rolling 24 hours, counted
-- from harness_versions.published_at whatever the version's status (an Unpublished or taken-down
-- version was still published).
create function public.publishes_remaining(publisher uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select greatest(0, 20 - count(*))::integer
  from public.harness_versions v
  join public.harnesses h on h.id = v.harness_id
  where h.publisher_id = publisher and v.published_at > now() - interval '24 hours';
$$;

-- Inserts the Harness (on its first version) and the Harness Version of a validated Manifest. The
-- triggers then refresh the Harness's listing fields (refresh_harness).
--
-- `known_versions` is how many versions of this Harness (any status) the Edge Function passed to
-- validatePackage as `publishedVersions`. Under the lock, a different count means another publish
-- of this Harness committed in between, so validatePackage's "greater than every published
-- version" check may no longer hold: version_not_greater, and the caller may simply retry.
--
-- The lock is per Publisher, so it also serialises the rate-limit count across their Harnesses.
create function public.publish_version(
  publisher uuid,
  manifest jsonb,
  readme text,
  package_path text,
  package_sha256 text,
  package_size bigint,
  screenshot_paths text[],
  known_versions integer
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  publisher_login text;
  harness_slug text := split_part(publish_version.manifest ->> 'id', '/', 2);
  harness public.harnesses%rowtype;
begin
  select p.github_login into publisher_login from public.profiles p where p.id = publisher;
  -- validatePackage already checked this; a backstop, as the semver trigger is for the version.
  if publisher_login is null
    or split_part(publish_version.manifest ->> 'id', '/', 1) is distinct from publisher_login then
    raise exception using errcode = 'PT403', message = 'publisher_mismatch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('publish:' || publisher::text, 0));

  if public.publishes_remaining(publisher) = 0 then
    raise exception using errcode = 'PT429', message = 'rate_limited';
  end if;

  select * into harness
  from public.harnesses h
  where h.publisher_id = publisher and h.slug = harness_slug
  for update;

  if found then
    if harness.status = 'taken_down' then
      raise exception using errcode = 'PT409', message = 'harness_taken_down';
    end if;
    if (select count(*) from public.harness_versions v where v.harness_id = harness.id)
      <> known_versions then
      raise exception using errcode = 'PT409', message = 'version_not_greater';
    end if;
  else
    if known_versions <> 0 then
      raise exception using errcode = 'PT409', message = 'version_not_greater';
    end if;
    -- The listing fields are placeholders until the version's insert trigger refreshes them.
    insert into public.harnesses (publisher_id, slug, name, summary)
    values (
      publisher,
      harness_slug,
      publish_version.manifest ->> 'name',
      publish_version.manifest ->> 'summary'
    )
    returning * into harness;
  end if;

  insert into public.harness_versions (
    harness_id,
    version,
    manifest,
    readme,
    changelog,
    platforms,
    permissions,
    package_path,
    package_sha256,
    package_size,
    screenshot_paths
  )
  values (
    harness.id,
    publish_version.manifest ->> 'version',
    publish_version.manifest,
    publish_version.readme,
    publish_version.manifest ->> 'changelog',
    array(select jsonb_array_elements_text(publish_version.manifest -> 'platforms')),
    publish_version.manifest -> 'permissions',
    publish_version.package_path,
    publish_version.package_sha256,
    publish_version.package_size,
    publish_version.screenshot_paths
  );
end;
$$;

-- Not RPCs for anon or a Publisher: only the `publish` function calls them, with the service role.
revoke execute on function
  public.publishes_remaining(uuid),
  public.publish_version(uuid, jsonb, text, text, text, bigint, text[], integer)
from public, anon, authenticated;

grant execute on function
  public.publishes_remaining(uuid),
  public.publish_version(uuid, jsonb, text, text, text, bigint, text[], integer)
to service_role;
