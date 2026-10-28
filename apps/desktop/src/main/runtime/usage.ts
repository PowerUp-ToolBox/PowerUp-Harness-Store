import { writeFile } from 'node:fs/promises';
import type {
  IpcResult,
  UsageDimension,
  UsageExported,
  UsageFilter,
  UsageQuery,
  UsageRow,
} from '../../shared/ipc.js';
import { isHarnessIdInput } from './bindings.js';
import { fail, ok } from './ipc-result.js';
import type { UsageRecordStore } from './usage-records.js';

/** The Usage page's calls (P0-11.1): aggregation, CSV export and clearing, all on this machine. */
export interface UsageService {
  query(query: UsageQuery): readonly UsageRow[];
  export(filter: UsageFilter): Promise<IpcResult<UsageExported | null>>;
  clear(): void;
}

export interface UsageServiceOptions {
  readonly store: Pick<UsageRecordStore, 'aggregate' | 'clear'>;
  /**
   * Opens the OS save dialog with this file name and resolves the chosen path, or null when the
   * User cancels.
   */
  readonly pickSaveFile: (defaultName: string) => Promise<string | null>;
  /** Writes the CSV file. Default: `fs.writeFile`. */
  readonly writeFile?: (path: string, data: string) => Promise<void>;
  /** The clock of the default file name's date. Default: the system clock. */
  readonly now?: () => Date;
  readonly logError?: (message: string, error: unknown) => void;
}

/** The export's grain: the finest the page shows, Harness then Provider and model, then day. */
const EXPORT_GROUP_BY: readonly UsageDimension[] = ['harness', 'model', 'day'];

/** The CSV's columns, in order (spec P0-11). */
export const USAGE_CSV_COLUMNS = [
  'harness_id',
  'provider',
  'model',
  'day',
  'requests',
  'errors',
  'prompt_tokens',
  'completion_tokens',
  'unknown_usage_count',
  'last_used_at',
] as const;

export function createUsageService(options: UsageServiceOptions): UsageService {
  const { store } = options;
  const write =
    options.writeFile ??
    ((path: string, data: string) => writeFile(path, data, { encoding: 'utf8' }));
  const now = options.now ?? (() => new Date());
  return {
    query: (query) => store.aggregate(query, 'recent'),
    async export(filter) {
      const rows = store.aggregate({ ...filter, groupBy: EXPORT_GROUP_BY }, 'columns');
      const path = await options.pickSaveFile(`harness-store-usage-${localDate(now())}.csv`);
      if (path === null) return ok(null);
      try {
        await write(path, usageCsv(rows));
      } catch (error) {
        options.logError?.(`Could not write the usage export to ${path}`, error);
        return fail('internal_error');
      }
      return ok({ path });
    },
    clear: () => {
      store.clear();
    },
  };
}

/** Without the database: nothing to count, export or clear. */
export function createUsageStub(): UsageService {
  return {
    query: () => [],
    export: () => Promise.resolve(fail('not_implemented', { method: 'usage.export' })),
    clear: () => undefined,
  };
}

/**
 * The rows as CSV (RFC 4180): UTF-8 without a BOM, CRLF line ends, a header row, every cell that
 * holds a comma, quote or line break quoted. A cell that starts with `=`, `+`, `-` or `@` gets a
 * leading `'`, so a spreadsheet never runs a Harness ID or model name as a formula.
 */
export function usageCsv(rows: readonly UsageRow[]): string {
  const lines = [
    USAGE_CSV_COLUMNS.join(','),
    ...rows.map((row) =>
      [
        row.harnessId ?? '',
        row.provider ?? '',
        row.model ?? '',
        row.day ?? '',
        String(row.requests),
        String(row.errors),
        String(row.promptTokens),
        String(row.completionTokens),
        String(row.unknownCount),
        row.lastUsedAt ?? '',
      ]
        .map(csvCell)
        .join(','),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** `YYYY-MM-DD` of `date` in the local timezone. */
function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const DIMENSIONS: readonly UsageDimension[] = ['harness', 'provider', 'model', 'day'];

/** An ISO-8601 instant with a time and a zone, as `Date.toISOString` writes one. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * `{ from, to, harnessId?, providerId? }`, nothing else: each bound an ISO-8601 instant or null,
 * returned as `toISOString` writes it (the records' own format, so SQL compares them as text), and
 * each filter a non-empty ID.
 */
export function parseUsageFilter(input: unknown): UsageFilter | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const { from, to, harnessId, providerId, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  const start = parseInstant(from);
  const end = parseInstant(to);
  if (start === undefined || end === undefined) return null;
  if (harnessId !== undefined && !isHarnessIdInput(harnessId)) return null;
  if (providerId !== undefined && !isProviderIdInput(providerId)) return null;
  return {
    from: start,
    to: end,
    ...(harnessId === undefined ? {} : { harnessId }),
    ...(providerId === undefined ? {} : { providerId }),
  };
}

/** A {@link UsageFilter} plus `groupBy`: distinct dimensions of the four, in any order. */
export function parseUsageQuery(input: unknown): UsageQuery | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const { groupBy, ...filterInput } = input as Record<string, unknown>;
  const filter = parseUsageFilter(filterInput);
  if (filter === null || !Array.isArray(groupBy)) return null;
  const dimensions = groupBy as unknown[];
  if (!dimensions.every((item) => DIMENSIONS.includes(item as UsageDimension))) return null;
  if (new Set(dimensions).size !== dimensions.length) return null;
  return { ...filter, groupBy: dimensions as UsageDimension[] };
}

/** The instant as `toISOString` writes it, null for null, undefined when it is neither. */
function parseInstant(input: unknown): string | null | undefined {
  if (input === null) return null;
  if (typeof input !== 'string' || !INSTANT.test(input)) return undefined;
  const time = Date.parse(input);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** A Provider id as Usage Records hold it: `ollama`, `openai-compatible:vllm`. */
function isProviderIdInput(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 256;
}
