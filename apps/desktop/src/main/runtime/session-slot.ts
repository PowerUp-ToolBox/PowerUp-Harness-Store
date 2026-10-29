import type { DatabaseSync } from 'node:sqlite';

/**
 * The `secrets` row that holds the Store session. Connection secrets use the Connection id, which
 * is a Provider id or `openai-compatible:<slug>`, so this id never collides with one.
 */
export const STORE_SESSION_SECRET_ID = 'store:session';

/**
 * Where the encrypted Store session lives: one ciphertext, or none. It stores what it is given;
 * encrypting is the caller's job, so plaintext tokens never reach it.
 */
export interface SessionSlot {
  read(): Uint8Array | undefined;
  write(ciphertext: Uint8Array): void;
  clear(): void;
}

/** The slot in the `secrets` table of the local SQLite database, row {@link STORE_SESSION_SECRET_ID}. */
export function createSqliteSessionSlot(
  db: DatabaseSync,
  now: () => Date = () => new Date(),
): SessionSlot {
  const select = db.prepare('SELECT ciphertext FROM secrets WHERE id = ?');
  const upsert = db.prepare(
    `INSERT INTO secrets (id, ciphertext, created_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET ciphertext = excluded.ciphertext, created_at = excluded.created_at`,
  );
  const remove = db.prepare('DELETE FROM secrets WHERE id = ?');
  return {
    read() {
      const row = select.get(STORE_SESSION_SECRET_ID) as { ciphertext: Uint8Array } | undefined;
      return row?.ciphertext;
    },
    write(ciphertext) {
      upsert.run(STORE_SESSION_SECRET_ID, ciphertext, now().toISOString());
    },
    clear() {
      remove.run(STORE_SESSION_SECRET_ID);
    },
  };
}

/** A slot in memory: for a Runtime without its database, and for tests. */
export function createMemorySessionSlot(): SessionSlot {
  let ciphertext: Uint8Array | undefined;
  return {
    read: () => ciphertext,
    write(value) {
      ciphertext = value;
    },
    clear() {
      ciphertext = undefined;
    },
  };
}
