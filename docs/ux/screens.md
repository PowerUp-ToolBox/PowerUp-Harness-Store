# Screen Specifications

One entry per screen. Each gives purpose, primary elements, states, key copy (en / zh-CN) and the owning spec ID from `roadmap.md`. Shared rules are in `design-principles.md`; flows are in `flows.md`.

---

## Main window shell — owner P0-04

**Purpose.** Frame for all main screens: sidebar navigation, header with search (Store only), offline banner, update badge.

**Elements.** Sidebar items in order: Library, Store, Models, Publish, Usage, Settings. Header: page title, contextual search. Global toast area bottom-right.

**States.** Offline → persistent banner "You're offline. Library and Models still work." / "当前离线。资源库和模型页仍可使用。" Update badge on Library when any installed Harness has an update.

**Key copy.** Library / 资源库 · Store / 商店 · Models / 模型 · Publish / 发布 · Usage / 用量 · Settings / 设置.

---

## First-run wizard — owner P0-04 (Connection steps use P0-03)

**Purpose.** Get a new User to a bound `default` Slot in under three minutes, or let them skip.

**Elements.** Five steps with a progress indicator: Welcome and language → Local Providers → Remote Provider (optional) → Default model → Done. Every step has Skip.

**States.** Detection in progress (bounded spinner with Skip). Nothing detected (install links). Test failed (inline error, Retry / Edit / Skip).

**Key copy.**
- "Run any AI agent on any model you already have." / "用你已有的任何模型运行任何 AI Agent。"
- "Looking for Ollama and LM Studio…" / "正在查找 Ollama 和 LM Studio…"
- "Your API keys stay in Harness Store. Harnesses never see them." / "你的 API key 只保存在 Harness Store 中，Harness 无法看到。"
- "Choose the model Harnesses use by default" / "选择 Harness 默认使用的模型"
- Skip / 跳过 · Continue / 继续 · Open Store / 打开商店

---

## Library — owner P0-10 (local installs surfaced by P0-05)

**Purpose.** Everything installed; launch, update, uninstall, open per-Harness settings.

**Elements.** Grid or list of cards: icon, name, Publisher, installed version, primary action button (see design-principles §3), overflow menu (Show in Store, Model Overrides, Show logs, Uninstall). Sort: recently used, name. Filter: Updates available, Running, Local installs.

**States.** Loading skeleton. Empty: illustration, "Nothing installed yet" with "Browse the Store". Card error: "Exited with an error" with Show logs. Card note: "No longer available in the Store" for unpublished or taken-down versions. Local install badge: "Local".

**Key copy.** Launch / 启动 · Update / 更新 · Running… / 运行中… · Show window / 显示窗口 · Uninstall / 卸载 · "Nothing installed yet" / "还没有安装任何 Harness" · "Browse the Store" / "去商店看看" · "Close the Harness to update" / "请先关闭该 Harness 再更新".

---

## Store home — owner P0-09

**Purpose.** Discovery entry point.

**Elements.** Featured row (administrator-curated), tag chips, sections "New" and "Most downloaded", each card: icon, name, Publisher, summary, platform badges, download count.

**States.** Loading skeletons per section. Offline: last fetched content with banner, Install disabled. Server error: inline message with Retry. Empty section hidden.

**Key copy.** Featured / 精选 · New / 最新 · Most downloaded / 下载最多 · "Couldn't load the Store" / "无法加载商店" · Retry / 重试.

---

## Store search and results — owner P0-09

**Purpose.** Find a Harness by name, summary, tag or Publisher.

**Elements.** Search input in header with debounce, tag filter chips, platform filter (defaults to "My platform"), result list reusing Store cards, result count.

**States.** Typing (skeleton after debounce). No results: "No Harnesses match" with suggestion to clear filters. Error: inline Retry.

**Key copy.** Search Harnesses / 搜索 Harness · My platform only / 仅显示支持当前平台 · "No Harnesses match" / "没有匹配的 Harness" · Clear filters / 清除筛选.

---

## Harness detail — owner P0-09 (install actions P0-10, Report P0-12)

**Purpose.** Decide whether to install; see trust information before committing.

**Elements.** Header (icon, name, Publisher link, summary, primary button, downloads, platform badges), screenshots, trust block (Declared Permissions scale, runtime kind, UI Kind, Workspace, standing no-sandbox sentence), Models block (per Slot: description, requirements, Recommended Models, "Will use" note), README, version history with changelogs, footer (license, homepage, source, Report).

**States.** Loading. Unsupported platform (disabled button, badges greyed). Installed (Launch, installed version highlighted in history). Update available. Running. "Set up a model first" when no Connection can fill `default`. Taken down: 404 page "This Harness is no longer available".

