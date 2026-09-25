// @ts-check
import { builtinModules } from 'node:module';
import { defineConfig, globalIgnores } from 'eslint/config';
import harnessStore from '../../eslint.config.js';

// Extends the shared root config. The main entry point (src/) must run in the Electron renderer
// and in Deno as well as in Node, so it may not import Node built-ins or use Node-only globals.
// Node-only code lives in src/node/, the `@harness-store/manifest/node` subpath export.
// fixtures/ holds test Harness Packages (their Entry files are data, not code of this package).
export default defineConfig(harnessStore, globalIgnores(['fixtures/']), {
  name: 'harness-store/manifest-pure-entry',
  files: ['src/**/*.ts'],
  ignores: ['src/node/**'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: `^(node:.*|(${builtinModules.join('|')})(/.*)?)$`,
            message: 'src/ must stay free of Node built-ins: it also runs in browsers and Deno.',
          },
        ],
      },
    ],
    'no-restricted-globals': [
      'error',
      ...['process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'global'].map(
        (name) => ({ name, message: 'Node-only global: src/ also runs in browsers and Deno.' }),
      ),
    ],
  },
});
