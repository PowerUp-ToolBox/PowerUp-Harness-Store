/**
 * The steps the journeys share, each driven through the app's screens as a User would: clicks,
 * typed text and what the screens show. Nothing here reads or writes the Runtime's state; the
 * only stand-ins are the OS's own surfaces (the folder picker, the browser, a window's close
 * button), which Playwright cannot click.
 */
import { randomBytes } from 'node:crypto';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { answerFolderPicker, HELLO_WEB_FOLDER, OLLAMA_MODEL } from './app.ts';
import { captureBrowser, completeSignIn, PUBLISHER } from './store.ts';

/** hello-web's name, as its Manifest gives it. */
export const HELLO_WEB = 'Hello Web';

/** A section of the sidebar. */
export async function openSection(window: Page, name: string): Promise<void> {
  await window
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name, exact: true })
    .click();
}

/**
 * The first-run wizard (P0-04.5) in English: it finds the fake Ollama, adds it as a Connection
 * (and nothing else it may find, such as a local LM Studio), and binds the `default` Model Slot
 * to {@link OLLAMA_MODEL}; it ends on Store home.
 */
export async function completeWizard(window: Page): Promise<void> {
  await window.locator('#onboarding-language').selectOption('en');
  await window.getByRole('button', { name: 'Continue' }).click();

  await expect(window.getByRole('heading', { name: 'Local Providers' })).toBeVisible();
  const ollama = window.locator('.provider-row').filter({ hasText: 'Ollama' });
  await expect(ollama, 'local detection must find the fake Ollama').toContainText(OLLAMA_MODEL);
  for (const other of await window
    .locator('.provider-row')
    .filter({ hasNotText: 'Ollama' })
    .all()) {
    await other.getByRole('checkbox').uncheck();
  }
  await window.getByRole('button', { name: 'Continue' }).click();

  await expect(window.getByRole('heading', { name: 'Remote Provider (optional)' })).toBeVisible();
  await window.getByRole('button', { name: 'Continue' }).click();

  await expect(
    window.getByRole('heading', { name: 'Choose the model Harnesses use by default' }),
  ).toBeVisible();
  const picker = window.getByLabel('Default Model', { exact: true });
  const option = picker.locator('option', { hasText: OLLAMA_MODEL });
  await expect(option, `Ollama's model list must offer ${OLLAMA_MODEL}`).toHaveCount(1);
  await picker.selectOption((await option.getAttribute('value')) ?? '');
  await window.getByRole('button', { name: 'Continue' }).click();

  await expect(window.getByRole('heading', { name: 'Setup complete' })).toBeVisible();
  await expect(window.locator('.wizard-summary')).toContainText(`${OLLAMA_MODEL} on Ollama`);
  await window.getByRole('button', { name: 'Open Store' }).click();
}

/** Consents in the install consent dialog (P0-10.1) of hello-web 0.1.0. */
export async function consentToInstall(window: Page): Promise<void> {
  const consent = window.getByRole('dialog', { name: `Install ${HELLO_WEB} 0.1.0?` });
  await expect(consent).toContainText('harness-store/hello-web · 0.1.0');
  // Install arms one second after the dialog opens.
  await consent.getByRole('button', { name: 'Install' }).click();
  await expect(consent).toBeHidden();
}

/** Publish → "Install this folder locally" (P0-05.1) with hello-web's folder, then the Library. */
export async function installHelloWebFromFolder(app: ElectronApplication, window: Page) {
  await openSection(window, 'Publish');
  await answerFolderPicker(app, HELLO_WEB_FOLDER);
  await window.getByRole('button', { name: 'Install this folder locally' }).click();
  await consentToInstall(window);
  await expect(window.getByText(`Installed ${HELLO_WEB} 0.1.0 from the folder.`)).toBeVisible();
  await window.getByRole('link', { name: 'Open Library' }).click();
}

/**
 * Publish → Sign in with GitHub (P0-07.2, P0-08): the app opens the Store's GitHub sign-in in the
 * browser, which consents on the fake GitHub as {@link PUBLISHER} and hands the callback back.
 */
export async function signInAsPublisher(app: ElectronApplication, window: Page): Promise<void> {
  await openSection(window, 'Publish');
  await captureBrowser(app);
  await window.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(window.getByText('Finish signing in in your browser…')).toBeVisible();
  await completeSignIn(app);
  await expect(window.getByText(`Signed in as ${PUBLISHER.login}`).first()).toBeVisible();
}

/**
 * The Publish screen's New version (P0-08.2) with hello-web's folder: it validates with no
 * problem, the review shows its listing, and Publish uploads it to the Store.
 */
export async function publishHelloWeb(app: ElectronApplication, window: Page): Promise<void> {
  await answerFolderPicker(app, HELLO_WEB_FOLDER);
  await window.getByRole('button', { name: 'Choose a folder' }).click();
  await expect(window.getByText('No problems found.')).toBeVisible();
  await window.getByRole('button', { name: 'Continue' }).click();
  await expect(window.getByRole('heading', { name: 'Listing preview' })).toBeVisible();
  await window.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(
    window.getByText('harness-store/hello-web 0.1.0 is now in the Store.'),
    'the Store must accept the upload',
  ).toBeVisible({ timeout: 60_000 });
}

/**
 * Store search (P0-09.2) for hello-web's name, then its detail page. The seed has a Harness of
 * that name too (`alice/hello-web`): the card that counts is the one by {@link PUBLISHER}, which
 * exists only if the publish above reached the Store.
 */
