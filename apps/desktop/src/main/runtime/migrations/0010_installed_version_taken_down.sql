-- Whether the last update check found the installed version itself taken down (P0-12.2
-- follow-up), from `latest_versions`' `installed_version_status`, while `store_status` keeps
-- saying what the Store does with the Harness: a Takedown of only that version leaves the Harness
-- `available`, and its newer published version stays offered as the update. The install then
-- shows the same red warning and once-per-Takedown launch confirmation as a taken-down Harness
-- (`takedown_acknowledged`, which a change of this column sets back to 0 too). 1 when taken down;
-- back to 0 when a check finds the version otherwise, and when an install puts another version
-- in the row (an update, a reinstall) or a local install replaces it.
ALTER TABLE installs ADD COLUMN installed_version_taken_down INTEGER NOT NULL DEFAULT 0
  CHECK (installed_version_taken_down IN (0, 1));
