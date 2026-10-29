# Local end-to-end testing

How to run the P0 acceptance journey on your own machine: first the automated one (one command), then the same journey by hand, against the local Store, with your own GitHub account as the Publisher. For maintainers; Publishers want [Authoring Harnesses](./authoring-harnesses.md).

The journey is the P0 definition of done ([`P0-13`](../delivery/specs/P0-13-e2e-ci-builds.md)): a new User sets up a model, a Publisher publishes `hello-web`, the User finds it in the Store, installs it, launches it, chats once through the **Model Gateway**, sees the **Usage Record**, and uninstalls it.

## Prerequisites

- **Docker**, running (Docker Desktop on macOS and Windows). The Store is a Supabase project ([`apps/store`](../../apps/store/README.md)) on a local stack in Docker. The first start pulls its images, a few GB; later starts take about 30 seconds.
- **Node 22** as pinned in [`.nvmrc`](../../.nvmrc) (`nvm use`), and **pnpm 10.33.0** (`corepack enable`).
- Free ports: 11434 (Ollama, or the fake one), 54321 to 54324 (the Supabase API, database, Studio and mail).

From the repository root, once per checkout and after every pull:

```sh
pnpm install
pnpm build
```

`pnpm build` compiles the desktop app into `apps/desktop/out/`, the reference Harnesses into `examples/*/out/` (the folders you install and publish) and the Store's scripts into `apps/store/dist/`.

## A. The automated journey

```sh
pnpm e2e
```

