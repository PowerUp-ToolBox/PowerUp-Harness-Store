import type { DatabaseSync } from 'node:sqlite';
import type { UsageRecord } from '@harness-store/gateway';

/** Where the Model Gateway's Usage Records are kept: the `usage_records` table. */
export interface UsageRecordStore {
  insert(record: UsageRecord): void;
}

export function createUsageRecordStore(db: DatabaseSync): UsageRecordStore {
  const insert = db.prepare(
    `INSERT INTO usage_records (
       timestamp, harness_id, harness_version, slot, provider, model,
       prompt_tokens, completion_tokens, cached_prompt_tokens, duration_ms, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    insert(record) {
      insert.run(
        record.timestamp,
        record.harnessId,
        record.harnessVersion,
        record.slot,
        record.provider,
        record.model,
        record.promptTokens,
        record.completionTokens,
        record.cachedPromptTokens ?? null,
        record.durationMs,
        record.status,
      );
    },
  };
}
