/**
 * The Model Gateway and the fake Provider through their published entry points, as other packages
 * import them. Imports the built `dist/` (run `pnpm build` first; CI builds before testing).
 */
import { expect, it } from 'vitest';
import { createGateway } from '@harness-store/gateway';
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

it('serves the Model Gateway from @harness-store/gateway', async () => {
  const gateway = createGateway({
    resolveBinding: () => Promise.resolve(null),
    getConnection: () => Promise.resolve(null),
    getManifest: () => Promise.resolve(null),
    onUsage: () => Promise.resolve(),
  });
  try {
    const { url } = await gateway.listen();
    const token = gateway.issueToken({
      harnessId: 'alice/hello',
      harnessVersion: '1.0.0',
      launchId: 'launch-1',
      locale: 'en',
    });
    const response = await fetch(`${url}/harness/context`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await response.json()).toEqual({
      harnessId: 'alice/hello',
      version: '1.0.0',
      locale: 'en',
      slots: {},
    });
  } finally {
    await gateway.close();
  }
});
