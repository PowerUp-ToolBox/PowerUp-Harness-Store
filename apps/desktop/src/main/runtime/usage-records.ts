import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { UsageRecord } from '@harness-store/gateway';
import type { UsageDimension, UsageQuery, UsageRow } from '../../shared/ipc.js';

/** Where the Model Gateway's Usage Records are kept: the `usage_records` table. */
export interface UsageRecordStore {
  insert(record: UsageRecord): void;
  /**
   * Sums the records of `query` in SQL (see `usage.query`). `recent` orders the groups by their
   * latest record, newest first; `columns` by the grouped columns, ascending (the CSV export).
   */
  aggregate(query: UsageQuery, order: 'recent' | 'columns'): UsageRow[];
  /** Deletes every Usage Record. */
  clear(): void;
}

/**
 * The SQL of each dimension: its output column and the expression it groups by. Only these
 * expressions ever reach the SQL text; the values compared go in as parameters. `day` is the
 * record's date in the local timezone of this process, which is the User's.
 */
const DIMENSIONS: Readonly<Record<UsageDimension, readonly (readonly [string, string])[]>> = {
  harness: [['harnessId', 'harness_id']],
  provider: [['provider', 'provider']],
  model: [
    ['provider', 'provider'],
    ['model', 'model'],
  ],
  day: [['day', "date(timestamp, 'localtime')"]],
};

/** An `ok` record with both token counts: the only kind whose counts are summed. */
const KNOWN = "status = 'ok' AND prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL";

export function createUsageRecordStore(db: DatabaseSync): UsageRecordStore {
  const insert = db.prepare(
    `INSERT INTO usage_records (
       timestamp, harness_id, harness_version, slot, provider, model,
       prompt_tokens, completion_tokens, cached_prompt_tokens, duration_ms, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteAll = db.prepare('DELETE FROM usage_records');
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
    aggregate(query, order) {
      // `model` brings `provider` along, so a dimension may name a column twice.
      const columns = new Map<string, string>();
      for (const dimension of query.groupBy) {
        for (const [name, expression] of DIMENSIONS[dimension]) columns.set(name, expression);
      }
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (query.from !== null) {
        where.push('timestamp >= ?');
        params.push(query.from);
      }
      if (query.to !== null) {
        where.push('timestamp < ?');
        params.push(query.to);
      }
      if (query.harnessId !== undefined) {
        where.push('harness_id = ?');
        params.push(query.harnessId);
      }
      if (query.providerId !== undefined) {
        where.push('provider = ?');
        params.push(query.providerId);
      }
      const grouped = [...columns];
      const groupColumns = grouped.map(([name]) => `"${name}"`);
      const sql = [
        'SELECT',
        [
          ...grouped.map(([name, expression]) => `${expression} AS "${name}"`),
          'COUNT(*) AS requests',
          "COALESCE(SUM(status <> 'ok'), 0) AS errors",
          `COALESCE(SUM(CASE WHEN ${KNOWN} THEN prompt_tokens END), 0) AS promptTokens`,
          `COALESCE(SUM(CASE WHEN ${KNOWN} THEN completion_tokens END), 0) AS completionTokens`,
          "COALESCE(SUM(status = 'ok' AND (prompt_tokens IS NULL OR completion_tokens IS NULL)), 0) AS unknownCount",
          'MAX(timestamp) AS lastUsedAt',
        ].join(', '),
        'FROM usage_records',
        where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`,
        groupColumns.length === 0 ? '' : `GROUP BY ${groupColumns.join(', ')}`,
        groupColumns.length === 0
          ? ''
          : order === 'recent'
            ? `ORDER BY lastUsedAt DESC, ${groupColumns.join(', ')}`
            : `ORDER BY ${groupColumns.join(', ')}`,
      ].join(' ');
      const rows = db.prepare(sql).all(...params) as Record<string, string | number | null>[];
      const dimension = (row: (typeof rows)[number], name: keyof UsageRow) =>
        columns.has(name) ? { [name]: String(row[name]) } : {};
      return rows.map((row): UsageRow => ({
        ...dimension(row, 'harnessId'),
        ...dimension(row, 'provider'),
        ...dimension(row, 'model'),
        ...dimension(row, 'day'),
        requests: Number(row.requests),
        errors: Number(row.errors),
        promptTokens: Number(row.promptTokens),
        completionTokens: Number(row.completionTokens),
        unknownCount: Number(row.unknownCount),
        lastUsedAt: row.lastUsedAt === null ? null : String(row.lastUsedAt),
      }));
    },
    clear() {
      deleteAll.run();
    },
  };
}
