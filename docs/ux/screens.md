# Screen Specifications

One entry per screen. Each gives purpose, primary elements, states, key copy (en / zh-CN) and the owning spec ID from `roadmap.md`. Shared rules are in `design-principles.md`; flows are in `flows.md`.

---

## Main window shell — owner P0-04

**Purpose.** Frame for all main screens: sidebar navigation, header, offline banner, update badge.

**Elements.** Sidebar items in order: Library, Store, Models, Publish, Usage, Settings. Header: page title (the Store's search sits in its own filter row, see Store home). Global toast area bottom-right.

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

**Elements.** Grid or list of cards: icon, name, Publisher, installed version, last launched date (none when never launched), primary action button (see design-principles §3; its states are the card's status, with no separate label), overflow menu (View in Store, Model Overrides, Show logs, Open data folder, Uninstall). The Publisher links to their Publisher page. Above the cards: a name filter, views All, Updates available, Running, Local installs, and Sort: Recently used (last launched, then name; default), Name; all work on the list already loaded. Uninstall opens a confirmation: "Uninstall {name}?", the Data Directory's size, Cancel and Uninstall (danger); while the Harness runs it says "Close the Harness first" with only Close. P0-05 builds the cards (ordered recently launched first, then name), Model Overrides, Show logs and Open data folder; P0-09 adds View in Store (the Harness's detail page) and the Publisher link; P0-10 adds the rest.

**States.** Loading skeleton ("Loading your Library"). No card in the view: "No Harnesses in this view" with Clear filters. Empty: illustration, "Nothing installed yet" with "Browse the Store". Card error: "Exited with an error" (or "Did not start in time", "Could not start") with Show logs and Dismiss; the button stays Launch. No error for a cancelled Workspace, an unsupported platform or a missing model. Card note: "No longer available in the Store" for unpublished or taken-down versions. Local install badge: "Local".

**Key copy.** Launch / 启动 · Update / 更新 · Running… / 运行中… · Show window / 显示窗口 · Stopping… / 正在停止… · Uninstall / 卸载 · Local / 本地 · Model Overrides / 槽位覆盖 · View in Store / 在商店中查看 · Show logs / 查看日志 · Open data folder / 打开数据目录 · Dismiss / 忽略 · "Exited with an error" / "异常退出" · "Did not start in time" / "启动超时" · "Could not start" / "无法启动" · "Nothing installed yet" / "还没有安装任何 Harness" · "Browse the Store" / "去商店看看" · "Close the Harness to update" / "请先关闭该 Harness 再更新" · Review update / 查看更新 · Last launched {date} / 上次启动：{date} · Filter by name / 按名称筛选 · All / 全部 · Updates available / 有可用更新 · Running / 运行中 · Local installs / 本地安装 · Recently used / 最近使用 · Name / 名称 · "No Harnesses in this view" / "此视图中没有 Harness" · Clear filters / 清除筛选 · "Uninstall {name}?" / "卸载 {name}？" · "This deletes its data directory ({size}). Files in your own folders are not touched." / "这会删除它的数据目录（{size}）。你自己目录中的文件不受影响。" · "Close the Harness first" / "请先关闭该 Harness" · "Uninstalled {name}" / "已卸载 {name}" · "{n} updates available" / "{n} 个可用更新" (Library nav badge).

---

## Store home — owner P0-09

**Purpose.** Discovery entry point.

**Elements.** Filter row at the top of the Store (search box, tag chips, "My platform only"; see Store search). Featured row (administrator-curated, by rank), then "New" and "Most downloaded" side by side, 12 each. Each card: icon, name (opens the detail page), Publisher login (opens the Publisher page), summary, tags, platform badges (this machine's highlighted; a greyed "not supported" badge for it when the Harness does not declare it), download count. Home rows are never filtered by platform.

**States.** Loading skeletons per section. Offline: the Store's offline panel "Can't reach the Store" with Retry replaces the Store's pages; Library and Models keep working. Server error: inline message with Retry. Empty section hidden; an empty Store says so.

**Key copy.** Featured / 精选 · New / 最新 · Most downloaded / 下载最多 · "Couldn't load the Store" / "无法加载商店" · Retry / 重试 · "Can't reach the Store" / "无法连接商店" · "There are no Harnesses in the Store yet." / "商店里还没有 Harness。".

---

## Store search and results — owner P0-09

**Purpose.** Find a Harness by name, summary, tag or README text. A query with a Chinese (CJK) character also finds part of a name or summary; a Chinese tag is picked as its translated chip.

**Elements.** The filter row at the top of the Store page (no search in the shell header, no separate route): search input (typed text searched 300 ms after the last keystroke, Enter at once, nothing while an input method is still composing), the ten curated tag chips (translated; selected tags must all match, a click searches at once), "My platform only" (on by default, a change searches at once). Text or a tag replaces the home rows with the results, in the Store's ranking, as Store cards; the platform toggle alone keeps the home rows. "Load more" appends the next page of 24 while the last page was full. No result count. The text, tags, toggle and loaded results are kept in memory while the app runs, so Back from a detail or Publisher page, or the sidebar's Store item, restores them.

**States.** Searching (skeletons). No results: "No Harnesses match" with Clear filters (clears text and tags, keeps the platform toggle). Error: inline "Couldn't load the Store" with Retry; a failed Load more keeps the results already shown.

**Key copy.** Search Harnesses / 搜索 Harness · My platform only / 仅显示支持当前平台 · "No Harnesses match" / "没有匹配的 Harness" · "Try another word or clear the filters." / "换个关键词，或清除筛选。" · Clear filters / 清除筛选 · Load more / 加载更多.

---

## Harness detail — owner P0-09 (install actions P0-10, Report P0-12)

**Purpose.** Decide whether to install; see trust information before committing.

**Elements.** Back (to the previous page, else Store home). Header (icon, name, Publisher avatar and name linking to the Publisher page, summary, latest version, primary button, downloads, platform badges, tags), screenshots (up to five), trust block (Declared Permissions scale, runtime kind, UI Kind, Workspace, standing no-sandbox sentence), Models block (per Slot: description, requirements, Recommended Models, "Will use" note from the User's Connections), README (sanitised Markdown; links open in the browser), version history (published versions, newest first, with date, changelog, "Permissions changed" where the Declared Permissions differ from the previous version, the installed version marked), footer (license, homepage, source, Report). The Publish preview (P0-08) is the same component without screenshots. Opened from Store cards and from a Library card's View in Store.

**States.** Loading. Unsupported platform (disabled "Not available for your platform", this machine's badge greyed). Installed (Launch, secondary Uninstall). Update available (Update, or Review update when it needs re-consent; secondary Launch). Downloading n% with Cancel (install or update). Review and install (download done, consent dialog closed; reopens it). Errors of an install or update under the button, with Install or Update as Retry. Starting, Running, Stopping and "Set up a model first" as on a Library card. Installed but no longer in the Store: the page from the installed Manifest with Launch and the note "No longer available in the Store", no Update. Not installed and taken down, Unpublished-only or unknown: "This Harness is no longer available" with the disabled "Removed from Store". Server error: inline Retry.

**Key copy.**
- "Harness Store does not sandbox Harnesses. Installing means trusting this Publisher." / "Harness Store 不会隔离 Harness 进程。安装即代表你信任该发布者。"
- Permissions / 声明权限 · Runs shell commands / 会执行命令行命令 · Reads and writes files in the folder you choose / 读写你选择的工作目录 · Accesses your home folder / 访问你的用户主目录 · Connects to the internet (any site) / 访问任意网站 · Connects to: … / 访问以下网站：…
- Will use: … / 将使用：… · "No Connection can fill this Slot" / "没有模型连接可以填充此槽位"
- Version history / 版本历史 · Installed / 已安装 · Permissions changed / 权限有变化 · Homepage / 主页 · Source / 源码 · Report / 举报 · Back / 返回
- Removed from Store / 已从商店移除 · "No longer available in the Store" / "已不在商店中提供" · "This Harness is no longer available" / "该 Harness 已不可用" · "It was unpublished or taken down. Installed copies keep working." / "它已被撤下或下架。已安装的副本仍可使用。"

---

## Publisher page — owner P0-09

**Purpose.** All Harnesses by one Publisher, with identity from GitHub.

**Elements.** Back. Avatar (a monogram without one), display name (else the GitHub login), @login linking to the GitHub profile, join date, bio (plain text), total downloads (of the Harnesses listed), list of Harnesses (Store cards, most downloaded first). Every Publisher name in the app links here: Store cards, the detail page header, Library cards.

**States.** Loading (skeleton cards). Empty (Publisher with everything unpublished or taken down): "No published Harnesses". No profile with that login: "No such Publisher". Error: inline Retry.

**Key copy.** Harnesses by … / … 发布的 Harness · Joined … / …加入 · Total downloads / 总下载量 · "No published Harnesses" / "没有已发布的 Harness" · "No such Publisher" / "没有这个发布者".

---

## Install consent dialog — owner P0-10

**Purpose.** Informed consent before a downloaded package, or a local folder ("Install this folder locally"), is installed. A minimal version ships with P0-05 for local installs; P0-10 reuses it.

**Elements.** Title with Harness name and version. Declared Permissions list with icon, colour and plain sentence per item. Facts row: runtime kind, UI Kind, Workspace, platforms, plus the Harness ID, version and Entry. A note when the Harness does not run on this platform (it installs but cannot launch). For a local folder, its validation warnings. Standing no-sandbox sentence. Buttons: Cancel, Install (enabled after one second).

**States.** Only one; long permission lists scroll inside the dialog.

**Key copy.** "Install Hello Web 0.1.0?" / "安装 Hello Web 0.1.0？" · Runs on the bundled Node runtime / 运行在内置 Node 运行时 · Native executable / 原生可执行文件 · Opens as a window / 以窗口形式打开 · Opens in a terminal / 在终端中打开 · Needs a folder to work in / 需要选择一个工作目录 · Install / 安装 · Cancel / 取消.

---

## Update prompt — owner P0-10

**Purpose.** Re-consent when trust facts changed. A simple update has no prompt: Update downloads at once, with progress and Cancel on the button.

**Elements.** Opened by "Review update", before the download. Version from → to, a "What changed" list showing only added or widened permissions, each marked New, and Entry/runtime changes as facts (an Entry that only lost a platform: "No longer starts on {platform}"); no "Removed" lines. The changelog, the new version's trust block with the standing no-sandbox sentence. Buttons: Not now, Update (enabled after one second).

**States.** Only one. A running Harness is not a prompt state: an update refused because it runs shows "Close the Harness to update" under the button.

**Key copy.** "Update available: 0.2.0" / "有可用更新：0.2.0" · What changed / 权限变化 · New: runs shell commands / 新增：会执行命令行命令 · "No longer starts on {platform}" / "不再在 {platform} 上启动" · Update / 更新 · Not now / 暂不 · "Updated {name} to {version}. See the changelog in Version history." / "已将 {name} 更新到 {version}，可在版本历史中查看更新日志。".

---

## Workspace picker — owner P0-05

**Purpose.** Choose the folder a Harness works in, when its Manifest asks for one.

**Elements.** A small modal sheet in the main window: last used folder preselected, Choose folder (opens the native folder dialog, starting at the last folder while it exists), the read/write sentence, Cancel, Continue, and for `optional` a "Continue without a folder" button. There is no line saying why the Harness needs a folder: the Manifest has no field for it.

**States.** Required (Cancel aborts launch). Optional. Last folder missing → note "The last folder no longer exists" / "上次使用的目录已不存在". Relaunch from a Harness window reuses that launch's folder without the sheet.

**Key copy.** "Choose a folder for Code Reviewer" / "为 Code Reviewer 选择工作目录" · Choose folder / 选择文件夹 · Continue without a folder / 不选择目录继续 · "The Harness can read and write files in this folder." / "该 Harness 可以读写此目录中的文件。"

---

## Harness web window chrome — owner P0-05

**Purpose.** Host a web UI Kind Harness as its own app window.

**Elements.** Window title "Harness name — Harness Store". Thin top bar: Harness icon and name, model indicator per declared Slot ("Model · default: qwen3:8b" or "Not set"; read again whenever the window gains focus; click opens the Models page for this Harness), Reload (reloads the page; the process keeps running), Open logs. Content area is the Harness's page, sized to the Manifest's `ui.window` hints (default 1100×760).

**States.** Starting (centered "Starting Hello Web…" with elapsed seconds and Cancel, which closes the window and stops the Harness). Ready. Crashed (overlay "Hello Web stopped unexpectedly" with the exit code, Show logs, Relaunch, Close). Exited (code 0 by itself: same overlay titled "Hello Web has exited"). Could not start (same overlay, "Hello Web could not start"). Timed out (same overlay with the timeout message and the last 50 lines of output in a scrolling monospace block). The window stays open in every ended state until the User closes it.

**Key copy.** Starting … / 正在启动 … · "did not start in time" / "启动超时" · "stopped unexpectedly" / "意外停止" · "has exited" / "已退出" · "could not start" / "无法启动" · Show logs / 查看日志 · Relaunch / 重新启动 · Reload / 重新加载 · Model · default: … / 模型 · default：… · Not set / 未设置.

---

## Harness terminal window — owner P0-05

**Purpose.** Host a terminal UI Kind Harness.

**Elements.** Window title with Harness name and, on exit, the exit code. Embedded terminal filling the window (960×640 by default, 5000 lines of scrollback); same thin top bar as the web window (model indicator, Open logs). Font size follows Settings (fixed at 13 px until P0-11 adds the setting). Copy and paste: the Edit menu on macOS, Ctrl+Shift+C / Ctrl+Shift+V on Windows and Linux, where Ctrl+C goes to the Harness.

**States.** Running. Exited (terminal stays readable, top bar shows "Exited with code N", buttons Relaunch, Close).

**Key copy.** "Exited with code 1" / "已退出，退出码 1" · Relaunch / 重新启动 · Close / 关闭.

---

## Models — owner P0-03

**Purpose.** Manage Connections, Default Models and per-Harness Model Overrides.

**Elements.** Section Connections (list with status, Test, Edit, Enable/Disable, Remove; Add Connection opens a dialog with a preset picker, then the Provider's fields, Test connection and Save, enabled once the test passed; a saved key shows only as "Key stored encrypted on this machine" with its last 4 characters). Local Providers panel (Ollama and LM Studio found on this machine, each with Add, or "Added" when it already has a Connection; Detect again). Section Default Models (`default` first and always, then every other Slot name that is bound globally or declared by an installed Harness, each with a picker that includes "Not set", and requirement warnings; the resolution order is explained above the rows). Section Per-Harness Overrides (expandable per installed Harness: Slots, description, requirements, Recommended Models, resolved model with its source badge, picker with "No override", Clear override; `models?harness=<id>` opens and scrolls to that Harness). Every picker has "Type a model name".

**States.** Empty Connections: "Add a Connection to run Harnesses". Detecting local Providers (inline spinner in the Local Providers panel; nothing found → install guidance and Detect again). Status of a Connection, in order: Disabled, Connection failed (with the Provider's message), Local, Connected, Not tested. A Default Model whose Connection is disabled is kept and marked "Connection disabled". OS encryption unavailable → adding a key is refused with guidance to enable an OS keyring. Test in progress / succeeded / failed with Provider message. Requirement warning (yellow, non-blocking). Remove Connection confirmation naming affected Slots.

**Key copy.**
- Add Connection / 添加模型连接 · Test connection / 测试连接 · Connected / 已连接 · Local / 本地 · Connection failed / 连接失败
- Default Models / 默认模型 · Overrides for this Harness / 此 Harness 的槽位覆盖 · Uses: Recommended / 来源：推荐模型 · Uses: Default / 来源：默认模型 · Uses: Override / 来源：手动覆盖 · Clear override / 清除覆盖
- "This model may not meet the requirements of …'s `default` Slot (tool calling)." / "此模型可能不满足 … 的 `default` 槽位要求（工具调用）。"
- Type a model name / 手动输入模型名称
- Local Providers / 本地 Provider · Detect again / 重新检测 · Disabled / 已停用 · Not tested / 未测试 · Enable / 启用 · Disable / 停用 · Not set / 未设置 · Connection disabled / 模型连接已停用 · Key stored encrypted on this machine / Key 已加密保存在本机

---

## Publish — owner P0-08 (GitHub import added by P0.5-03)

**Purpose.** Publish a Harness from a local folder; manage own listings.

**Elements.** Signed-out: GitHub sign-in card. Signed-in: tabs "New version" and "My Harnesses". New version: folder drop zone, validation problem list (path, message, code; warnings apart), Continue, review (read-only facts from Manifest, changelog, what was left out, package size), listing preview (card and detail page), Publish with progress and Cancel. Secondary: "Install this folder locally" (its own panel and folder picker, signed in or out). My Harnesses: list of own Harnesses and versions with status, download counts and Unpublish per published version.

**States.** Signed out ("Install this folder locally" still works, offline too). Validating. Problems present (Continue disabled). Installed locally (inline "Installed Hello Web 0.1.0 from the folder. It is marked Local in the Library." with Open Library). Uploading (Cancel while sending; then "Processing…"). Upload cancelled (back to the review). Rejected by server (translated message, code and the Store's problems, Retry). Session expired ("Sign in again", folder kept). Success (listing link). Offline (Publish disabled with explanation). Unpublish confirmation.

**Key copy.**
- "Only Publishers need to sign in. Browsing and installing never require an account." / "只有发布者需要登录，浏览和安装永远不需要账号。"
- Sign in with GitHub / 使用 GitHub 登录 · Choose a folder / 选择文件夹 · Drop a Harness folder here / 将 Harness 文件夹拖到这里
- "1 problem must be fixed before publishing" / "发布前需修复 1 个问题" · Re-check / 重新检查
- Problems use the Manifest package's own messages, e.g. "Version 0.1.0 must be greater than every published version of this Harness; the latest is 0.2.0." / "版本 0.1.0 必须高于此 Harness 所有已发布的版本；最新版本为 0.2.0。" · "Your Harness IDs start with octocat/" / "你的 Harness ID 以 octocat/ 开头"
- Publish / 发布 · "Published! Versions are immutable; publish a new version to change anything." / "发布成功！已发布版本不可修改，如需变更请发布新版本。"
- Install this folder locally / 本地安装此文件夹 · "Installed Hello Web 0.1.0 from the folder. It is marked Local in the Library." / "已从文件夹安装 Hello Web 0.1.0，在资源库中标记为「本地」。" · Unpublish / 撤下 · "Unpublish {name} {version}?" / "撤下 {name} {version}？" · "Existing installs keep working. This version can no longer be downloaded." / "已安装的用户不受影响。此版本将无法再被下载。"

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

**Elements.** Reason radio list (Malicious behaviour, Bypasses the Model Gateway, Broken, Inappropriate content, Spam, Other; one per `report_reason` value), details text area, optional contact email, Submit.

**States.** Submitting. Sent confirmation. Rate limited ("You've already reported this Harness recently").

**Key copy.** Report … / 举报 … · Malicious behaviour / 恶意行为 · Bypasses the Model Gateway / 绕过 Model Gateway · Broken / 无法使用 · Inappropriate content / 不当内容 · Spam / 垃圾信息 · Other / 其他 · "Thanks, a reviewer will look at this." / "感谢反馈，审核人员会尽快查看。"
