import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

/**
 * The renderer's Content Security Policy lives in src/renderer/index.html. The dev server needs
 * two relaxations that must never ship: React Refresh injects an inline script, and Vite's HMR
 * client talks over a WebSocket. This plugin applies them while serving only.
 */
function devContentSecurityPolicy(): Plugin {
  return {
    name: 'harness-store:dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws:");
    },
  };
}

// Main and preload bundle every JS dependency, workspace packages included: only `electron`, Node
// built-ins (electron-vite's preset) and node-pty, a native module that ships with the app
// (electron-builder.yml), stay external. The preloads are CommonJS because a sandboxed preload
// cannot be an ES module, and each is one self-contained file, as a sandboxed preload can require
// nothing of its own: the main window's (index) and the Harness windows' (harness).
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rolldownOptions: { external: ['node-pty'] },
    },
    // The Store's anon key is fixed at build time (connectivity.ts, storeAnonKey): empty means the
    // local stack's.
    define: {
      'process.env.HARNESS_STORE_ANON_KEY': JSON.stringify(
        process.env.HARNESS_STORE_ANON_KEY ?? '',
      ),
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/preload/index.ts'),
          harness: resolve(import.meta.dirname, 'src/preload/harness.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  // Two pages: the main window (index.html) and the Harness windows' own (harness.html).
  renderer: {
    plugins: [react(), devContentSecurityPolicy()],
    build: {
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          harness: resolve(import.meta.dirname, 'src/renderer/harness.html'),
        },
      },
    },
  },
});
