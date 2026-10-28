import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const DESKTOP_DIR = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Lints `code` as if it were a renderer component, with the app's real ESLint config. Only the
 * hard-coded text rule runs: the snippet is not in a tsconfig, so type-aware rules cannot.
 */
async function lintComponent(code: string) {
  const eslint = new ESLint({
    cwd: DESKTOP_DIR,
    overrideConfig: {
      languageOptions: { parserOptions: { project: null, projectService: false } },
    },
    ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-syntax',
  });
  const [result] = await eslint.lintText(code, {
    filePath: `${DESKTOP_DIR}src/renderer/src/pages/LintProbe.tsx`,
  });
  return (result?.messages ?? []).map(({ ruleId, line, message }) => ({ ruleId, line, message }));
}

const USE_CATALOG = 'UI text comes from the message catalog: use t() from useI18n().';

describe('ESLint: no hard-coded UI text in the renderer', () => {
  it('fails a component with a raw JSX string, in any script', async () => {
    const messages = await lintComponent(
      [
        'export function Probe() {',
        '  return (',
        '    <div>',
        '      <h1>Install</h1>',
        '      <p>安装</p>',
        '    </div>',
        '  );',
        '}',
      ].join('\n'),
    );
    expect(messages).toEqual([
      { ruleId: 'no-restricted-syntax', line: 4, message: USE_CATALOG },
      { ruleId: 'no-restricted-syntax', line: 5, message: USE_CATALOG },
    ]);
  });

  it('fails literal text in aria-label, title, placeholder and alt', async () => {
    const messages = await lintComponent(
      [
        'export function Probe() {',
        '  return (',
        '    <div>',
        '      <nav aria-label="Main" />',
        "      <button title={'Close'} />",
        '      <input placeholder={`Search`} />',
        '      <img alt="Icon" />',
        '    </div>',
        '  );',
        '}',
      ].join('\n'),
    );
    expect(messages.map(({ line }) => line)).toEqual([4, 5, 6, 7]);
  });

  it('passes text from t(), punctuation, and non-text attributes', async () => {
    const messages = await lintComponent(
      [
        "import { useI18n } from '../i18n/I18nProvider.js';",
        'export function Probe({ id }: { id: string }) {',
        '  const { t } = useI18n();',
        '  return (',
        '    <div className="placeholder" id="probe">',
        "      <h1 aria-label={t('nav.label')}>{t('section.library')}</h1>",
        '      <span> · </span>',
        '      <code>{id}</code>',
        '      <img alt="" />',
        '    </div>',
        '  );',
        '}',
      ].join('\n'),
    );
    expect(messages).toEqual([]);
  });
});
