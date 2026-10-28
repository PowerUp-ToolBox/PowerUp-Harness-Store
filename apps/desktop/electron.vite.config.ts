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

// Main and preload bundle every JS dependency, workspace packages included: only `electron` and
// Node built-ins stay external (electron-vite's preset), so the packaged app needs no
// node_modules. The preload is CommonJS because a sandboxed preload cannot be an ES module.
export default defineConfig({
  main: {
    build: { externalizeDeps: false },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), devContentSecurityPolicy()],
  },
});
