-- What the last update check (P0-10.2, the Store's `latest_versions`) said about a Store install:
-- `store_status` is `available`, `unpublished` (`not_found`, a Harness the Store no longer has,
-- included) or `taken_down`; null until the first check, and always for a local install, which
-- is never checked. `available_manifest` is the full Manifest (JSON) of the version in
-- `available_version`, kept so the update prompt can show its changelog and what changed without
-- the Store. Both are set only for an update this machine can install: an `available` Harness
-- whose latest version is greater (semver) than the installed one and declares this platform;
-- otherwise both are null.
ALTER TABLE installs ADD COLUMN store_status TEXT
  CHECK (store_status IN ('available', 'unpublished', 'taken_down'));
ALTER TABLE installs ADD COLUMN available_manifest TEXT;
