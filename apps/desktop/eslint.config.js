// @ts-check
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import harnessStore from '../../eslint.config.js';

// Extends the shared root config.
export default defineConfig(
  harnessStore,
  {
    // The Runtime's services and IPC handlers, and the code shared with the renderer, never import
    // Electron (types aside), so they are unit-tested under plain Node. Only src/main/index.ts and
    // src/preload/index.ts touch Electron.
    name: 'harness-store/desktop-electron-free',
    files: ['src/main/runtime/**', 'src/shared/**', 'src/preload/build-api.ts', 'src/renderer/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              allowTypeImports: true,
              message: 'Only src/main/index.ts and src/preload/index.ts may use Electron.',
            },
          ],
        },
      ],
    },
  },
  {
    // Renderer files belong to tsconfig.web.json, not to the nearest tsconfig.json.
    name: 'harness-store/desktop-renderer',
    files: ['src/renderer/**/*.{ts,tsx}', 'test/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: false,
        project: './tsconfig.web.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
