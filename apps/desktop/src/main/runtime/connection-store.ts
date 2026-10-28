import type { DatabaseSync } from 'node:sqlite';
import type { GlobalBinding } from '../../shared/ipc.js';
import { transaction } from './database.js';

/** One row of the `connections` table, camel-cased. */
export interface ConnectionRow {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  /** NULL in SQLite: the Provider's default base URL. */
  readonly baseUrl: string | null;
  /** The `secrets` row holding the key; null when the Connection has none. */
  readonly secretRef: string | null;
  readonly keyHint: string | null;
  readonly enabled: boolean;
  readonly lastTestedAt: string | null;
  readonly lastTestOk: boolean | null;
  readonly lastTestError: string | null;
}

/**
 * The Connections, their encrypted secrets and the Slot Bindings that use them, in the local
 * SQLite database. It stores what it is given; checking input and encrypting keys is the
 * Connections service's job. Every read goes to SQLite, so a change is seen by the next read.
 */
export interface ConnectionStore {
  /** Every Connection, in no particular order. */
  all(): ConnectionRow[];
  get(id: string): ConnectionRow | undefined;
  /** The ciphertext of a Connection's key, by its `secretRef`. */
  secret(secretRef: string): Uint8Array | undefined;
  /**
   * Inserts or replaces the Connection, and, when `ciphertext` is given, stores it as the
   * Connection's secret (`secrets.id` = the Connection id), in one transaction.
   */
  save(row: ConnectionRow, ciphertext?: Uint8Array): void;
  /**
   * Deletes the Connection, its secret and every Slot Binding of any scope whose Connection it
   * is, in one transaction.
   */
  remove(id: string): void;
  /** The global Slot Bindings: `default` first, then by Slot name. */
  globalBindings(): GlobalBinding[];
}

interface SqlConnectionRow {
  id: string;
  provider_id: string;
  display_name: string;
  base_url: string | null;
  secret_ref: string | null;
  key_hint: string | null;
  enabled: number;
  last_tested_at: string | null;
  last_test_ok: number | null;
  last_test_error: string | null;
}

function fromSql(row: SqlConnectionRow): ConnectionRow {
  return {
    id: row.id,
    providerId: row.provider_id,
    displayName: row.display_name,
    baseUrl: row.base_url,
    secretRef: row.secret_ref,
    keyHint: row.key_hint,
    enabled: row.enabled === 1,
    lastTestedAt: row.last_tested_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    lastTestError: row.last_test_error,
  };
}

/**
 * The store over `db`. Its statements are prepared here, so a database without these tables fails
 * at startup rather than on the first use.
 */
export function createConnectionStore(
  db: DatabaseSync,
  now: () => Date = () => new Date(),
): ConnectionStore {
  const selectAll = db.prepare('SELECT * FROM connections');
  const selectOne = db.prepare('SELECT * FROM connections WHERE id = ?');
  const selectSecret = db.prepare('SELECT ciphertext FROM secrets WHERE id = ?');
  const upsertSecret = db.prepare(
    `INSERT INTO secrets (id, ciphertext, created_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET ciphertext = excluded.ciphertext, created_at = excluded.created_at`,
  );
  const upsertConnection = db.prepare(
    `INSERT INTO connections (
       id, provider_id, display_name, base_url, secret_ref, key_hint, enabled,
       last_tested_at, last_test_ok, last_test_error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       provider_id = excluded.provider_id, display_name = excluded.display_name,
       base_url = excluded.base_url, secret_ref = excluded.secret_ref,
       key_hint = excluded.key_hint, enabled = excluded.enabled,
       last_tested_at = excluded.last_tested_at, last_test_ok = excluded.last_test_ok,
       last_test_error = excluded.last_test_error`,
  );
  const deleteBindings = db.prepare('DELETE FROM slot_bindings WHERE provider_id = ?');
  const deleteConnection = db.prepare('DELETE FROM connections WHERE id = ?');
  const deleteSecret = db.prepare('DELETE FROM secrets WHERE id = ?');
  const selectGlobalBindings = db.prepare(
    `SELECT slot, provider_id, model FROM slot_bindings WHERE scope = 'global'
     ORDER BY slot <> 'default', slot`,
  );

  return {
    all: () => (selectAll.all() as unknown as SqlConnectionRow[]).map(fromSql),
    get(id) {
      const row = selectOne.get(id) as SqlConnectionRow | undefined;
      return row === undefined ? undefined : fromSql(row);
    },
    secret(secretRef) {
      const row = selectSecret.get(secretRef) as { ciphertext: Uint8Array } | undefined;
      return row?.ciphertext;
    },
    save(row, ciphertext) {
      transaction(db, () => {
        if (ciphertext !== undefined) upsertSecret.run(row.id, ciphertext, now().toISOString());
        upsertConnection.run(
          row.id,
          row.providerId,
          row.displayName,
          row.baseUrl,
          row.secretRef,
          row.keyHint,
          row.enabled ? 1 : 0,
          row.lastTestedAt,
          row.lastTestOk === null ? null : row.lastTestOk ? 1 : 0,
          row.lastTestError,
        );
      });
    },
    remove(id) {
      transaction(db, () => {
        const row = selectOne.get(id) as SqlConnectionRow | undefined;
        deleteBindings.run(id);
        deleteConnection.run(id);
        // After the Connection, which references it.
        if (row !== undefined && row.secret_ref !== null) deleteSecret.run(row.secret_ref);
      });
    },
    globalBindings: () =>
      (selectGlobalBindings.all() as { slot: string; provider_id: string; model: string }[]).map(
        (row) => ({ slot: row.slot, connectionId: row.provider_id, model: row.model }),
      ),
  };
}
