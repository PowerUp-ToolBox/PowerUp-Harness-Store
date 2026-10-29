-- The Store catalogue: Publishers (profiles), Harnesses, Harness Versions, Reports and download
-- events, as described in docs/tech/data-model.md §1. Migrations are the only way this schema
-- changes. Who may read or write what is in the row-level security migration that follows.

create type public.harness_status as enum ('active', 'taken_down');

create type public.harness_version_status as enum ('published', 'unpublished', 'taken_down');

create type public.report_reason as enum (
  'malware',
  'bypasses_gateway',
  'broken',
  'inappropriate',
  'spam',
  'other'
);

create type public.report_status as enum ('open', 'resolved', 'dismissed');

-- The ordering key of a Harness Version: [major, minor, patch, release flag], where the flag is 0
-- for a pre-release and 1 for a release, so 1.1.0-beta.1 sorts below 1.1.0. Pre-releases of the
-- same MAJOR.MINOR.PATCH share a key: every publish must be greater than all earlier versions
-- (validatePackage's `publishedVersions` option compares full semver), so publish order is semver
-- order and `published_at` breaks those ties. Raises on anything that is not strict semver.
create function public.semver_key(version text)
returns bigint[]
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  parts text[] := regexp_match(
    version,
    '^(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})\.(0|[1-9][0-9]{0,15})(-[0-9A-Za-z.-]+)?$'
  );
begin
  if parts is null then
    raise exception 'Not a strict semver version: %', version using errcode = 'check_violation';
  end if;
  return array[
    parts[1]::bigint,
    parts[2]::bigint,
    parts[3]::bigint,
    case when parts[4] is null then 1 else 0 end
  ];
end;
$$;

-- One row per Publisher, created by a trigger on auth.users (see the triggers migration).
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  -- Lower-cased GitHub login: the publisher segment of every Harness ID of this Publisher. Kept
  -- as first seen when the login later changes on GitHub, so Harness IDs stay stable (P0).
  github_login text not null unique check (github_login <> '' and github_login = lower(github_login)),
  display_name text,
  avatar_url text,
  bio text check (char_length(bio) <= 500),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- One row per Harness (the thing with a Harness ID). Everything but `publisher_id`, `slug`,
-- `status` and `featured_rank` is maintained by triggers: `harness_id` from the Publisher's login,
-- and the listing fields from the latest published Harness Version (refresh_harness).
create table public.harnesses (
  id uuid primary key default gen_random_uuid(),
  publisher_id uuid not null references public.profiles (id) on delete restrict,
  slug text not null,
  -- `publisher/slug`. Set by a trigger: a generated column cannot read profiles.
  harness_id text not null unique,
  name text not null,
  summary text not null,
  tags text[] not null default '{}',
  -- Path of the latest published version's icon in the harness-assets bucket.
  icon_path text,
  -- Highest published version by semver_key; null when no version is published.
  latest_version text,
  latest_published_at timestamptz,
  status public.harness_status not null default 'active',
  -- Non-null = Featured, shown in ascending order. Set by an administrator in Supabase Studio.
  featured_rank int unique,
  download_count bigint not null default 0 check (download_count >= 0),
  -- Full-text search over the latest published version. Set by a trigger, not generated: it
  -- reads harness_versions (the README), which a generated column cannot.
  search tsvector not null default ''::tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (publisher_id, slug)
);

create index harnesses_tags_idx on public.harnesses using gin (tags);
create index harnesses_search_idx on public.harnesses using gin (search);
create index harnesses_download_count_idx on public.harnesses (download_count desc);
create index harnesses_latest_published_at_idx on public.harnesses (latest_published_at desc);

-- One row per Harness Version. Immutable except for `status`, `download_count` and
-- `unpublished_at` (enforced by a trigger).
create table public.harness_versions (
  id uuid primary key default gen_random_uuid(),
  harness_id uuid not null references public.harnesses (id) on delete cascade,
  version text not null,
  semver_key bigint[] generated always as (public.semver_key(version)) stored,
  -- The full Manifest that validatePackage accepted.
  manifest jsonb not null,
  -- README.md of the package, at most 1 MiB (cut at a UTF-8 character boundary).
  readme text not null default '' check (octet_length(readme) <= 1048576),
  changelog text,
  platforms text[] not null,
  permissions jsonb not null,
  -- Paths relative to their bucket: `<publisher>/<slug>/<version>.zip` in harness-packages,
  -- `<publisher>/<slug>/<version>/screenshots/<n>.<ext>` in harness-assets.
  package_path text not null,
  package_sha256 text not null check (package_sha256 ~ '^[0-9a-f]{64}$'),
  package_size bigint not null check (package_size > 0),
  screenshot_paths text[] not null default '{}',
  status public.harness_version_status not null default 'published',
  download_count bigint not null default 0 check (download_count >= 0),
  published_at timestamptz not null default now(),
  unpublished_at timestamptz,
  unique (harness_id, version)
);

create index harness_versions_order_idx
  on public.harness_versions (harness_id, semver_key desc, published_at desc);
create index harness_versions_published_at_idx on public.harness_versions (published_at);

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  harness_id uuid not null references public.harnesses (id) on delete cascade,
  version_id uuid references public.harness_versions (id) on delete cascade,
  -- Null for an anonymous Report.
  reporter_id uuid references public.profiles (id) on delete set null,
  reason public.report_reason not null,
  details text not null default '' check (char_length(details) <= 2000),
  -- What the desktop app sent: install id, app version, platform. Never an IP address.
  client_info jsonb not null default '{}',
  status public.report_status not null default 'open',
  resolution_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index reports_harness_status_idx on public.reports (harness_id, status);
create index reports_install_id_idx on public.reports ((client_info ->> 'install_id'), created_at);

-- Append-only, for later analytics. No IP address and no user identity.
create table public.download_events (
  id bigint generated always as identity primary key,
  version_id uuid not null references public.harness_versions (id) on delete cascade,
  platform text not null,
  app_version text not null,
  created_at timestamptz not null default now()
);

create index download_events_version_idx on public.download_events (version_id, created_at);
