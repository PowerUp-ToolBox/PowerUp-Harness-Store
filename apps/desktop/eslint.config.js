// @ts-check
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import harnessStore from '../../eslint.config.js';

// Attributes whose text the User sees (or a screen reader reads) without it being JSX text.
const TEXT_ATTRIBUTE = 'JSXAttribute[name.name=/^(aria-label|title|placeholder|alt)$/]';
const USE_CATALOG = 'UI text comes from the message catalog: use t() from useI18n().';

// Extends the shared root config.
export default defineConfig(
  harnessStore,
  {
    // The Runtime's services and IPC handlers, and the code shared with the renderer, never import
    // Electron (types aside), so they are unit-tested under plain Node. Only src/main/index.ts,
    // src/main/harness-windows.ts (the Harness windows) and the preloads (src/preload/index.ts,
    // src/preload/harness.ts) touch Electron.
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
              message:
                'Only src/main/index.ts, src/main/harness-windows.ts and the preloads may use Electron.',
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
  {
    // The Playwright journeys belong to tsconfig.e2e.json, not to the nearest tsconfig.json.
    name: 'harness-store/desktop-e2e',
    files: ['e2e/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.e2e.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Every string the User sees comes from the en and zh-CN catalogs. JSX text with a letter (any
    // script) and literal text in the attributes above fail the lint; punctuation and whitespace
    // between elements do not. test/i18n/lint-rule.test.ts proves the rule fires.
    name: 'harness-store/desktop-no-hard-coded-ui-text',
    files: ['src/renderer/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'JSXText[value=/\\p{L}/u]', message: USE_CATALOG },
        { selector: `${TEXT_ATTRIBUTE} > Literal[value=/\\p{L}/u]`, message: USE_CATALOG },
        {
          selector: `${TEXT_ATTRIBUTE} > JSXExpressionContainer > Literal[value=/\\p{L}/u]`,
          message: USE_CATALOG,
        },
        {
          selector: `${TEXT_ATTRIBUTE} > JSXExpressionContainer > TemplateLiteral > TemplateElement[value.raw=/\\p{L}/u]`,
          message: USE_CATALOG,
        },
      ],
    },
  },
);
