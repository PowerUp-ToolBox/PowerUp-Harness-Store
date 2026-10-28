import type { DatabaseSync } from 'node:sqlite';
import type { DeclaredPermissions, Manifest } from '@harness-store/manifest';
import type { InstallSource } from '../../shared/ipc.js';

/** One row of the `installs` table, camel-cased, with its JSON columns parsed. */
export interface InstallRow {
  readonly harnessId: string;
  readonly version: string;
  readonly manifest: Manifest;
  readonly installPath: string;
  readonly dataDir: string;
  readonly installedAt: string;
  readonly lastLaunchedAt: string | null;
  readonly lastWorkspace: string | null;
  readonly consentedPermissions: DeclaredPermissions;
  readonly availableVersion: string | null;
  readonly source: InstallSource;
}

/** What an install writes; the launch history and the update check keep their own columns. */
export type NewInstall = Omit<InstallRow, 'lastLaunchedAt' | 'lastWorkspace' | 'availableVersion'>;

/**
 * Where a Store install of a Harness is (data-model.md, `installs.state`): `installed`, or one of
 * the transient states of an install under way. A failed or cancelled install deletes its row.
 */
export type InstallState =
  'downloading' | 'verifying' | 'awaiting_consent' | 'unpacking' | 'installed';

/** The states of a Store install under way. */
export type TransientState = Exclude<InstallState, 'installed'>;

/**
 * The installed Harnesses in the local SQLite database, one row per Harness ID. It stores what it
 * is given: validating and copying the Harness Package is the installer's job. Every read goes to
 * SQLite.
 *
 * A Store install under way has a row too, in a transient state, so a crash leaves a record the
 * next start cleans up. Only {@link stateOf} and the transient methods see such a row: `all` and
 * `get` answer installed Harnesses only, so the Library, the Supervisor, the Model Gateway and
 * the Models page never see a half-installed one.
 */
export interface InstallStore {
  /** Every installed Harness, in no particular order. */
  all(): InstallRow[];
  /** The installed Harness; undefined when it is not installed (or only being installed). */
  get(harnessId: string): InstallRow | undefined;
  /** The state of the Harness's row; undefined when it has none. */
  stateOf(harnessId: string): InstallState | undefined;
  /**
   * Records an install, replacing the Harness's row if it has one (a transient one included) and
   * making it `installed`. A reinstall keeps when the Harness was last launched and its last
   * Workspace, and clears `available_version`.
   */
  put(install: NewInstall): void;
  /**
   * Writes the row of a Store install that has begun, `downloading`. Throws when the Harness
   * already has a row: the installer checks first.
   */
  begin(install: NewInstall): void;
  /** Moves a Store install under way to `state`; an installed row is never changed. */
  setState(harnessId: string, state: TransientState): void;
  /** Deletes the Harness's row when it is transient; an installed row is kept. */
  deleteTransient(harnessId: string): void;
  /** Deletes every transient row (at startup, for installs the app stopped in); how many. */
  deleteAllTransient(): number;
  /** Records when the Harness was last launched (ISO-8601 UTC); nothing for one not installed. */
  markLaunched(harnessId: string, at: string): void;
  /** Records the Workspace the Harness was last launched with; nothing for one not installed. */
  setLastWorkspace(harnessId: string, path: string): void;
}

interface SqlInstallRow {
  harness_id: string;
  version: string;
  manifest: string;
  install_path: string;
  data_dir: string;
  installed_at: string;
  last_launched_at: string | null;
  last_workspace: string | null;
  consented_permissions: string;
  available_version: string | null;
  source: InstallSource;
  state: InstallState;
}

// The JSON columns hold what put() wrote: a validated Manifest and its Declared Permissions.
function fromSql(row: SqlInstallRow): InstallRow {
  return {
    harnessId: row.harness_id,
    version: row.version,
    manifest: JSON.parse(row.manifest) as Manifest,
    installPath: row.install_path,
    dataDir: row.data_dir,
    installedAt: row.installed_at,
    lastLaunchedAt: row.last_launched_at,
    lastWorkspace: row.last_workspace,
    consentedPermissions: JSON.parse(row.consented_permissions) as DeclaredPermissions,
    availableVersion: row.available_version,
    source: row.source,
  };
}

/**
 * The store over `db`. Its statements are prepared here, so a database without the table fails at
 * startup rather than on the first use.
 */
export function createInstallStore(db: DatabaseSync): InstallStore {
  const selectAll = db.prepare("SELECT * FROM installs WHERE state = 'installed'");
  const selectOne = db.prepare(
    "SELECT * FROM installs WHERE harness_id = ? AND state = 'installed'",
  );
  const selectState = db.prepare('SELECT state FROM installs WHERE harness_id = ?');
  const insertTransient = db.prepare(
    `INSERT INTO installs (
       harness_id, version, manifest, install_path, data_dir, installed_at,
       consented_permissions, source, state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'downloading')`,
  );
  const updateState = db.prepare(
    "UPDATE installs SET state = ? WHERE harness_id = ? AND state <> 'installed'",
  );
  const deleteOne = db.prepare(
    "DELETE FROM installs WHERE harness_id = ? AND state <> 'installed'",
  );
  const deleteAll = db.prepare("DELETE FROM installs WHERE state <> 'installed'");
  const upsert = db.prepare(
    `INSERT INTO installs (
       harness_id, version, manifest, install_path, data_dir, installed_at,
       consented_permissions, source
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (harness_id) DO UPDATE SET
       version = excluded.version, manifest = excluded.manifest,
       install_path = excluded.install_path, data_dir = excluded.data_dir,
       installed_at = excluded.installed_at,
       consented_permissions = excluded.consented_permissions, source = excluded.source,
       available_version = NULL, state = 'installed'`,
  );
  const updateLaunched = db.prepare(
    'UPDATE installs SET last_launched_at = ? WHERE harness_id = ?',
  );
  const updateWorkspace = db.prepare('UPDATE installs SET last_workspace = ? WHERE harness_id = ?');
  return {
    all: () => (selectAll.all() as unknown as SqlInstallRow[]).map(fromSql),
    get(harnessId) {
      const row = selectOne.get(harnessId) as SqlInstallRow | undefined;
      return row === undefined ? undefined : fromSql(row);
    },
    stateOf(harnessId) {
      const row = selectState.get(harnessId) as { state: InstallState } | undefined;
      return row?.state;
    },
    put(install) {
      upsert.run(...columnsOf(install));
    },
    begin(install) {
      insertTransient.run(...columnsOf(install));
    },
    setState(harnessId, state) {
      updateState.run(state, harnessId);
    },
    deleteTransient(harnessId) {
      deleteOne.run(harnessId);
    },
    deleteAllTransient() {
      return Number(deleteAll.run().changes);
    },
    markLaunched(harnessId, at) {
      updateLaunched.run(at, harnessId);
    },
    setLastWorkspace(harnessId, path) {
      updateWorkspace.run(path, harnessId);
    },
  };
}

/** The columns an install writes, in the order of the INSERT statements. */
function columnsOf(
  install: NewInstall,
): [string, string, string, string, string, string, string, string] {
  return [
    install.harnessId,
    install.version,
    JSON.stringify(install.manifest),
    install.installPath,
    install.dataDir,
    install.installedAt,
    JSON.stringify(install.consentedPermissions),
    install.source,
  ];
}
