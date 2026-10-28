import { createWriteStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where a log line came from: the process's stdout or stderr (web UI Kind), its pty (terminal UI
 * Kind, both streams in one), or the Runtime itself (spawn, signals sent, exit).
 */
export type LogSource = 'out' | 'err' | 'pty' | 'runtime';

/** A launch log stops growing at this size. */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
/** How many launch logs of one Harness are kept: the newest. */
export const KEPT_LAUNCH_LOGS = 20;
/** A line longer than this is written as it is, without waiting for its end. */
const MAX_PENDING = 64 * 1024;

/** One launch's log file. */
export interface LaunchLog {
  readonly path: string;
  /**
   * Appends output: one line per line of `text`, as `<ISO-8601> [<source>] <line>`. A line waits
   * for its end (or for {@link close}); pty output is kept raw, ANSI codes included. Never throws:
   * a file that cannot be written loses the output, not the launch.
   */
  write(source: LogSource, text: string): void;
  /** Writes the lines still waiting for their end and closes the file. Idempotent. */
  close(): Promise<void>;
}

export interface LaunchLogOptions {
  /** Default {@link LOG_MAX_BYTES}: past it, one line says so and the rest is dropped. */
  readonly maxBytes?: number;
  readonly now?: () => Date;
}

/**
 * Creates the log file at `path` (its folder must exist). It never holds the environment or the
 * Gateway Token: the Runtime only writes what the process prints and its own lines.
 */
export function openLaunchLog(path: string, options: LaunchLogOptions = {}): LaunchLog {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const now = options.now ?? (() => new Date());
  const stream = createWriteStream(path, { flags: 'w' });
  const closed = new Promise<void>((resolve) => {
    stream.once('close', resolve);
  });
  // A disk that is full or gone loses the output; the launch goes on.
  stream.on('error', () => undefined);
  const pending = new Map<LogSource, string>();
  let written = 0;
  let truncated = false;
  let ended: Promise<void> | undefined;

  const line = (source: LogSource, text: string) => {
    if (truncated) return;
    const entry = `${now().toISOString()} [${source}] ${text}\n`;
    const bytes = Buffer.byteLength(entry);
    if (written + bytes > maxBytes) {
      truncated = true;
      const megabytes = String(Math.round(maxBytes / (1024 * 1024)));
      stream.write(
        `${now().toISOString()} [runtime] The log reached ${megabytes} MB; later output is not kept.\n`,
      );
      return;
    }
    written += bytes;
    stream.write(entry);
  };

  return {
    path,
    write(source, text) {
      if (ended !== undefined) return;
      const lines = ((pending.get(source) ?? '') + text).split('\n');
      let rest = lines.pop() ?? '';
      for (const each of lines) line(source, withoutCarriageReturn(each));
      if (rest.length > MAX_PENDING) {
        line(source, rest);
        rest = '';
      }
      pending.set(source, rest);
    },
    close() {
      ended ??= (async () => {
        for (const [source, rest] of pending) if (rest !== '') line(source, rest);
        pending.clear();
        stream.end();
        await closed;
      })();
      return ended;
    },
  };
}

/** A line as a terminal ends it (`\r\n`) without its `\r`. */
function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Deletes all but the `keep` newest launch logs (`*.log`, by modification time) in `folder`.
 * Never throws: a log that cannot be deleted is left for the next launch.
 */
export async function pruneLaunchLogs(folder: string, keep = KEPT_LAUNCH_LOGS): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(folder)).filter((name) => name.endsWith('.log'));
  } catch {
    return;
  }
  if (names.length <= keep) return;
  const logs = await Promise.all(
    names.map(async (name) => {
      const path = join(folder, name);
      try {
        return { path, modified: (await stat(path)).mtimeMs };
      } catch {
        return { path, modified: 0 };
      }
    }),
  );
  logs.sort((a, b) => b.modified - a.modified || (a.path < b.path ? 1 : -1));
  await Promise.all(
    logs.slice(keep).map(({ path }) => rm(path, { force: true }).catch(() => undefined)),
  );
}
