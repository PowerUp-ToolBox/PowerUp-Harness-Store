import { DatabaseSync } from 'node:sqlite';
import m0001 from './migrations/0001_settings_and_usage_records.sql?raw';
import m0002 from './migrations/0002_connections_and_slot_bindings.sql?raw';

/** The local SQLite file's name in the app data root (data-model.md, install layout). */
export const DATABASE_FILE_NAME = 'harness-store.sqlite';

/**
 * The schema migrations, oldest first: plain SQL files in ./migrations, bundled as strings so the
 * built main process does not need them on disk. A new migration is a new file appended here;
 * a released one is never edited.
 */
export const MIGRATIONS: readonly string[] = [m0001, m0002];

/**
 * Opens (creating it if needed) the Runtime's SQLite database at `path` and brings its schema up
 * to date. It uses Node's built-in `node:sqlite`, which Electron's Node ships, so there is no
 * native module to rebuild. Throws when the file cannot be opened, a migration fails, or the
 * database comes from a newer app version.
 */
export function openDatabase(
  path: string,
  migrations: readonly string[] = MIGRATIONS,
): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Applies the migrations the database has not seen yet. `PRAGMA user_version` counts the ones
 * applied; each runs in its own transaction together with the bump of that count, so a failing
 * migration leaves the database as the previous one left it, and a relaunch never applies one
 * twice.
 */
export function migrate(db: DatabaseSync, migrations: readonly string[]): void {
  const applied = schemaVersion(db);
  if (applied > migrations.length) {
    throw new Error(
      `The database has schema version ${String(applied)}, newer than this app's ${String(migrations.length)}: it was opened by a newer version of Harness Store.`,
    );
  }
  migrations.slice(applied).forEach((sql, index) => {
    const version = applied + index + 1;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${String(version)}`);
      db.exec('COMMIT');
    } catch (error) {
      // SQLite ends the transaction itself on some errors (a full disk, an I/O error, an
      // ON CONFLICT ROLLBACK constraint); a ROLLBACK then would throw and hide the real cause.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new Error(`Database migration ${String(version)} failed.`, { cause: error });
    }
  });
}

/**
 * Runs `work` in one transaction: every write it makes is committed together, or, when it throws,
 * none is. Not re-entrant: `work` must not start another transaction.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // As in migrate(): SQLite may have ended the transaction itself already.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/** How many migrations the database has applied. */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}
