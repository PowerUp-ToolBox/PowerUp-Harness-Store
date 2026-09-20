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
4. Bind the `default` Slot: a single picker over all reachable models grouped by Connection; preselects the first local model if any, else the first remote model. Skip allowed.
5. Done screen summarising Connections and the Default Model. Button: Open Store. Lands on Store home.

**Decision points:** every step has Skip. If the wizard ends with no Connection, the Store still works; Install is allowed; Launch is blocked with "Set up a model first" (see F3).

## F2. Browse and install

1. Store home: Featured row, tag chips, "New" and "Most downloaded" lists. Search box in the header.
2. Open a detail page (from any list or search results).
3. Primary button state depends on platform and install status (design-principles §3). Click Install.
4. Download with progress on the button; cancel allowed. Integrity check after download.
   - Integrity mismatch → error "The downloaded package did not match the Store's checksum", Retry.
5. Consent dialog:
   - Declared Permissions with the red/yellow/green scale and concrete sentences.
   - Runtime kind (Node on bundled runtime, or native executable), UI Kind, Workspace requirement, platforms.
   - Standing no-sandbox sentence.
   - Buttons: Install (primary, enabled after a short read delay of one second), Cancel.
6. Installed: button becomes Launch; Library gains a card; toast "Installed Hello Web".

**Error branches:** offline at step 3 → Install disabled with banner. Server error → inline error, Retry. Unsupported platform → disabled button with the platform badges greyed.

## F3. Launch

1. Click Launch (Library card or detail page).
2. Connection check: if no Slot Binding can fill the `default` Slot → dialog "Set up a model first" with a button to the Models page; launch aborts.
3. Workspace:
   - `required` → folder picker, last used folder preselected; Cancel aborts launch.
   - `optional` → picker with "Continue without a folder".
   - `none` → skipped.
4. Process starts; card shows "Starting…".
   - Web UI Kind → window opens when the Harness accepts connections. Timeout → dialog "The Harness did not start in time" with Show logs and Close.
   - Terminal UI Kind → window with embedded terminal opens immediately.
5. During run, card shows "Running…" with "Show window". Only one instance per Harness; a second Launch focuses the existing window.
6. Model call fails because a Slot is unbound → desktop notification "Hello Web needs a model for its `fast` Slot" with action "Open Models"; the Harness receives an error it can display.
7. Close window → process is asked to stop, then forced after a few seconds. Non-zero exit → card shows "Exited with an error" and a Show logs link until dismissed.

## F4. Update

1. On app start and periodically, the Runtime checks the Store for newer published versions. Library cards and a badge on the Library nav item show available updates.
2. Click Update.
   - No change in Declared Permissions or Entry → download, verify, replace, done. Toast with the version and a link to the changelog.
   - Added permission, changed Entry or changed runtime kind → re-consent prompt listing exactly what changed (diff style: "New: runs shell commands"), the changelog, and buttons Update, Not now.
3. A Harness that is running cannot be updated; the button explains "Close the Harness to update".
4. An installed version that was Unpublished or taken down remains launchable; the card shows a note "No longer available in the Store" and Update is hidden.

## F5. Publish

1. Publish screen requires sign-in. Not signed in → GitHub sign-in button and a one-paragraph explanation that only Publishers need an account. Sign-in opens the browser and returns to the app.
2. Choose a folder (button or drag and drop).
3. Local validation runs immediately. Problems appear as a list with the field path and a plain message; the Continue button stays disabled until the list is empty. Re-validation happens when the folder changes on disk (Re-check button also available).
4. Metadata form, prefilled from the Manifest and read-only for fields that come from it (ID, version, name, summary, platforms, permissions). Editable: nothing in P0 beyond confirming; changelog is shown if present.
5. Review step: how the listing will look, including the trust block.
6. Upload with progress; cancel allowed before completion.
   - Version not greater than the last published → error naming the last version.
   - ID publisher segment does not match the signed-in login → error with the expected prefix.
   - Server rejects → verbatim message with Retry.
7. Success: link to the listing, "Publish another", and a reminder that published versions are immutable.

**Unpublish:** from the Publisher's own listing, per version, with confirmation naming the version and stating that existing installs keep working.

**Local test install:** the Publish screen offers "Install this folder locally" to install and launch without uploading; such installs are marked "Local" in the Library and are not updatable from the Store.

## F6. Manage Connections and Slot Bindings (Models page)

1. Connections list: each with Provider name, status (Connected, Local, Error), model count, Test, Edit, Remove. "Add Connection" opens the preset picker (same set as F1 step 3).
2. Add: choose preset → key and/or base URL fields with placeholder and link to the Provider's key page → Test → Save. Custom OpenAI-compatible allows a display name and several endpoints.
3. Default Models: one row per Slot name seen across installed Harnesses plus `default`, each with a model picker grouped by Connection. Requirement warnings appear when a chosen model is known not to meet the requirements of some installed Harness's Slot with that name ("Code Reviewer's `default` Slot asks for tool calling; this model may not support it").
4. Per-Harness Model Overrides: expandable section per installed Harness listing its Slots with description, requirements, Recommended Models, what it currently resolves to and why ("Override", "Recommended", "Default"), and a picker to override or clear.
5. Manual entry: any picker has "Type a model name" for Providers without listing.
6. Removing a Connection that some Slot Binding uses shows the affected Slots and asks to confirm; affected Slots fall back per resolution order.

## F7. Usage review

1. Usage page: totals for the selected period (today, 7 days, 30 days, all), then a table grouped by Harness, then by model, with prompt and completion tokens, request count and last used.
2. Rows with unknown token counts show a dash and a tooltip "This Provider did not report usage".
3. Filter by Harness or Provider. Export to CSV. Clear usage data (confirm).

## F8. Report a Harness

1. Report link on the detail page (and in the Library card menu).
2. Reason picker: Malicious behaviour, Bypasses the Model Gateway, Misleading listing, Broken, Other. Free-text details. Optional email for follow-up.
3. Submit anonymously; confirmation "Thanks, a reviewer will look at this". Repeated reports on the same Harness from the same install are rate limited with a gentle message.

## F9. Uninstall

1. From the Library card menu or the detail page secondary menu.
2. Confirmation names the Harness and states "This deletes its data directory (size shown). Files in your own folders are not touched."
3. If running → "Close the Harness first".
4. Done: card removed; toast with Undo unavailable (deletion is immediate) so the confirmation is explicit.
