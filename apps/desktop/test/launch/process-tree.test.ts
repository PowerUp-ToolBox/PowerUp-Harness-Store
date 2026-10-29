import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isConsoleProgram, signalProcessTree } from '../../src/main/runtime/process-tree.js';
import { removeFolder } from '../support/harness-processes.js';

/**
 * Ticket P0-13: what the shutdown sequence does on each OS before the Supervisor waits. On Windows
 * the polite step cannot end a console program, so it is refused at once and the Supervisor
 * forces the stop without waiting out the grace period.
 */

const WINDOWS = process.platform === 'win32';
const folder = mkdtempSync(join(tmpdir(), 'harness-store-process-tree-'));
afterAll(() => {
  removeFolder(folder);
});

/** A file with the start of a PE executable of `subsystem` (3 console, 2 GUI), PE32+ layout. */
function peFile(name: string, subsystem: number): string {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'latin1');
  const pe = 0x80;
  bytes.writeUInt32LE(pe, 0x3c);
  bytes.write('PE\0\0', pe, 'latin1');
  bytes.writeUInt16LE(0x20b, pe + 24);
  bytes.writeUInt16LE(subsystem, pe + 24 + 68);
  const path = join(folder, name);
  writeFileSync(path, bytes);
  return path;
}

describe('isConsoleProgram', () => {
  it('reads the PE subsystem on Windows', () => {
    expect(isConsoleProgram(peFile('console.exe', 3), 'win32')).toBe(true);
    expect(isConsoleProgram(peFile('gui.exe', 2), 'win32')).toBe(false);
  });

  it('is false for what is no PE executable, or cannot be read, and off Windows', () => {
    const script = join(folder, 'start.cmd');
    writeFileSync(script, '@echo off\r\n');
    expect(isConsoleProgram(script, 'win32')).toBe(false);
    expect(isConsoleProgram(join(folder, 'missing.exe'), 'win32')).toBe(false);
    expect(isConsoleProgram(peFile('elsewhere.exe', 3), 'linux')).toBe(false);
  });

  it.runIf(WINDOWS)('finds node.exe a console program', () => {
    expect(isConsoleProgram(process.execPath)).toBe(true);
  });
});

describe('signalProcessTree', () => {
  it('refuses the polite step for a Windows console program at once, sending nothing', async () => {
    // A pid no process could have: nothing may be signalled, on any OS.
    await expect(
      signalProcessTree(2 ** 30, 'SIGTERM', { consoleProgram: true, platform: 'win32' }),
    ).resolves.toBe('refused');
  });

  it('never signals a pid that is not a process', async () => {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      await expect(signalProcessTree(0, signal, { consoleProgram: true })).resolves.toBe('sent');
    }
  });

  it.runIf(WINDOWS)('ends a console program with the forced step on Windows', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const pid = child.pid ?? 0;
    await expect(signalProcessTree(pid, 'SIGTERM', { consoleProgram: true })).resolves.toBe(
      'refused',
    );
    await expect(signalProcessTree(pid, 'SIGKILL', { consoleProgram: true })).resolves.toBe('sent');
    await exited;
  });

  it.skipIf(WINDOWS)('signals the process group on macOS and Linux', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    const exited = new Promise((resolve) =>
      child.once('exit', (_code, signal) => {
        resolve(signal);
      }),
    );
    await expect(signalProcessTree(child.pid ?? 0, 'SIGTERM')).resolves.toBe('sent');
    await expect(exited).resolves.toBe('SIGTERM');
  });
});
