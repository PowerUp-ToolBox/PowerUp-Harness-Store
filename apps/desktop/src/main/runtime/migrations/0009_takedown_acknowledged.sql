-- Whether the User confirmed "Launch anyway" for a Store install the update check found taken
-- down (P0-12.2): the launch confirmation shows once per Takedown, across restarts. 1 once
-- confirmed; back to 0 whenever an update check changes `store_status` (a Harness reinstated and
-- taken down again asks again) and when a local install replaces the row.
ALTER TABLE installs ADD COLUMN takedown_acknowledged INTEGER NOT NULL DEFAULT 0
  CHECK (takedown_acknowledged IN (0, 1));
