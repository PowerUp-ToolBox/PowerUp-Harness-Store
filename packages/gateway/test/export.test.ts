/**
 * The fake Provider through its published entry point, as other packages import it. Imports the
 * built `dist/` (run `pnpm build` first; CI builds before testing).
 */
import { expect, it } from 'vitest';
import { startFakeProvider } from '@harness-store/gateway/testing/fake-provider';

it('starts from @harness-store/gateway/testing/fake-provider, answers and stops', async () => {
  const fake = await startFakeProvider();
  try {
    const response = await fetch(`${fake.url}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'fake/echo', messages: [{ role: 'user', content: 'ping' }] }),
    });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe('ping');
  } finally {
    await fake.close();
  }
});
