import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UsageRecord } from '@harness-store/gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  migrate,
  openDatabase,
  schemaVersion,
} from '../../src/main/runtime/database.js';
import { createUsageRecordStore } from '../../src/main/runtime/usage-records.js';

let dir: string;
let path: string;
let opened: DatabaseSync[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-store-db-'));
  path = join(dir, 'harness-store.sqlite');
  opened = [];
});
afterEach(() => {
  for (const db of opened) if (db.isOpen) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function open(migrations?: readonly string[]): DatabaseSync {
  const db = openDatabase(path, migrations);
  opened.push(db);
  return db;
}

/** The schema as SQLite records it: every table and index with its SQL. */
function schema(db: DatabaseSync): { type: string; name: string; sql: string }[] {
  return db
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { type: string; name: string; sql: string }[];
}

function columns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((row) => row.name);
}

/** A Usage Record whose Provider reported no cached prompt tokens. */
const UNCACHED: UsageRecord = {
  timestamp: '2026-10-27T09:30:00.000Z',
  harnessId: 'acme/code-reviewer',
  harnessVersion: '1.2.0',
  slot: 'default',
  provider: 'openai-compatible:fake',
  model: 'fake-model',
  promptTokens: 12,
  completionTokens: 34,
  durationMs: 250,
  status: 'ok',
};
const RECORD: UsageRecord = { ...UNCACHED, cachedPromptTokens: 5 };

describe('openDatabase', () => {
  it('creates the file on first run with the schema of every migration', () => {
    const db = open();
    expect(existsSync(path)).toBe(true);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(schema(db).map(({ type, name }) => `${type} ${name}`)).toEqual([
      'table settings',
      'table usage_records',
      'index usage_records_harness_id_timestamp',
    ]);
    expect(columns(db, 'settings')).toEqual(['key', 'value']);
    expect(columns(db, 'usage_records')).toEqual([
      'id',
      'timestamp',
      'harness_id',
      'harness_version',
      'slot',
      'provider',
      'model',
      'prompt_tokens',
      'completion_tokens',
      'cached_prompt_tokens',
      'duration_ms',
      'status',
    ]);
    const index = db.prepare("PRAGMA index_info('usage_records_harness_id_timestamp')").all();
    expect(index.map((column) => (column as { name: string }).name)).toEqual([
      'harness_id',
      'timestamp',
    ]);
  });

  it('opens in WAL mode with foreign keys on', () => {
    const db = open();
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });

  it('reopens an existing database without applying a migration twice or losing data', () => {
    const first = open();
    first.prepare("INSERT INTO settings (key, value) VALUES ('locale', '\"zh-CN\"')").run();
    const schemaBefore = schema(first);
    first.close();

    const second = open();
    expect(schemaVersion(second)).toBe(MIGRATIONS.length);
    expect(schema(second)).toEqual(schemaBefore);
    expect(second.prepare('SELECT key, value FROM settings').all()).toEqual([
      { key: 'locale', value: '"zh-CN"' },
    ]);
  });

  it('applies only the migrations added since the last launch', () => {
    open(['CREATE TABLE a (x INTEGER)']).close();
    const db = open(['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER)']);
    expect(schemaVersion(db)).toBe(2);
    expect(schema(db).map(({ name }) => name)).toEqual(['a', 'b']);
  });

  it('rolls a failing migration back entirely and reports which one failed', () => {
    open(['CREATE TABLE a (x INTEGER)']).close();
    expect(() =>
      open(['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER); CREATE TABLE a (z)']),
    ).toThrow('Database migration 2 failed.');
    const db = new DatabaseSync(path);
    opened.push(db);
    expect(schemaVersion(db)).toBe(1);
    expect(schema(db).map(({ name }) => name)).toEqual(['a']);
  });

  it('reports the real cause when SQLite already rolled the failing migration back', () => {
    open(['CREATE TABLE a (x INTEGER)']).close();
    // ON CONFLICT ROLLBACK makes SQLite end the transaction itself, as a full disk does.
    const failing =
      'CREATE TABLE b (y UNIQUE ON CONFLICT ROLLBACK); INSERT INTO b VALUES (1); INSERT INTO b VALUES (1);';
    let thrown: unknown;
    try {
      open(['CREATE TABLE a (x INTEGER)', failing]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Database migration 2 failed.');
    expect(((thrown as Error).cause as Error).message).toMatch(/UNIQUE constraint failed/);
    const db = new DatabaseSync(path);
    opened.push(db);
    expect(schemaVersion(db)).toBe(1);
    expect(schema(db).map(({ name }) => name)).toEqual(['a']);
  });

  it('refuses a database a newer app version migrated', () => {
    open(['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (y INTEGER)']).close();
    expect(() => open(['CREATE TABLE a (x INTEGER)'])).toThrow(/newer version of Harness Store/);
  });

  it('bundles every SQL file in migrations/, in file name order', () => {
    const migrationsDir = join(import.meta.dirname, '../../src/main/runtime/migrations');
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(files.map((name) => /^(\d{4})_/.exec(name)?.[1])).toEqual(
      MIGRATIONS.map((_, index) => String(index + 1).padStart(4, '0')),
    );
    // The ?raw imports give each file's exact text, so this catches a misordered or duplicated
    // entry in the hand-maintained MIGRATIONS array.
    expect(files.map((name) => readFileSync(join(migrationsDir, name), 'utf8'))).toEqual(
      MIGRATIONS,
    );
  });

  it('migrate on an up-to-date database does nothing', () => {
    const db = open();
    expect(() => {
      migrate(db, MIGRATIONS);
    }).not.toThrow();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  });
});

describe('usage_records', () => {
  it('stores a Usage Record with every field', () => {
    const db = open();
    createUsageRecordStore(db).insert(RECORD);
    expect(db.prepare('SELECT * FROM usage_records').all()).toEqual([
      {
        id: 1,
        timestamp: '2026-10-27T09:30:00.000Z',
        harness_id: 'acme/code-reviewer',
        harness_version: '1.2.0',
        slot: 'default',
        provider: 'openai-compatible:fake',
        model: 'fake-model',
        prompt_tokens: 12,
        completion_tokens: 34,
        cached_prompt_tokens: 5,
        duration_ms: 250,
        status: 'ok',
      },
    ]);
  });

  it('stores counts the Provider did not report, and an explicit model id, as NULL', () => {
    const db = open();
    createUsageRecordStore(db).insert({
      ...UNCACHED,
      slot: null,
      promptTokens: null,
      completionTokens: null,
      status: 'aborted',
    });
    expect(
      db
        .prepare(
          'SELECT slot, prompt_tokens, completion_tokens, cached_prompt_tokens, status FROM usage_records',
        )
        .get(),
    ).toEqual({
      slot: null,
      prompt_tokens: null,
      completion_tokens: null,
      cached_prompt_tokens: null,
      status: 'aborted',
    });
  });

  it('rejects a status outside the four a Usage Record can have', () => {
    const db = open();
    expect(() => {
      createUsageRecordStore(db).insert({ ...RECORD, status: 'done' as UsageRecord['status'] });
    }).toThrow(/CHECK constraint failed/);
  });
});
