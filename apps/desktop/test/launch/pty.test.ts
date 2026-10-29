import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { spawnNodePty, type PtyExit, type PtyProcess } from '../../src/main/runtime/pty.js';

/**
 * Ticket P0-13: disposing of a pty once its process has exited, with node-pty for real. On Windows
 * that closes the pseudoconsole, so no console host is left behind, without node-pty's `kill`,
 * which forks a helper to list the console's processes and may kill the exited Harness's pid,
 * which another process may have by then.
 */

const WINDOWS = process.platform === 'win32';

/** A pty running Node for a moment, resolved with it once its process has exited. */
async function exited(): Promise<PtyProcess> {
  const pty = spawnNodePty({
    file: process.execPath,
    args: ['-e', 'console.log("bye")'],
    cwd: tmpdir(),
    env: { ...(process.env as Record<string, string>) },
    cols: 80,
    rows: 24,
  });
  await new Promise<PtyExit>((resolve) => {
    pty.onExit(resolve);
  });
  return pty;
}

/**
 * The console hosts ConPTY started for this process (`conhost.exe --headless`, a child of the
 * process that created the pseudoconsole), by pid.
 */
function consoleHosts(): number[] {
  const filter = `ParentProcessId=${String(process.pid)} AND Name='conhost.exe'`;
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
        `Where-Object { $_.CommandLine -like '*--headless*' } | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return output.split(/\s+/).filter(Boolean).map(Number);
}

describe('spawnNodePty dispose', () => {
  it('can be called once the process has exited, and again, without throwing', async () => {
    const pty = await exited();
    expect(() => {
      pty.dispose();
      pty.dispose();
    }).not.toThrow();
  });

  it.runIf(WINDOWS)(
    'closes the console host of an exited process, without forking a helper',
    async () => {
      const before = new Set(consoleHosts());
      const pty = await exited();
      // node-pty leaves the console host running after the exit: dispose is what ends it.
      const hosts = consoleHosts().filter((pid) => !before.has(pid));
      expect(hosts.length).toBeGreaterThan(0);

      const childProcess = createRequire(import.meta.url)('node:child_process') as {
        fork: (...args: unknown[]) => unknown;
      };
      const fork = vi.spyOn(childProcess, 'fork');
      try {
        pty.dispose();
        await expect
          .poll(() => consoleHosts().filter((pid) => hosts.includes(pid)), { timeout: 10_000 })
          .toEqual([]);
        expect(fork).not.toHaveBeenCalled();
      } finally {
        fork.mockRestore();
      }
    },
  );
});