**Key copy.**
- "Harness Store does not sandbox Harnesses. Installing means trusting this Publisher." / "Harness Store 不会隔离 Harness 进程。安装即代表你信任该发布者。"
- Permissions / 声明权限 · Runs shell commands / 会执行命令行命令 · Reads and writes files in the folder you choose / 读写你选择的工作目录 · Accesses your home folder / 访问你的用户主目录 · Connects to the internet (any site) / 访问任意网站 · Connects to: … / 访问以下网站：…
- Will use: … / 将使用：… · "No Connection can fill this Slot" / "没有模型连接可以填充此槽位"
- Version history / 版本历史 · Source / 源码 · Report / 举报

---

## Publisher page — owner P0-09

**Purpose.** All Harnesses by one Publisher, with identity from GitHub.

**Elements.** Avatar, GitHub login, link to GitHub profile, join date, list of Harnesses (Store cards), total downloads.

**States.** Loading. Empty (Publisher with everything unpublished): "No published Harnesses". Error: Retry.

**Key copy.** Harnesses by … / … 发布的 Harness · Total downloads / 总下载量.

---

## Install consent dialog — owner P0-10

**Purpose.** Informed consent before a downloaded package is installed.

**Elements.** Title with Harness name and version. Declared Permissions list with icon, colour and plain sentence per item. Facts row: runtime kind, UI Kind, Workspace, platform. Standing no-sandbox sentence. Buttons: Cancel, Install (enabled after one second).

**States.** Only one; long permission lists scroll inside the dialog.

**Key copy.** "Install Hello Web 0.1.0?" / "安装 Hello Web 0.1.0？" · Runs on the bundled Node runtime / 运行在内置 Node 运行时 · Native executable / 原生可执行文件 · Opens as a window / 以窗口形式打开 · Opens in a terminal / 在终端中打开 · Needs a folder to work in / 需要选择一个工作目录 · Install / 安装 · Cancel / 取消.

---

## Update prompt — owner P0-10

**Purpose.** One-click update, or re-consent when trust facts changed.

**Elements.** Version from → to, changelog, and when applicable a "What changed" list showing only added permissions or Entry/runtime changes, each marked New. Standing sentence when re-consent is required. Buttons: Update, Not now.

**States.** Simple update (no changed facts). Re-consent required. Blocked because running.

**Key copy.** "Update available: 0.2.0" / "有可用更新：0.2.0" · What changed / 权限变化 · New: runs shell commands / 新增：会执行命令行命令 · Update / 更新 · Not now / 暂不.

---

## Workspace picker — owner P0-05

**Purpose.** Choose the folder a Harness works in, when its Manifest asks for one.

**Elements.** Native folder dialog preceded by a small sheet: why the Harness needs a folder (from the Manifest description if present), last used folder preselected, Choose folder, and for `optional` a "Continue without a folder" button.

**States.** Required (Cancel aborts launch). Optional. Last folder missing → note "The last folder no longer exists".

**Key copy.** "Choose a folder for Code Reviewer" / "为 Code Reviewer 选择工作目录" · Choose folder / 选择文件夹 · Continue without a folder / 不选择目录继续 · "The Harness can read and write files in this folder." / "该 Harness 可以读写此目录中的文件。"

---

## Harness web window chrome — owner P0-05

**Purpose.** Host a web UI Kind Harness as its own app window.

**Elements.** Window title "Harness name — Harness Store". Thin top bar: Harness icon and name, model indicator per Slot in use (updates live, click opens Models page for this Harness), Reload, Open logs. Content area is the Harness's page.

**States.** Starting (centered "Starting Hello Web…" with elapsed seconds and Cancel). Ready. Crashed (overlay "Hello Web stopped unexpectedly" with Show logs, Relaunch, Close). Timed out (same overlay with the timeout message).

**Key copy.** Starting … / 正在启动 … · "did not start in time" / "启动超时" · Show logs / 查看日志 · Relaunch / 重新启动 · Model: … / 模型：….

---

## Harness terminal window — owner P0-05

**Purpose.** Host a terminal UI Kind Harness.

**Elements.** Window title with Harness name and, on exit, the exit code. Embedded terminal filling the window; same thin top bar as the web window (model indicator, logs). Font size follows Settings.

**States.** Running. Exited (terminal stays readable, top bar shows "Exited with code N", buttons Relaunch, Close).

**Key copy.** "Exited with code 1" / "已退出，退出码 1" · Relaunch / 重新启动 · Close / 关闭.

---

## Models — owner P0-03

**Purpose.** Manage Connections, Default Models and per-Harness Model Overrides.

**Elements.** Section Connections (list with status, Test, Edit, Remove; Add Connection). Section Default Models (row per Slot name with picker and requirement warnings). Section Per-Harness Overrides (expandable per installed Harness: Slots, description, requirements, resolution reason, picker, Clear override). Every picker has "Type a model name".

