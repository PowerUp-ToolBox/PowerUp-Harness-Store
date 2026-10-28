-- App settings: one row per key, the value JSON-encoded. Keys are snake_case (data-model.md):
-- `locale` and the main-only `window_state` now; `onboarding_done` and `store_base_url` follow.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One Usage Record per request the Model Gateway forwarded to a Provider (gateway-protocol.md §7),
-- written by the Gateway's onUsage. Token counts are the Provider's own: NULL when it reported none.
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  harness_version TEXT NOT NULL,
  slot TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_prompt_tokens INTEGER,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'provider_error', 'timeout', 'aborted'))
);

CREATE INDEX usage_records_harness_id_timestamp ON usage_records (harness_id, timestamp);
