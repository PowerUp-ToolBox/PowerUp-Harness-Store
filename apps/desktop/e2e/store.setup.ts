/**
 * Starts the local Store once for the acceptance journey (support/store.ts): the stack, its Edge
 * Functions and the fake GitHub. Docker images are pulled here on a first run, which is why this
 * is setup and not part of the journey's 10-minute budget.
 */
import { test } from '@playwright/test';
import { startStore } from './support/store.ts';

test('start the local Store', async () => {
  test.setTimeout(20 * 60_000);
  await startStore();
});
