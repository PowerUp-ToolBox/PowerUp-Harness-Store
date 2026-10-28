-- Installed Harnesses: one row per Harness ID, so only one version of a Harness is installed at a
-- time. `manifest` is the validated Manifest as JSON, `consented_permissions` the Declared
-- Permissions the User agreed to at install (JSON). `install_path` is the absolute path of
-- harnesses/<publisher>/<slug>/<version>/ and `data_dir` of data/<publisher>/<slug>/ (the Data
-- Directory). `source` says where the Harness Package came from: the Store, or a local folder
-- (Install this folder locally), which never gets Store updates. Timestamps are ISO-8601 UTC.
CREATE TABLE installs (
  harness_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  install_path TEXT NOT NULL,
  data_dir TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  last_launched_at TEXT,
  last_workspace TEXT,
  consented_permissions TEXT NOT NULL,
  available_version TEXT,
  source TEXT NOT NULL CHECK (source IN ('store', 'local'))
);

-- One row per launch of a Harness, for debugging and to correlate Usage Records: written when its
-- Gateway Token is issued, closed when the process has ended and the token is revoked. A launch
-- left open by a crash of the app is closed at the next start.
CREATE TABLE launches (
  launch_id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  token_revoked_at TEXT
);

CREATE INDEX launches_harness_id_started_at ON launches (harness_id, started_at);