This builds, then runs both Playwright journeys of [`apps/desktop/e2e`](../../apps/desktop/e2e) over the built app (see [the desktop README](../../apps/desktop/README.md#end-to-end-journeys)):

- `smoke`, with no Store: first-run wizard, "Install this folder locally" with `hello-web`, launch, chat, Usage, uninstall. A few seconds.
- `acceptance`, the whole journey. Its setup stops your local Supabase stack if it runs (keeping its data), starts it again with the fake GitHub of the store tests, applies any new migration, serves the Edge Functions and starts the fake GitHub; it stops the stack at the end. The journey itself replaces the Store catalogue with the seed, signs in as the Publisher `harness-store` (the publisher in `hello-web`'s Harness ID), and takes about 10 seconds; with the stack restart, under a minute.

To run one: `pnpm --filter @harness-store/desktop e2e:smoke` or `pnpm --filter @harness-store/desktop e2e:acceptance` (after `pnpm build`).

Each step prints a line with its time when it starts and ends, so a failure names its step. Each run uses a new, temporary app profile and passes the app only the OS's own environment variables: no API key in your shell reaches the app or a Harness. Nothing reaches a real model or GitHub.

If a real Ollama runs on 11434, the fake one cannot listen there and the journey says so. Either stop Ollama, or move the fake:

```sh
E2E_OLLAMA_PORT=11435 pnpm e2e
```

(The test then tells the app where to look with `HARNESS_STORE_DEV_OLLAMA_URL`, which only an unpackaged app reads.)

After a failure, `apps/desktop/e2e/test-results/` holds a trace, a screenshot, the profile's `logs/` (`profile-logs/`) and the Edge Functions log (`store/functions.log`). Open a trace with:

```sh
cd apps/desktop && npx playwright show-trace e2e/test-results/<test folder>/trace.zip
```

`pnpm ci:local acceptance` runs the same journey as the CI job of that name.

The run leaves Auth's GitHub provider pointed at the fake GitHub. Before testing by hand with your own OAuth app (part B), start the stack again with `pnpm --filter @harness-store/store db:start`.

## B. The same journey by hand

### 1. A GitHub OAuth app for the local Store

The fake GitHub only answers inside Docker, so a real browser needs a real OAuth app. Once:

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**.
2. Application name: anything, such as "Harness Store local". Homepage URL: `http://127.0.0.1:54321`. **Authorization callback URL: `http://127.0.0.1:54321/auth/v1/callback`** (the local Supabase Auth, not the app).
3. Register, then **Generate a new client secret**.
4. Put both in `apps/store/supabase/.env`, which git ignores (never in a tracked file):

   ```sh
   cp apps/store/supabase/.env.example apps/store/supabase/.env
   ```

   ```sh
   # apps/store/supabase/.env
   SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=<the Client ID>
   SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=<the client secret>
   SUPABASE_AUTH_EXTERNAL_GITHUB_URL=
   ```

   `supabase/config.toml` reads these through `env(...)`; the empty URL means github.com.

### 2. Start the local Store

```sh
pnpm --filter @harness-store/store db:start          # builds, starts the stack (Studio on http://127.0.0.1:54323)
pnpm --filter @harness-store/store db:reset          # empty database, every migration, then the seed catalogue
pnpm --filter @harness-store/store functions:serve   # leave this running in its own terminal
```

`db:reset` deletes everything in the local Store. To only replace the catalogue with the seed (keeping profiles and `is_admin`), run `pnpm --filter @harness-store/store seed` instead. A shell variable named like one in `.env` wins over it: make sure none of the `SUPABASE_AUTH_EXTERNAL_GITHUB_*` variables is exported.

### 3. A model

Either:

- **Ollama**: install it, start it, and `ollama pull qwen3:8b` (or any model);
- **the fake Ollama** of the tests, which answers every message with the message itself:

  ```sh
  cd apps/desktop
  node --input-type=module -e "const { startFakeProvider } = await import('@harness-store/gateway/testing/fake-provider'); const fake = await startFakeProvider({ port: 11434, aliases: { 'qwen3:8b': 'fake/echo' } }); console.log('Fake Ollama on ' + fake.url);"
  ```

- **an OpenAI-compatible key**: you add it in the wizard's Remote Provider step instead.

### 4. Start the app on a fresh profile

```sh
HARNESS_STORE_USER_DATA_DIR="$(mktemp -d)" pnpm --filter @harness-store/desktop dev
```

A temporary profile works for sign-in on macOS only. On Windows and Linux, leave the variable out (or export it in the environment your desktop session starts programs with). There the browser's `harnessstore://` callback starts a second app process, which does not inherit a variable set on this command line, so it opens the default profile instead of handing the callback to this app, and sign-in waits until it times out.

Without the variable the app uses your normal profile (macOS `~/Library/Application Support/Harness Store`, Windows `%APPDATA%\Harness Store`, Linux `~/.config/Harness Store`). The Store URL of an unchanged app is the local stack, `http://127.0.0.1:54321`: check it in Settings → Advanced → Store URL (empty means the default) if you changed it before.

### 5. Walk the journey

1. **First-run wizard.** Welcome → Continue. Local Providers lists Ollama with its models; keep Add checked → Continue. Remote Provider: skip, or choose a Provider and paste a key → Test connection. Default model: pick the model → Continue. Done shows the Connection and the Default Model → Open Store.
2. **Sign in as a Publisher.** Publish → Sign in with GitHub. The browser opens GitHub; authorize the OAuth app; the browser then asks to open the app (`harnessstore://auth-callback`). The Publish screen shows "Signed in as `<your-login>`". See [Sign-in on macOS](#sign-in-on-macos) if it never comes back; on Windows and Linux, check that you started the app without `HARNESS_STORE_USER_DATA_DIR` (step 4).
3. **Make the reference Harnesses yours.** A Harness ID starts with its Publisher's GitHub login, in lower case, so `harness-store/hello-web` is refused for you (`publisher_mismatch`). Publish a copy, not the repository's folder:

   ```sh
   mkdir -p ~/hs-publish
   cp -R examples/hello-web/out ~/hs-publish/hello-web
   cp -R examples/hello-term/out ~/hs-publish/hello-term
   ```

   In `~/hs-publish/hello-web/manifest.json` change `"id": "harness-store/hello-web"` to `"id": "<your-login>/hello-web"`; the same for hello-term. (The automated journey instead signs in as a fake GitHub account named `harness-store`, so it publishes the folders unchanged.)
4. **Publish.** Publish → New version → Choose a folder → `~/hs-publish/hello-web`. "No problems found." → Continue → check the review and listing preview → Publish. It ends on "`<your-login>/hello-web` 0.1.0 is now in the Store." Then hello-term the same way.
5. **Find it.** Store → search "Hello Web". The seed has an `alice/hello-web` named "Hello Web" too: open the card whose Publisher is you. Also try the browse path: Store home → a card → its detail → the Publisher link → Back, with the search and filters still there.
6. **Install.** Install → the consent dialog lists the Declared Permissions → Install (enabled after a second). A toast says "Installed Hello Web".
7. **Launch and chat.** Library → Hello Web → Launch. Its window opens with the chat page; send a message. The answer comes from your model (the fake one repeats your message) and the page names the model, such as `ollama/qwen3:8b`. Launch hello-term too: a terminal window, where you type a message and `/quit`.
8. **Usage.** Usage shows a row for Hello Web with your model under it, "via Ollama" (your Connection), and one request per message.
9. **Library folders.** On the card's menu (⋯): Open data folder and Show logs open the Harness's folders in your file manager.
10. **Update.** In `~/hs-publish/hello-web/manifest.json` set `"version": "0.1.1"` (and add `"changelog": "## 0.1.1\n\n- Test update."`), publish it, then in Settings → Check for Harness updates → Check now. The Library card offers Update; close the Harness window first, then Update. A toast names the new version.
11. **Language.** Settings → Language → 简体中文: the app switches at once; a Harness launched afterwards gets `zh-CN`.
12. **Report.** On the card's menu or the Store detail page: Report → a reason → Submit. "Thanks, a reviewer will look at this."
13. **Uninstall.** Close the Harness window; card menu → Uninstall → Uninstall. Without other installs the Library reads "Nothing installed yet".

### 6. Take a Harness down as the administrator

There is no admin UI in P0; the admin CLI ([`apps/store` README](../../apps/store/README.md#admin-cli)) calls the Store as a profile with `is_admin`, set by hand:

```sh
docker exec supabase_db_harness-store psql -U postgres -c "update profiles set is_admin = true where github_login = '<your-login>'"
```

(`harness-store` is `project_id` in `apps/store/supabase/config.toml`; the login is lower case.) Then take the CLI's variables from the stack's status, in the same shell:

```sh
cd apps/store
node dist/scripts/supabase.js status      # API URL, service_role key, JWT secret
export STORE_URL=http://127.0.0.1:54321
export STORE_SERVICE_ROLE_KEY='<service_role key>'
export STORE_JWT_SECRET='<JWT secret>'
export STORE_ADMIN_LOGIN='<your-login>'
pnpm admin reports list --open
pnpm admin takedown <your-login>/hello-web --note "Taken down for a local test"
```

Install hello-web again first if you uninstalled it. After the takedown the Store no longer shows it; in the app, Settings → Check now, and the Library card shows the red takedown warning. Launch asks "This Harness was removed from the Store. Launch anyway?", and Launch anyway still runs it. On the Publish screen, My Harnesses shows it taken down with your note.

## Troubleshooting

### Sign-in on macOS

In development the `harnessstore://` scheme is registered to the Electron app under `apps/desktop/node_modules/electron`, and macOS may hand the callback to another copy (an older checkout, an installed Harness Store). If the app keeps waiting after you authorize, quit every Harness Store and Electron app and try again; else build and run the unpacked app, which registers the scheme itself:

```sh
pnpm build
pnpm --filter @harness-store/desktop exec electron-builder --dir
HARNESS_STORE_USER_DATA_DIR="$(mktemp -d)" "apps/desktop/release/mac-arm64/Harness Store.app/Contents/MacOS/Harness Store"
```

(`release/mac/` on an Intel Mac.) It also uses the local Store by default.

### Other problems

- **A keychain prompt for "Electron Safe Storage"** (or "Harness Store Safe Storage"). The app keeps API keys and the Publisher's session encrypted with the OS keychain; choose Always Allow. If you deny it, adding a key and signing in fail with an encryption error.
- **Ports.** 11434: Ollama or the fake one (`lsof -i :11434`); use `E2E_OLLAMA_PORT` for the automated journey. 54321 to 54324: the Supabase stack; another project's stack on them must be stopped (`supabase stop` in that project). `pnpm --filter @harness-store/store db:stop` stops this one.
- **Logs.** Each launch of a Harness logs to `logs/<publisher>/<slug>/<launch id>.log` in the app profile (Settings → Open logs folder, or the Library card's Show logs). The app's own errors are in the terminal running `pnpm dev`; the Edge Functions' in the terminal running `functions:serve`. Settings → Copy diagnostics gives the version, folders and Gateway status.
- **Reset the local Store.** `pnpm --filter @harness-store/store db:reset` (everything, then the seed), or `pnpm --filter @harness-store/store seed` (the catalogue only). A schema error after a pull usually means a migration changed: reset.
- **A fresh app.** Start with a new `HARNESS_STORE_USER_DATA_DIR`, or delete the profile folder; Settings → Re-run setup reopens the wizard without deleting anything.
- **`pnpm ci:local store-tests`** stops the stack and deletes its data, and leaves the fake GitHub configured: run `db:start` again afterwards.
- **Publishing refused.** `publisher_mismatch`: the Harness ID does not start with your login. `version_not_greater`: that version, or a later one, is already published; raise `version`. `rate_limited`: 20 versions a day per Publisher.
