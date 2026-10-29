/**
 * The P0 definition of done (docs/delivery/specs/P0-13-e2e-ci-builds.md, P0-13.2) as Playwright
 * for Electron journeys over the real built app, its real Runtime and Model Gateway, and real
 * screens, with only the services around it faked: the fake Provider as Ollama, a local Supabase
 * stack as the Store, and a fake GitHub for the Publisher's sign-in.
 *
 * - `@acceptance`: a fresh User sets up Ollama in the first-run wizard, signs in as a Publisher,
 *   publishes hello-web, finds it with Store search, installs it with consent, launches it, chats
 *   once through the Model Gateway, sees that one Usage Record, and uninstalls it.
 * - `@smoke`: the same without a Store (CI's macOS, Windows and Linux matrix): hello-web comes
 *   from "Install this folder locally" instead of publish, search and Store install.
 *
 * The 10-minute budget is the test timeout (playwright.config.ts): a journey over it fails. It
 * covers the whole test, the per-attempt Store seed included; starting the Store stack is setup
 * (store.setup.ts), outside it.
 */
import type { FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { test } from '@playwright/test';
import { launchApp, startFakeOllama, type LaunchedApp } from './support/app.ts';
import {
  chatOnce,
  completeWizard,
  expectOneUsageRecord,
  findHelloWebInStore,
  installHelloWebFromFolder,
  installHelloWebFromStore,
  launchHelloWeb,
  publishHelloWeb,
  signInAsPublisher,
  uninstallHelloWeb,
} from './support/journey.ts';
import { stepLogger } from './support/steps.ts';
import { seedStore } from './support/store.ts';

let ollama: FakeProvider | undefined;
let desktop: LaunchedApp | undefined;

test.afterEach(async () => {
  try {
    await desktop?.close();
  } finally {
    await ollama?.close();
    desktop = undefined;
    ollama = undefined;
  }
});

test('a new User publishes, finds, installs, runs and uninstalls hello-web @acceptance', async () => {
  const step = stepLogger();

  await step('Seed the local Store', () => {
    seedStore();
    return Promise.resolve();
  });
  const fake = (ollama = await step('Start the fake Ollama', () => startFakeOllama()));
  const { app, window } = (desktop = await step('Launch the app on a fresh profile', () =>
    launchApp(fake, test.info()),
  ));
  await step('First-run wizard: detect Ollama, bind the default Model Slot', () =>
    completeWizard(window),
  );
  await step('Sign in as a Publisher', () => signInAsPublisher(app, window));
  await step('Publish examples/hello-web', () => publishHelloWeb(app, window));
  await step('Find it with Store search', () => findHelloWebInStore(window));
  await step('Install it with consent', () => installHelloWebFromStore(window));
  const page = await step('Launch it from the Library', () => launchHelloWeb(app, window));
  await step('Chat once through the Model Gateway', () => chatOnce(page, fake));
  await step('See its one Usage Record', () => expectOneUsageRecord(window));
  await step('Uninstall it: the Library is empty again', () => uninstallHelloWeb(app, window));
});

test('a new User installs hello-web from its folder, runs and uninstalls it @smoke', async () => {
  const step = stepLogger();

  const fake = (ollama = await step('Start the fake Ollama', () => startFakeOllama()));
  const { app, window } = (desktop = await step('Launch the app on a fresh profile', () =>
    launchApp(fake, test.info()),
  ));
  await step('First-run wizard: detect Ollama, bind the default Model Slot', () =>
    completeWizard(window),
  );
  await step('Install hello-web from its folder with consent', () =>
    installHelloWebFromFolder(app, window),
  );
  const page = await step('Launch it from the Library', () => launchHelloWeb(app, window));
  await step('Chat once through the Model Gateway', () => chatOnce(page, fake));
  await step('See its one Usage Record', () => expectOneUsageRecord(window));
  await step('Uninstall it: the Library is empty again', () => uninstallHelloWeb(app, window));
});
