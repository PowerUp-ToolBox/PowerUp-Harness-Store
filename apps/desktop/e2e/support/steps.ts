/**
 * The journey's steps: each one a Playwright step (in the trace and the failure's location) that
 * also prints its start and end to the log with the wall-clock time and the time since the journey
 * began, so a CI log alone shows in order which step a regression stopped.
 */
import { test } from '@playwright/test';

export type Step = <T>(name: string, body: () => Promise<T>) => Promise<T>;

/** One journey's step runner; its clock starts now. */
export function stepLogger(): Step {
  const started = Date.now();
  const log = (message: string) => {
    const since = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] +${since}s ${message}`);
  };
  return (name, body) =>
    test.step(name, async () => {
      const stepStarted = Date.now();
      log(`start  ${name}`);
      try {
        const result = await body();
        log(`done   ${name} (${((Date.now() - stepStarted) / 1000).toFixed(1)}s)`);
        return result;
      } catch (error) {
        log(`FAILED ${name} (${((Date.now() - stepStarted) / 1000).toFixed(1)}s)`);
        throw error;
      }
    });
}
