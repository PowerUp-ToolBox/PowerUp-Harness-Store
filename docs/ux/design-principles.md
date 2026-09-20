# UX Design Principles

Harness Store borrows its information architecture from Steam and the Apple App Store: a **Store** where you discover and a **Library** where you own and launch. Vocabulary follows `CONTEXT.md`.

## 1. Information architecture

**Two halves, never mixed.**

- **Library**: what the User has installed. Launch, update, uninstall, per-Harness Model Overrides. Works fully offline.
- **Store**: what exists. Featured, search, tags, detail pages, Publisher pages. Requires network; degrades to a clear offline state.

Supporting screens: **Models** (Connections and Slot Bindings), **Publish** (Publisher tools), **Usage**, **Settings**. Left sidebar navigation in this order: Library, Store, Models, Publish, Usage, Settings. Library is the default landing screen after first run; the first-run wizard ends on Store home because a new User owns nothing yet.

**A Harness is an app, not a page.** Launching opens a separate window with the Harness's own UI (web or terminal). The main window never hosts a conversation. The main window may stay open behind a Harness window; closing the Harness window ends the Harness process.

## 2. Detail page anatomy (Store)

From top to bottom, mirroring an App Store product page:

1. **Header**: icon, name, Publisher (link), one-line summary, primary action button (see §3), download count, platform badges greyed out for platforms not supported.
2. **Screenshots** strip (up to five), horizontally scrollable.
3. **Trust block** (always above the fold on desktop widths): Declared Permissions on the red/yellow/green scale, runtime kind (Node or binary), UI Kind, Workspace requirement, and the standing sentence "Harness Store does not sandbox Harnesses. Installing means trusting this Publisher."
4. **Models block**: each Model Slot with its description, Model Requirements and Recommended Models; a live note per Slot showing what it would bind to on this machine ("Will use: Ollama · qwen3:8b" or "No Connection can fill this Slot").
5. **Description** (Publisher's README).
6. **Version history** with changelogs, newest first; the currently installed version marked.
7. **Footer**: license, homepage, source link, Report link.

## 3. Primary action button states

The button in the header and on Library cards is one control with mutually exclusive states. Copy is shown in en / zh-CN.

| State | Label | When |
|---|---|---|
| Install | Install / 安装 | Not installed, platform supported |
| Unsupported | Not available for your platform / 不支持当前平台 (disabled) | Platform not in Manifest |
| Downloading | Downloading 42% / 下载中 42% (progress, cancel) | Transfer in progress |
| Needs consent | Review and install / 查看权限并安装 | Download complete, consent pending |
| Installed | Launch / 启动 | Installed, no newer version |
| Update available | Update / 更新 (secondary: Launch) | Newer published version |
| Needs re-consent | Review update / 查看更新 | Newer version changed permissions or Entry |
| Running | Running… / 运行中… (secondary: Show window) | Process alive |
| Requires Connection | Set up a model first / 先设置模型 | No Connection can fill the `default` Slot |

Buttons never change meaning mid-hover; state transitions animate the label, not the position.

## 4. Trust messaging

- Say what will happen, in the User's language, before it happens. Consent screens list Declared Permissions with concrete nouns: "Read and write files in the folder you choose", not "filesystem: workspace".
- Severity scale: **green** for none / Data Directory only, **yellow** for Workspace or listed domains, **red** for home directory, shell or any-network. Red items get an icon and a one-line consequence.
- Never soften the lack of a sandbox. The sentence "Harness Store does not sandbox Harnesses. Installing means trusting this Publisher." appears on the detail page, the consent dialog and the re-consent prompt, unchanged.
- Credentials messaging is equally plain: "Your API keys stay in Harness Store. Harnesses never see them."

## 5. Copywriting rules

- Every user-facing string exists in **en** and **zh-CN** from the first commit. No string ships in one language.
- Use `CONTEXT.md` nouns in UI copy: Harness, Publisher, Connection, Model Slot. Never "app", "plugin", "account", "key" as nouns for these concepts. Chinese equivalents are fixed: Harness → Harness（不翻译）, Publisher → 发布者, Connection → 模型连接, Model Slot → 模型槽位, Slot Binding → 槽位绑定, Workspace → 工作目录, Data Directory → 数据目录, Declared Permission → 声明权限, Model Gateway → Model Gateway（不翻译）.
- Warnings state the consequence, then the action: "This Harness runs shell commands on your machine. Only install it if you trust the Publisher."
- Errors name the thing that failed and the next step. Provider errors are quoted verbatim below the plain explanation, never instead of it.
- Sentence case for buttons and headings in English; no exclamation marks; no marketing adjectives on system copy.

## 6. Accessibility basics

- Keyboard reachable: every action has a focus state and a key path; the sidebar, lists and dialogs follow standard tab order; Escape closes dialogs.
- Colour is never the only signal: the permission scale pairs colour with an icon and a label.
- Minimum body text 14 px, contrast at least 4.5:1 in light and dark themes; both themes ship in P0 following the OS setting.
- Progress and long operations announce state to assistive technology; terminal windows expose the process name and exit status in the window title.
- Chinese and English layouts are tested together; labels wrap rather than truncate.

## 7. Empty, loading, error and offline states

- **Empty** states explain what the screen will hold and offer the one action that fills it (Library empty → "Browse the Store"; Models empty → "Add a Connection"; Usage empty → "Launch a Harness to see usage here").
- **Loading** uses skeletons for lists and inline spinners for buttons; never a full-screen blocker except during first-run Provider detection (bounded to a few seconds with a skip).
- **Error** states are inline, keep the User's input, and offer Retry. Network errors in the Store distinguish "offline" from "server error".
- **Offline**: Library, Models, Usage and Settings work entirely. Store shows the last fetched lists with an offline banner and disables Install. Publish is disabled with an explanation.
- Destructive actions (uninstall deletes the Data Directory, Unpublish) always confirm and name what is lost.
