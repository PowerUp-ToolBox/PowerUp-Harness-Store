-- Chinese search (P0-09.2): the `simple` parser behind harnesses.search keeps a run of CJK
-- characters as one token, so `写作` never matched the Harness named `写作助手`. When the query
-- holds a CJK character (Han, kana or Hangul), a Harness whose name or summary contains the whole
-- query as a substring matches too, case-insensitively, with `%`, `_` and `\` taken literally.
-- Those matches come first, the name before the summary; the existing order (ts_rank, then
-- download_count, latest_published_at, harness_id) decides within each group and for the rest.
-- A query without a CJK character searches and orders exactly as before.
--
-- No index serves the substring match: P0's catalogue is small, and row-level security already
-- narrows the rows to active Harnesses with a published version. Everything else is as in
-- 20261028000800_search_harnesses.sql, which documents the arguments.
create or replace function public.search_harnesses(
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
    select
      case when numnode(t.query) > 0 then t.query end as tsq,
      case
        when t.text ~ '[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]'
          then '%' || replace(replace(replace(t.text, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      end as pattern
    from (
      select
        case
          when coalesce(btrim(search_harnesses.q), '') <> ''
            then websearch_to_tsquery('simple', search_harnesses.q)
        end as query,
        btrim(search_harnesses.q) as text
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
  where (
      (query.tsq is null and query.pattern is null)
      or h.search @@ query.tsq
      or h.name ilike query.pattern
      or h.summary ilike query.pattern
    )
    and (search_harnesses.tags is null or h.tags @> search_harnesses.tags)
    and (search_harnesses.platform is null or v.platforms @> array[search_harnesses.platform])
  order by
    case
      when h.name ilike query.pattern then 0
      when h.summary ilike query.pattern then 1
      else 2
    end,
    case when query.tsq is null then 0 else ts_rank(h.search, query.tsq) end desc,
    h.download_count desc,
    h.latest_published_at desc,
    h.harness_id
  limit least(greatest(coalesce(search_harnesses."limit", 24), 1), 60)
  offset greatest(coalesce(search_harnesses."offset", 0), 0);
$$;