**States.** Empty Connections: "Add a Connection to run Harnesses". Detecting local Providers (inline spinner in Add sheet). Test in progress / succeeded / failed with Provider message. Requirement warning (yellow, non-blocking). Remove Connection confirmation naming affected Slots.

**Key copy.**
- Add Connection / 添加模型连接 · Test connection / 测试连接 · Connected / 已连接 · Local / 本地 · Connection failed / 连接失败
- Default Models / 默认模型 · Overrides for this Harness / 此 Harness 的槽位覆盖 · Uses: Recommended / 来源：推荐模型 · Uses: Default / 来源：默认模型 · Uses: Override / 来源：手动覆盖 · Clear override / 清除覆盖
- "This model may not meet the requirements of …'s `default` Slot (tool calling)." / "此模型可能不满足 … 的 `default` 槽位要求（工具调用）。"
- Type a model name / 手动输入模型名称

---

## Publish — owner P0-08 (GitHub import added by P0.5-03)

**Purpose.** Publish a Harness from a local folder; manage own listings.

**Elements.** Signed-out: GitHub sign-in card. Signed-in: tabs "New version" and "My Harnesses". New version: folder drop zone, validation problem list (path, message), Continue, metadata review (read-only facts from Manifest, changelog), listing preview, Publish with progress. Secondary: "Install this folder locally". My Harnesses: list of own Harnesses and versions with download counts and Unpublish per version.

**States.** Signed out. Validating. Problems present (Continue disabled). Uploading (cancel). Rejected by server (verbatim message, Retry). Success (listing link). Offline (Publish disabled with explanation). Unpublish confirmation.

**Key copy.**
- "Only Publishers need to sign in. Browsing and installing never require an account." / "只有发布者需要登录，浏览和安装永远不需要账号。"
- Sign in with GitHub / 使用 GitHub 登录 · Choose a folder / 选择文件夹 · Drop a Harness folder here / 将 Harness 文件夹拖到这里
- "1 problem must be fixed before publishing" / "发布前需修复 1 个问题" · Re-check / 重新检查
- "Version 0.1.0 is not greater than the last published version 0.2.0" / "版本 0.1.0 不高于已发布的 0.2.0"
- Publish / 发布 · "Published! Versions are immutable; publish a new version to change anything." / "发布成功！已发布版本不可修改，如需变更请发布新版本。"
- Install this folder locally / 本地安装此文件夹 · Unpublish / 撤下 · "Existing installs keep working." / "已安装的用户不受影响。"

---

## Usage — owner P0-11

**Purpose.** Show tokens consumed through the Model Gateway, locally.

**Elements.** Period selector (Today, 7 days, 30 days, All), totals (requests, prompt tokens, completion tokens), table grouped by Harness then model with last used, filters by Harness and Provider, Export CSV, Clear usage data.

**States.** Empty: "Launch a Harness to see usage here". Unknown counts shown as a dash with tooltip. Clear confirmation.

**Key copy.** Requests / 请求数 · Prompt tokens / 输入 token · Completion tokens / 输出 token · Last used / 最近使用 · "This Provider did not report usage" / "该 Provider 未返回用量信息" · Export CSV / 导出 CSV · Clear usage data / 清除用量数据.

---

## Settings — owner P0-11

**Purpose.** App-level preferences.

**Elements.** Language (System, English, 简体中文). Appearance (System, Light, Dark). Local Provider detection on startup (toggle). Terminal font size. Data location (path display, Open folder, Move… deferred if complex). Check for Harness updates (interval and Check now). About (version, licenses). Sign out (when signed in). Danger zone: Reset app (confirm).

**States.** Language change applies immediately with a note that running Harnesses keep their launch locale until relaunched.

**Key copy.** Language / 语言 · Appearance / 外观 · Detect local Providers on startup / 启动时检测本地模型 · Data location / 数据位置 · Check now / 立即检查 · Sign out / 退出登录 · Reset app / 重置应用.

---

## Report dialog — owner P0-12

**Purpose.** Let any User flag a Harness for review.

**Elements.** Reason radio list (Malicious behaviour, Bypasses the Model Gateway, Misleading listing, Broken, Other), details text area, optional contact email, Submit.

**States.** Submitting. Sent confirmation. Rate limited ("You've already reported this Harness recently").

**Key copy.** Report … / 举报 … · Malicious behaviour / 恶意行为 · Bypasses the Model Gateway / 绕过 Model Gateway · Misleading listing / 描述不实 · Broken / 无法使用 · "Thanks, a reviewer will look at this." / "感谢反馈，审核人员会尽快查看。"
