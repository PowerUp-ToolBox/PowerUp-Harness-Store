# Key User Flows

Each flow lists steps, decision points and error branches. Screen details are in `screens.md`. Vocabulary follows `CONTEXT.md`.

## F1. First run

1. Welcome screen: one paragraph on what Harness Store is, language selector prefilled from the OS locale (en / zh-CN). Button: Continue. Link: Skip setup.
2. Local Provider detection: the app probes Ollama and LM Studio on their default ports for a few seconds with a visible progress indicator.
   - Found → list each with its models; toggle "Add" per Provider (on by default). Continue.
   - Not found → short note with links to install Ollama or LM Studio; Continue.
3. Optional remote Provider: choose a Provider from presets (Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Qwen, Moonshot, Zhipu, MiniMax, Doubao, Groq, custom OpenAI-compatible), paste an API key, Test connection.
   - Test succeeds → Connection saved, model list loaded where supported.
   - Test fails → error inline with the Provider's message; options Retry, Edit, Skip.
4. Bind the `default` Slot: a single picker over the models of the Connections added in this run, grouped by Connection, with "Type a model name"; preselects the first local model if any, else the first remote model. Skip allowed.
5. Done screen summarising Connections and the Default Model. Button: Open Store. Lands on Store home.

**Decision points:** every step has Skip. If the wizard ends with no Connection, the Store still works; Install is allowed; Launch is blocked with "Set up a model first" (see F3).

## F2. Browse and install

