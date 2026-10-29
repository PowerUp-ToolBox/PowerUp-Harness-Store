#!/usr/bin/env node
/**
 * `node scripts/e2e-summary.mjs [results.json]`: lists the Playwright tests of a run that passed
 * only on their retry (flaky) or failed, from the JSON report of e2e/playwright.config.ts
 * (default e2e/test-results/results.json). In CI it appends the list to the job summary
 * (`GITHUB_STEP_SUMMARY`), so an intermittent failure is visible without failing the job; anywhere
 * else it prints it. It always exits 0: the test run itself decides whether the job fails.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const reportPath =
  process.argv[2] ?? join(import.meta.dirname, '..', 'e2e', 'test-results', 'results.json');

/** Every test of every spec in `suites`, nested suites included, with its title path. */
function* testsOf(suites, titles = []) {
  for (const suite of suites ?? []) {
    const path = suite.title === '' ? titles : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) yield { title: [...path, spec.title].join(' › '), test };
    }
    yield* testsOf(suite.suites, path);
  }
}

function summary() {
  if (!existsSync(reportPath)) return `### Desktop E2E\n\nNo report at ${reportPath}.\n`;
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const lines = ['### Desktop E2E', ''];
  const listed = { flaky: 'Passed only on retry (flaky)', unexpected: 'Failed' };
  for (const [status, heading] of Object.entries(listed)) {
    const tests = [...testsOf(report.suites)].filter(({ test }) => test.status === status);
    if (tests.length === 0) continue;
    lines.push(`**${heading}**`, '');
    for (const { title, test } of tests) lines.push(`- [${test.projectName}] ${title}`);
    lines.push('');
  }
  const { expected = 0, flaky = 0, unexpected = 0, skipped = 0 } = report.stats ?? {};
  lines.push(`${expected} passed, ${flaky} flaky, ${unexpected} failed, ${skipped} skipped.`, '');
  return lines.join('\n');
}

const text = summary();
const target = process.env.GITHUB_STEP_SUMMARY;
if (target) appendFileSync(target, text);
else process.stdout.write(text);