export async function findHelloWebInStore(window: Page): Promise<void> {
  await openSection(window, 'Store');
  const search = window.getByRole('searchbox', { name: 'Search Harnesses' });
  await search.fill(HELLO_WEB);
  await search.press('Enter');
  const results = window.getByRole('list', { name: 'Search results' });
  await expect(results).toBeVisible();
  const card = results
    .getByRole('article', { name: HELLO_WEB })
    .filter({ has: window.getByRole('link', { name: PUBLISHER.login, exact: true }) });
  await expect(card, `search must find the ${HELLO_WEB} just published`).toHaveCount(1);
  await card.getByRole('link', { name: HELLO_WEB, exact: true }).click();
  await expect(window.getByRole('heading', { name: HELLO_WEB, level: 2 })).toBeVisible();
}

/** Install on the detail page (P0-10.1): the download, then consent, then the toast. */
export async function installHelloWebFromStore(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Install', exact: true }).click();
  await consentToInstall(window);
  await expect(window.getByText(`Installed ${HELLO_WEB}`, { exact: true })).toBeVisible();
}

/** hello-web's card in the Library. */
function libraryCard(window: Page) {
  return window.getByRole('article', { name: HELLO_WEB });
}

/**
 * Launch on hello-web's Library card (P0-05.3), then waits for its window to show the Harness's
 * own page, served on loopback by the Harness: that page, to drive.
 */
export async function launchHelloWeb(app: ElectronApplication, window: Page): Promise<Page> {
  await openSection(window, 'Library');
  await libraryCard(window).getByRole('button', { name: 'Launch' }).click();
  const isHarnessPage = (page: Page) => page.url().startsWith('http://127.0.0.1:');
  await expect
    .poll(() => app.windows().some(isHarnessPage), {
      message: 'the Harness window must open and show the Harness page',
      timeout: 60_000,
    })
    .toBe(true);
  const page = app.windows().find(isHarnessPage);
  if (page === undefined) throw new Error('The Harness page went away.');
  await expect(page.getByRole('heading', { name: HELLO_WEB })).toBeVisible();
  return page;
}

/**
 * Sends one chat message with a nonce on hello-web's page and checks that the answer came from
 * the fake Ollama through the Model Gateway: the page shows the fake's echo of the message and
 * the `provider/model` the Gateway reported, and the fake received exactly that one request, for
 * that model. A Harness that answered by itself, or reached a model any other way, fails here.
 */
export async function chatOnce(page: Page, ollama: FakeProvider): Promise<void> {
  const message = `Hello from the E2E journey ${randomBytes(6).toString('hex')}`;
  ollama.reset();
  await page.locator('#message').fill(message);
  await page.locator('#send').click();
  await expect(
    page.locator('#reply'),
    "the reply must be the fake Provider's echo of the message, relayed by the Model Gateway",
  ).toHaveText(message);
  await expect(page.locator('#model'), 'the Model Gateway must report the bound model').toHaveText(
    `ollama/${OLLAMA_MODEL}`,
  );
  const completions = ollama.requests.filter(
    (request) => request.method === 'POST' && request.path === '/v1/chat/completions',
  );
  expect(completions, 'the fake Ollama must receive exactly one chat completion').toHaveLength(1);
  expect(completions[0]?.body).toMatchObject({ model: OLLAMA_MODEL });
  expect(JSON.stringify(completions[0]?.body)).toContain(message);
}

/**
 * The Usage page (P0-11.1) shows exactly one Usage Record: one request in all, on hello-web's
 * row and on its {@link OLLAMA_MODEL} row via the Ollama Connection.
 */
export async function expectOneUsageRecord(window: Page): Promise<void> {
  await openSection(window, 'Usage');
  const requests = window.locator('.usage-tile').filter({ hasText: 'Requests' }).locator('dd');
  await expect(requests, 'exactly one Usage Record in all').toHaveText('1');
  const table = window.getByRole('table', { name: 'Usage by Harness and model' });
  const harnessRow = table.locator('tr.usage-row-harness');
  await expect(harnessRow).toHaveCount(1);
  await expect(harnessRow.getByRole('rowheader')).toHaveText(HELLO_WEB);
  await expect(harnessRow.getByRole('cell').first()).toHaveText('1');
  const modelRow = table.locator('tr.usage-row-model');
  await expect(modelRow).toHaveCount(1);
  await expect(modelRow.getByRole('rowheader')).toHaveText(`${OLLAMA_MODEL} via Ollama`);
  await expect(modelRow.getByRole('cell').first()).toHaveText('1');
}

/**
 * Closes hello-web's window, as its close button would, then uninstalls it from its Library card
 * (P0-10.3) and checks the Library is empty again.
 */
export async function uninstallHelloWeb(app: ElectronApplication, window: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }, name) => {
    BrowserWindow.getAllWindows()
      .find((each) => each.getTitle().startsWith(name))
      ?.close();
  }, HELLO_WEB);
  await openSection(window, 'Library');
  const card = libraryCard(window);
  await expect(card.getByRole('button', { name: 'Launch' })).toBeVisible();
  await card.getByRole('button', { name: `More actions for ${HELLO_WEB}` }).click();
  await window.getByRole('menuitem', { name: 'Uninstall' }).click();
  const dialog = window.getByRole('dialog', { name: `Uninstall ${HELLO_WEB}?` });
  await dialog.getByRole('button', { name: 'Uninstall' }).click();
  await expect(window.getByText('Nothing installed yet')).toBeVisible();
}
