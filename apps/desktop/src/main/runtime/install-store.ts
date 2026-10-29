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
 * The installed Harnesses in the local SQLite database, one row per Harness ID. It stores what it
 * is given: validating and copying the Harness Package is the installer's job. Every read goes to
 * SQLite.
 */
export interface InstallStore {
  /** Every install, in no particular order. */
  all(): InstallRow[];
  get(harnessId: string): InstallRow | undefined;
  /**
   * Records an install, replacing the Harness's row if it has one. A reinstall keeps when the
   * Harness was last launched and its last Workspace, and clears `available_version`.
   */
  put(install: NewInstall): void;
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
  const selectAll = db.prepare('SELECT * FROM installs');
  const selectOne = db.prepare('SELECT * FROM installs WHERE harness_id = ?');
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
       available_version = NULL`,
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
    put(install) {
      upsert.run(
        install.harnessId,
        install.version,
        JSON.stringify(install.manifest),
        install.installPath,
        install.dataDir,
        install.installedAt,
        JSON.stringify(install.consentedPermissions),
        install.source,
      );
    },
    markLaunched(harnessId, at) {
      updateLaunched.run(at, harnessId);
    },
    setLastWorkspace(harnessId, path) {
      updateWorkspace.run(path, harnessId);
    },
  };
}