1. Store home: a filter row (search box, tag chips, "My platform only") over the Featured row and the "New" and "Most downloaded" lists. Text or a tag shows ranked results in place of the lists; Back from a detail page keeps the search.
2. Open a detail page (from any list, search results, a Publisher page, or a Library card's View in Store).
3. Primary button state depends on platform and install status (design-principles §3). Click Install.
4. Download with progress on the button; cancel allowed. Integrity check after download.
   - Integrity mismatch → error "The downloaded package did not match the Store's checksum", Retry.
5. Consent dialog:
   - Declared Permissions with the red/yellow/green scale and concrete sentences.
   - Runtime kind (Node on bundled runtime, or native executable), UI Kind, Workspace requirement, platforms.
   - Standing no-sandbox sentence.
   - Buttons: Install (primary, enabled after a short read delay of one second), Cancel.
6. Installed: button becomes Launch; Library gains a card; toast "Installed Hello Web".

**Error branches:** offline → the Store's offline panel ("Can't reach the Store", Retry) replaces its pages; Library and Models keep working. Server error → inline error, Retry. Unsupported platform → disabled "Not available for your platform" with this machine's platform badge greyed. Not in the Store any more → "This Harness is no longer available" with the disabled "Removed from Store" (an installed copy keeps its page, with Launch).

## F3. Launch

1. Click Launch (Library card or detail page). A Harness whose Manifest does not list this platform shows the disabled "Not available for your platform" instead.
2. Connection check: if no Slot Binding can fill the `default` Slot → the button reads "Set up a model first" and opens the Models page at this Harness's card; launch aborts.
3. Workspace:
   - `required` → Workspace sheet in the main window, last used folder preselected, Choose folder opens the native dialog; Cancel aborts launch.
   - `optional` → same sheet with "Continue without a folder".
   - `none` → skipped.
4. Process starts; card shows "Starting…".
   - Web UI Kind → window opens immediately on its Starting state (elapsed seconds, Cancel) and shows the Harness's page once it accepts connections. Timeout → the window shows "{name} did not start in time" with its last 50 lines of output, Show logs, Relaunch and Close (no separate dialog).
   - Terminal UI Kind → window with embedded terminal opens immediately.
5. During run, card shows "Running…" with "Show window"; both bring the window to the front. Only one instance per Harness; a second Launch focuses the existing window.
6. Model call fails because a Slot is unbound → desktop notification "Hello Web needs a model for its `fast` Slot" with action "Open Models"; the Harness receives an error it can display.
7. Close window → the window closes, card shows "Stopping…" while the process is asked to stop, then forced after a few seconds. There is no separate Stop action.
8. Process exits by itself → its window stays open and readable with the exit code, Relaunch and Close. Non-zero exit → card shows "Exited with an error" ("Did not start in time" after a timeout, "Could not start" when it never started) with Show logs and Dismiss, until dismissed; Launch retries.

## F4. Update

1. On app start and periodically, the Runtime checks the Store for newer published versions. Library cards and a badge on the Library nav item show available updates.
2. Click Update.
   - No change in Declared Permissions or Entry → download, verify, replace, done. Toast with the version and a link to the changelog.
   - Added permission, changed Entry or changed runtime kind → re-consent prompt listing exactly what changed (diff style: "New: runs shell commands"), the changelog, and buttons Update, Not now.
3. A Harness that is running cannot be updated; the button explains "Close the Harness to update".
4. An installed version that was Unpublished or taken down remains launchable; the card shows a note "No longer available in the Store" and Update is hidden.

## F5. Publish

1. Publish screen requires sign-in. Not signed in → GitHub sign-in button and a one-paragraph explanation that only Publishers need an account. Sign-in opens the browser and returns to the app; while it waits, Cancel stops it. Signed in → avatar, login, the Harness ID prefix the Store expects (`<login>/`) and Sign out, then the tabs "New version" and "My Harnesses".
2. Choose a folder (button or drag and drop).
3. Local validation runs immediately, on the Harness Package the upload will send: the app builds it from the folder (leaving out `.git`, `node_modules/.cache/`, `.DS_Store`, `Thumbs.db`, `*.swp` and what a root `.harnessignore` names) and validates that zip as the Store will, including the Publisher's earlier versions of the Harness. Problems appear as a list ordered by field path, with a plain message and the code; warnings are listed apart and never block. The Continue button stays disabled until the problem list is empty. Re-validation happens when the folder changes on disk (Re-check button also available).
   - Version not greater than the last published → problem naming the last version.
   - ID publisher segment does not match the signed-in login → problem with the expected publisher.
   - The Store could not be asked for earlier versions → a note that the Store checks again on upload; it does not block.
4. Review step: read-only facts from the Manifest (ID, version, name, summary, platforms, permissions), the changelog if present, what was left out of the package, its size (warning above 100 MiB), then how the listing will look (card and detail page, including the trust block), with Publish and Back. Nothing is editable in P0.
5. Upload with progress; Cancel while the package is still being sent, which returns to the review with "Upload cancelled". Once it is all sent, "Processing…" without Cancel.
   - Store refuses → its message in the UI language, its code and any problems it found, with Retry.
   - Session expired → "Sign in again"; the folder stays chosen and is validated again after signing in.
6. Success: link to the listing, "Publish another", and a reminder that published versions are immutable.

The screen keeps its folder, validation and tab when the User visits another screen and comes back. Offline, Sign in, Publish and Unpublish are disabled with an explanation.

**Unpublish:** from the "My Harnesses" tab (each Harness with its versions, status, downloads, and the administrator's note on taken-down versions), per published version, with a confirmation naming the version and stating that existing installs keep working.

**Local test install:** the Publish screen offers "Install this folder locally" to install and launch without uploading, signed out and offline too. The folder is validated (problems and warnings listed, Re-check), then the install consent dialog opens, and only Install copies it; success shows "Installed {name} {version} from the folder. It is marked Local in the Library." with a link to the Library. Such installs are marked "Local" in the Library and are not updatable from the Store; installing again from the folder replaces the installed version, higher or lower.

## F6. Manage Connections and Slot Bindings (Models page)

1. Connections list: each with Provider name, status (Connected, Local, Error), model count, Test, Edit, Remove. "Add Connection" opens the preset picker (same set as F1 step 3).
2. Add: choose preset → key and/or base URL fields with placeholder and link to the Provider's key page → Test → Save. Custom OpenAI-compatible allows a display name and several endpoints.
3. Default Models: `default` first, then one row per other Slot name that is bound globally or declared by an installed Harness, each with a model picker grouped by Connection. Requirement warnings appear when a chosen model is known not to meet the requirements of some installed Harness's Slot with that name ("This model may not meet the requirements of Code Reviewer's `default` Slot (tool calling)."); a model whose capabilities are unknown gets a muted "Capabilities unknown" note instead.
4. Per-Harness Model Overrides: expandable section per installed Harness listing its Slots with description, requirements, Recommended Models, what it currently resolves to and why ("Override", "Recommended", "Default"; a Default Model of the same Slot name and the `default` one both read "Default"; "No Connection can fill this Slot" when nothing does), and a picker to override or clear. The link `models?harness=<id>` (Library card menu, "Set up a model first", a Harness window's model indicator) opens that Harness's section.
5. Manual entry: any picker has "Type a model name" for Providers without listing.
6. Removing a Connection that some Slot Binding uses shows the affected Slots and asks to confirm; affected Slots fall back per resolution order.

## F7. Usage review

1. Usage page: totals for the selected period (today, 7 days, 30 days, all), then a table grouped by Harness, then by model, with prompt and completion tokens, request count and last used.
2. Rows with unknown token counts show a dash and a tooltip "This Provider did not report usage".
3. Filter by Harness or Provider. Export to CSV. Clear usage data (confirm).

## F8. Report a Harness

1. Report link on the detail page (and in the Library card menu).
2. Reason picker: Malicious behaviour, Bypasses the Model Gateway, Broken, Inappropriate content, Spam, Other (one per `report_reason` value in `docs/tech/data-model.md`). Free-text details. Optional email for follow-up.
3. Submit anonymously; confirmation "Thanks, a reviewer will look at this". Repeated reports on the same Harness from the same install are rate limited with a gentle message.

## F9. Uninstall

1. From the Library card menu or the detail page secondary menu.
2. Confirmation names the Harness and states "This deletes its data directory (size shown). Files in your own folders are not touched."
3. If running → "Close the Harness first".
4. Done: card removed; toast with Undo unavailable (deletion is immediate) so the confirmation is explicit.
