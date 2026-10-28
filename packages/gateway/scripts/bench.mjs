// The Model Gateway's performance budget (spec P0-02, "Performance"), measured against the fake
// Provider from the built package (`pnpm build` first):
//
// - startup: loading the package, `createGateway` and `listen`, under 300 ms;
// - overhead: the median time of 200 sequential non-streaming calls through the Gateway minus the
//   median of the same calls straight to the fake, under 20 ms, with Usage Records being written.
//
// Exits non-zero when either is over budget. Not part of `pnpm test`: timings depend on the
// machine. Run with `pnpm --filter @harness-store/gateway bench`.

import { performance } from 'node:perf_hooks';

const STARTUP_BUDGET_MS = 300;
const OVERHEAD_BUDGET_MS = 20;
const CALLS = 200;
const WARMUP = 20;
const FAKE = 'openai-compatible:fake';

const distUrl = new URL('../dist/', import.meta.url);

// Startup: loading the package, then creating and starting a Gateway (the fake is not counted).
const loadStarted = performance.now();
const { createGateway } = await import(new URL('index.js', distUrl).href);
const loadMs = performance.now() - loadStarted;

const { startFakeProvider } = await import(new URL('testing/fake-provider.js', distUrl).href);
const fake = await startFakeProvider();
const records = [];

const createStarted = performance.now();
const gateway = createGateway({
  getManifest: () => Promise.resolve(null),
  resolveBinding: () => Promise.resolve(null),
  getConnection: (providerId) =>
    Promise.resolve(providerId === FAKE ? { baseUrl: fake.url } : null),
  // Usage Records stay on: the budget holds with them, not without.
  onUsage: (record) => {
    records.push(record);
    return Promise.resolve();
  },
});
const { url } = await gateway.listen();
const listenMs = performance.now() - createStarted;
const startupMs = loadMs + listenMs;

const token = gateway.issueToken({
  harnessId: 'bench/harness',
  harnessVersion: '1.0.0',
  launchId: 'bench',
  locale: 'en',
});
const messages = [{ role: 'user', content: 'The quick brown fox jumps over the lazy dog.' }];

/** Times one non-streaming call, read to the end; fails on anything but 200. */
async function timeCall(base, authorization, model) {
  const started = performance.now();
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization },
    body: JSON.stringify({ model, messages }),
  });
  await response.text();
  if (response.status !== 200) throw new Error(`${base} answered ${String(response.status)}`);
  return performance.now() - started;
}

/** The median of `count` sequential calls, after `WARMUP` untimed ones. */
async function medianOf(count, call) {
  for (let i = 0; i < WARMUP; i++) await call();
  const times = [];
  for (let i = 0; i < count; i++) times.push(await call());
  times.sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  return times.length % 2 === 1 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
}

try {
  const direct = await medianOf(CALLS, () => timeCall(fake.url, 'Bearer none', 'fake/echo'));
  const through = await medianOf(CALLS, () =>
    timeCall(url, `Bearer ${token}`, `${FAKE}/fake/echo`),
  );
  const overheadMs = through - direct;
  // Records are delivered after each response; give the last one its turn.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const expected = CALLS + WARMUP;
  if (records.length !== expected) {
    throw new Error(`Expected ${String(expected)} Usage Records, got ${String(records.length)}.`);
  }

  const verdict = (value, budget) => (value < budget ? 'ok' : 'OVER BUDGET');
  const ms = (value) => `${value.toFixed(2)} ms`;
  console.log(
    `startup:  ${ms(startupMs)} (budget < ${String(STARTUP_BUDGET_MS)} ms) ${verdict(startupMs, STARTUP_BUDGET_MS)}`,
  );
  console.log(`  load ${ms(loadMs)}, create and listen ${ms(listenMs)}`);
  console.log(
    `median:   ${ms(direct)} direct to the fake, ${ms(through)} through the Gateway (${String(CALLS)} calls each)`,
  );
  console.log(
    `overhead: ${ms(overheadMs)} (budget < ${String(OVERHEAD_BUDGET_MS)} ms) ${verdict(overheadMs, OVERHEAD_BUDGET_MS)}`,
  );
  console.log(`Usage Records written: ${String(records.length)}`);
  if (startupMs >= STARTUP_BUDGET_MS || overheadMs >= OVERHEAD_BUDGET_MS) process.exitCode = 1;
} finally {
  await gateway.close();
  await fake.close();
}
