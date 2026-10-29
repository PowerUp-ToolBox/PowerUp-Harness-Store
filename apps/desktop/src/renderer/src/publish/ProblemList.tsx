import type { Problem } from '@harness-store/manifest';
import { useI18n } from '../i18n/I18nProvider.js';

/** Validation findings in path order: the path, the message in the UI language, the code. */
export function ProblemList({ problems }: { readonly problems: readonly Problem[] }) {
  const { problemText } = useI18n();
  return (
    <ul className="problem-list">
      {problems.map((problem, index) => (
        // Paths repeat (one file can have several problems) and the list never reorders.
        <li key={index}>
          <code>{problem.path}</code>
          <span>{problemText(problem)}</span>
          <code className="problem-code">{problem.code}</code>
        </li>
      ))}
    </ul>
  );
}
