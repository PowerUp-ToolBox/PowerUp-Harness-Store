// @ts-check
// Shared ESLint flat config for every TypeScript package in the monorepo.
// Packages extend it from their own eslint.config.js instead of copying rules:
//
//   import { defineConfig } from 'eslint/config';
//   import harnessStore from '../../eslint.config.js';
//   export default defineConfig(harnessStore, { /* package-specific overrides */ });

import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  // out/ and release/ are the desktop app's electron-vite and electron-builder output.
  globalIgnores(['**/dist/', '**/out/', '**/release/', '**/coverage/', '**/node_modules/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    name: 'harness-store/typed-linting',
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        // Each file is linted with the nearest tsconfig.json (the package's own).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    name: 'harness-store/plain-javascript',
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
  // Formatting is Prettier's job; turn off every stylistic rule that could fight it.
  prettier,
);
