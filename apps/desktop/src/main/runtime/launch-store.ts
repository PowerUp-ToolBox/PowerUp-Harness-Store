import type { DatabaseSync } from 'node:sqlite';

/** A launch as it begins: written when its Gateway Token is issued. */
export interface LaunchBegun {
  readonly launchId: string;
  readonly harnessId: string;
  readonly version: string;
  /** ISO-8601 UTC. */
  readonly startedAt: string;
}

/** How a launch ended: once its process has ended (or was given up on) and its token is revoked. */
export interface LaunchEnded {
  /** ISO-8601 UTC. */
  readonly endedAt: string;
  /** The exit code (128 + the signal number after a signal); null when it is not known. */
  readonly exitCode: number | null;
  /** ISO-8601 UTC. */
  readonly tokenRevokedAt: string;
}

/**
 * The `launches` table (data-model.md): one row per launch that got a Gateway Token, for
 * debugging and to correlate Usage Records with a launch. A launch that failed before its token
 * was issued (unsupported platform, a cancelled Workspace) has no row.
 */
export interface LaunchStore {
  begin(launch: LaunchBegun): void;
  end(launchId: string, ended: LaunchEnded): void;
  /**
   * Closes every launch left open, which only a crash of the app leaves (its processes are gone,
   * and the tokens lived in its memory): `ended_at` and `token_revoked_at` become `at`, the exit
   * code stays unknown. Returns how many it closed.
   */
  closeOpen(at: string): number;
}

/**
 * The store over `db`. Its statements are prepared here, so a database without the table fails at
 * startup rather than on the first launch.
 */
export function createLaunchStore(db: DatabaseSync): LaunchStore {
  const insert = db.prepare(
    'INSERT INTO launches (launch_id, harness_id, version, started_at) VALUES (?, ?, ?, ?)',
  );
  const update = db.prepare(
    `UPDATE launches SET ended_at = ?, exit_code = ?, token_revoked_at = ?
     WHERE launch_id = ? AND ended_at IS NULL`,
  );
  const closeAll = db.prepare(
    'UPDATE launches SET ended_at = ?, token_revoked_at = ? WHERE ended_at IS NULL',
  );
  return {
    begin(launch) {
      insert.run(launch.launchId, launch.harnessId, launch.version, launch.startedAt);
    },
    end(launchId, ended) {
      update.run(ended.endedAt, ended.exitCode, ended.tokenRevokedAt, launchId);
    },
    closeOpen(at) {
      return Number(closeAll.run(at, at).changes);
    },
  };
}
