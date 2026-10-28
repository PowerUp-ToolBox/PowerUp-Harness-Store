-- Store search (P0-07.5): the `search_harnesses` RPC behind the desktop app's search box. The home
-- rows (Featured, Most downloaded, New) and the Publisher page are plain PostgREST reads of
-- `harnesses` (api.md "Reads"), served by the indexes of the catalogue migration: the unique
-- constraint on featured_rank, harnesses_download_count_idx and harnesses_latest_published_at_idx.

-- One search result: what a list card needs. A composite type rather than RETURNS TABLE, whose
-- output columns are parameters too and could not share the name `tags` with the argument.
create type public.harness_search_result as (
  harness_id text,
  -- The publisher segment of harness_id: the Publisher's login.
  publisher_login text,
  name text,
  summary text,
  -- Relative to the harness-assets bucket; the client prefixes the Store's public URL
  -- (`<base>/storage/v1/object/public/harness-assets/<icon_path>`).
  icon_path text,
  tags text[],
  -- The latest published version's platforms.
  platforms text[],
  download_count bigint,
  latest_version text,
  latest_published_at timestamptz
);

-- Full-text search over harnesses.search (refresh_harness: `simple` configuration, so a word in
-- any language is one exact token; name A, tags B, summary C, README D), most relevant first:
--   q         websearch_to_tsquery syntax ("quoted phrase", or, -not). Null, blank or without any
--             word (only punctuation) means no text filter, ordered by downloads.
--   tags      the Harness has all of them; null or empty means no tag filter.
--   platform  the latest version declares it; null means any. An unknown one matches nothing.
--   limit     1 to 60, 24 when null; out-of-range values are clamped, never refused.
--   offset    0 or more; a negative one is 0.
-- Ordered by ts_rank (when there is a text query), then download_count, then the latest version's
-- published_at (newest first), then harness_id so pages never overlap. There is no total count:
-- a page shorter than `limit` is the last one.
--
-- The `simple` parser does not segment Chinese: a run of CJK characters is one token, so a whole
-- Chinese name or word matches and a part of one does not (P0).
--
-- SECURITY INVOKER: row-level security decides which Harnesses exist here, exactly as for every
-- other read (active, with a published version), and nothing in this function repeats that rule.
-- The desktop app searches with the anon key.
create function public.search_harnesses(
  q text default null,
  tags text[] default null,
  platform text default null,
  "limit" int default null,
  "offset" int default null
)
returns setof public.harness_search_result
language sql
stable
security invoker
set search_path = ''
as $$
  with query as (
    select case when numnode(t.query) > 0 then t.query end as tsq
    from (
      select case
        when coalesce(btrim(search_harnesses.q), '') <> ''
          then websearch_to_tsquery('simple', search_harnesses.q)
      end as query
    ) t
  )
  select
    h.harness_id,
    split_part(h.harness_id, '/', 1),
    h.name,
    h.summary,
    h.icon_path,
    h.tags,
    v.platforms,
    h.download_count,
    h.latest_version,
    h.latest_published_at
  from public.harnesses h
  join public.harness_versions v on v.harness_id = h.id and v.version = h.latest_version
  cross join query
  where (query.tsq is null or h.search @@ query.tsq)
    and (search_harnesses.tags is null or h.tags @> search_harnesses.tags)
    and (search_harnesses.platform is null or v.platforms @> array[search_harnesses.platform])
  order by
    case when query.tsq is null then 0 else ts_rank(h.search, query.tsq) end desc,
    h.download_count desc,
    h.latest_published_at desc,
    h.harness_id
  limit least(greatest(coalesce(search_harnesses."limit", 24), 1), 60)
  offset greatest(coalesce(search_harnesses."offset", 0), 0);
$$;

-- A public RPC: the desktop app calls it with the anon key.
revoke execute on function public.search_harnesses(text, text[], text, int, int) from public;
grant execute on function public.search_harnesses(text, text[], text, int, int)
  to anon, authenticated, service_role;
