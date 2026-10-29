/**
 * Resolves the Electron binary before any journey starts. pnpm skips Electron's install script
 * (pnpm-workspace.yaml), so on a fresh checkout or CI runner the first `require('electron')`
 * downloads it: doing that here keeps the download out of a journey's 10-minute budget, and a
 * failed download fails setup, not a journey's launch step (where a retry would call it flaky).
 */
import { createRequire } from 'node:module';

export default function globalSetup(): void {
  createRequire(import.meta.url)('electron');
}
