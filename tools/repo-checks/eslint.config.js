// @ts-check
import { defineConfig } from 'eslint/config';
import harnessStore from '../../eslint.config.js';

// Extends the shared root config; add package-specific overrides as extra arguments.
export default defineConfig(harnessStore);
