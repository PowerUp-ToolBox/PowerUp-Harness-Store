/** Stops the local Store the setup started, keeping its database volume (support/store.ts). */
import { test } from '@playwright/test';
import { stopStore } from './support/store.ts';

test('stop the local Store', () => {
  test.setTimeout(5 * 60_000);
  stopStore();
});
