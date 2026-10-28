-- Encrypted secrets: one row per Connection that has a key, `id` = the Connection id. The
-- ciphertext comes from Electron safeStorage (OS keychain-backed); plaintext keys are never stored.
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- Provider Connections: `id` is the Provider id, or `openai-compatible:<slug>` for a named custom
-- endpoint. `base_url` is NULL for the Provider's default. `secret_ref` is the `secrets` row of the
-- key (NULL without one), and `key_hint` its last 4 characters ('' for a short key), so the masked
-- key is shown without decrypting. `last_tested_at` is ISO-8601 UTC.
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT,
  secret_ref TEXT REFERENCES secrets (id),
  key_hint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_tested_at TEXT,
  last_test_ok INTEGER CHECK (last_test_ok IN (0, 1)),
  last_test_error TEXT
);

-- Slot Bindings: scope `global` (the Default Models) or `harness:<id>` (Model Overrides).
-- `provider_id` holds the Connection id. There is no foreign key: removing a Connection deletes
-- the rows that use it in the same transaction.
CREATE TABLE slot_bindings (
  scope TEXT NOT NULL,
  slot TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  PRIMARY KEY (scope, slot)
);

CREATE INDEX slot_bindings_provider_id ON slot_bindings (provider_id);
