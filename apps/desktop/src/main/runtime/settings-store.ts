import type { DatabaseSync } from 'node:sqlite';

/**
 * The keys of the SQLite `settings` table the Runtime uses (snake_case, data-model.md). Later
 * tickets add `onboarding_done` and `store_base_url`.
 */
export type SettingKey = 'locale' | 'window_state';

/** Key/value storage for app settings; values are anything JSON can hold. */
export interface SettingsStore {
  /** The stored value; `undefined` when the key is absent or its value is not valid JSON. */
  read(key: SettingKey): unknown;
  /** Stores `value`; `undefined` removes the key. */
  write(key: SettingKey, value: unknown): void;
}

/** Settings kept in the `settings` table, one row per key with a JSON-encoded value. */
export function createSqliteSettingsStore(db: DatabaseSync): SettingsStore {
  const select = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  const remove = db.prepare('DELETE FROM settings WHERE key = ?');
  return {
    read(key) {
      const row = select.get(key) as { value: string } | undefined;
      if (row === undefined) return undefined;
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        return undefined;
      }
    },
    write(key, value) {
      if (value === undefined) remove.run(key);
      else upsert.run(key, JSON.stringify(value));
    },
  };
}

/**
 * Settings that last only as long as the process: what the Runtime uses when the database could
 * not be opened, so the startup error screen still renders in the OS language.
 */
export function createMemorySettingsStore(): SettingsStore {
  const values = new Map<SettingKey, unknown>();
  return {
    read: (key) => values.get(key),
    write(key, value) {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}
