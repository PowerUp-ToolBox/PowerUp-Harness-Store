# Screen Specifications

One entry per screen. Each gives purpose, primary elements, states, key copy (en / zh-CN) and the owning spec ID from `roadmap.md`. Shared rules are in `design-principles.md`; flows are in `flows.md`.

---

## Main window shell — owner P0-04

**Purpose.** Frame for all main screens: sidebar navigation, header, offline banner, update badge.

**Elements.** Sidebar items in order: Library, Store, Models, Publish, Usage, Settings. Header: page title (the Store's search sits in its own filter row, see Store home). Global toast area bottom-right.

**States.** Offline → persistent banner "You're offline. Library and Models still work." / "当前离线。资源库和模型页仍可使用。" Custom Store URL set in Settings → a banner beside it on every main screen (not the first-run wizard) that cannot be dismissed: "You're using a custom Store: {url}" / "正在使用自定义商店：{url}" with the link "Change in Settings" / "在设置中更改" (P0-11). Update badge on Library when any installed Harness has an update.

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

**Elements.** Grid or list of cards: icon, name, Publisher, installed version, last launched date (none when never launched), primary action button (see design-principles §3; its states are the card's status, with no separate label), overflow menu (View in Store, Model Overrides, Show logs, Open data folder, Report (Store installs only: the Store may not know a local one; it reports the installed version), Uninstall). The Publisher links to their Publisher page. Above the cards: a name filter, views All, Updates available, Running, Local installs, and Sort: Recently used (last launched, then name; default), Name; all work on the list already loaded. Uninstall opens a confirmation: "Uninstall {name}?", the Data Directory's size, Cancel and Uninstall (danger); while the Harness runs it says "Close the Harness first" with only Close. P0-05 builds the cards (ordered recently launched first, then name), Model Overrides, Show logs and Open data folder; P0-09 adds View in Store (the Harness's detail page) and the Publisher link; P0-10 adds the rest; P0-12 adds Report.

**States.** Loading skeleton ("Loading your Library"). No card in the view: "No Harnesses in this view" with Clear filters. Empty: illustration, "Nothing installed yet" with "Browse the Store". Card error: "Exited with an error" (or "Did not start in time", "Could not start") with Show logs and Dismiss; the button stays Launch. No error for a cancelled Workspace, an unsupported platform or a missing model. Card note: "No longer available in the Store" for an Unpublished Harness. Taken down (P0-12): a red warning in place of that note, no Update, and Launch first asks once per Takedown "This Harness was removed from the Store. Launch anyway?" with the warning, Cancel and "Launch anyway" (Show window of a running one asks nothing). Local install badge: "Local".

**Key copy.** Launch / 启动 · Update / 更新 · Running… / 运行中… · Show window / 显示窗口 · Stopping… / 正在停止… · Uninstall / 卸载 · Local / 本地 · Model Overrides / 槽位覆盖 · View in Store / 在商店中查看 · Show logs / 查看日志 · Open data folder / 打开数据目录 · Report / 举报 · Dismiss / 忽略 · "Exited with an error" / "异常退出" · "Did not start in time" / "启动超时" · "Could not start" / "无法启动" · "Nothing installed yet" / "还没有安装任何 Harness" · "Browse the Store" / "去商店看看" · "Close the Harness to update" / "请先关闭该 Harness 再更新" · Review update / 查看更新 · Last launched {date} / 上次启动：{date} · Filter by name / 按名称筛选 · All / 全部 · Updates available / 有可用更新 · Running / 运行中 · Local installs / 本地安装 · Recently used / 最近使用 · Name / 名称 · "No Harnesses in this view" / "此视图中没有 Harness" · Clear filters / 清除筛选 · "Uninstall {name}?" / "卸载 {name}？" · "This deletes its data directory ({size}). Files in your own folders are not touched." / "这会删除它的数据目录（{size}）。你自己目录中的文件不受影响。" · "Close the Harness first" / "请先关闭该 Harness" · "Uninstalled {name}" / "已卸载 {name}" · "{n} updates available" / "{n} 个可用更新" (Library nav badge) · "A Store administrator took this Harness down. It may be harmful: launch it only if you trust it." / "该 Harness 已被商店管理员下架，可能有害。仅在你信任它时启动。" · "This Harness was removed from the Store. Launch anyway?" / "该 Harness 已从商店移除。仍要启动吗？" · Cancel / 取消 · Launch anyway / 仍然启动.

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

**States.** Loading. Unsupported platform (disabled "Not available for your platform", this machine's badge greyed). Installed (Launch, secondary Uninstall). Update available (Update, or Review update when it needs re-consent; secondary Launch). Downloading n% with Cancel (install or update). Review and install (download done, consent dialog closed; reopens it). Errors of an install or update under the button, with Install or Update as Retry. Starting, Running, Stopping and "Set up a model first" as on a Library card. Installed but no longer in the Store: the page from the installed Manifest with Launch and the note "No longer available in the Store", no Update; taken down (the install's Store status from the update check), the red warning of the Library card in place of the note, and Launch asks the same one-time confirmation. Not installed and taken down, Unpublished-only or unknown: "This Harness is no longer available" with the disabled "Removed from Store". Server error: inline Retry.

**Key copy.**
- "Harness Store does not sandbox Harnesses. Installing means trusting this Publisher." / "Harness Store 不会隔离 Harness 进程。安装即代表你信任该发布者。"
- Permissions / 声明权限 · Runs shell commands / 会执行命令行命令 · Reads and writes files in the folder you choose / 读写你选择的工作目录 · Accesses your home folder / 访问你的用户主目录 · Connects to the internet (any site) / 访问任意网站 · Connects to: … / 访问以下网站：…
- Will use: … / 将使用：… · "No Connection can fill this Slot" / "没有模型连接可以填充此槽位"
- Version history / 版本历史 · Installed / 已安装 · Permissions changed / 权限有变化 · Homepage / 主页 · Source / 源码 · Report / 举报 · Back / 返回
- "A Store administrator took this Harness down. It may be harmful: launch it only if you trust it." / "该 Harness 已被商店管理员下架，可能有害。仅在你信任它时启动。" · "This Harness was removed from the Store. Launch anyway?" / "该 Harness 已从商店移除。仍要启动吗？" · Launch anyway / 仍然启动
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

**Elements.** A note that the records stay on this machine. Period selector (Today, 7 days (default, not remembered), 30 days, All). Filters by Harness and Provider (All Harnesses / All Providers, then every one ever recorded; a Harness by its installed name, else its ID; a Provider by its Connection's name, else its ID). Totals tiles: Requests, Errors, Prompt tokens, Completion tokens. Table "Usage by Harness and model": a row per Harness with its model rows ("{model}", "via {Provider}") beneath, most recently used first, columns Requests, Errors, Prompt tokens, Completion tokens, Last used. Table "Daily breakdown": a row per day with records, newest first, same columns without Last used. Export CSV, Clear usage data. Tokens only, no cost.

**States.** Empty (no Usage Record at all, also after Clear): "Launch a Harness to see usage here". A period or filter matching nothing: zero totals and empty tables. A token cell whose `ok` requests all lacked counts: a dash with tooltip; some lacked counts: the known sum with the dash beside it. Clear confirmation (shared with Settings). Export: "Saved {file}" when written; an export error stays until the next export.

**Key copy.** "Counted by the Model Gateway on this machine. Usage Records never leave it." / "由本机的 Model Gateway 统计，用量记录不会离开本机。" · Today / 今天 · 7 days / 7 天 · 30 days / 30 天 · All / 全部 · Requests / 请求数 · Errors / 失败 · Prompt tokens / 输入 token · Completion tokens / 输出 token · Last used / 最近使用 · "Usage by Harness and model" / "按 Harness 和模型统计的用量" · "via {provider}" / "通过 {provider}" · Daily breakdown / 每日明细 · "This Provider did not report usage" / "该 Provider 未返回用量信息" · Export CSV / 导出 CSV · Clear usage data / 清除用量数据 · "Clear usage data?" / "清除用量数据？" · "This deletes every Usage Record on this machine." / "这会删除本机上的所有用量记录。" · Usage data cleared / 已清除用量数据.

---

## Settings — owner P0-11

**Purpose.** App-level preferences.

**Elements.** In order: Language (System, English, 简体中文). Check for Harness updates (Every hour, Every 6 hours (default), Every 24 hours, Never; Check now). Data location (the app data root, Open folder, Open logs folder). Advanced, collapsed: Store URL (field showing the default, Apply, Use default). First-run setup (Re-run setup). Usage data (Clear usage data, with the Usage page's confirmation). Diagnostics (version, Model Gateway status and port, Node, data root, local database; Copy diagnostics). Every value applies at once with no Save button, except the Store URL, which applies with Apply because a new Store signs the User out. Not in P0: Appearance, local Provider detection toggle, terminal font size, Move data location, Licenses, Sign out (it is on Publish), Reset app.

**States.** Language change applies immediately with a note that running Harnesses keep their launch locale until relaunched. Never: a note that the Store is asked about updates only on Check now. Check now disabled while offline or checking; then a toast with the number of updates available, or the error inline. Store URL refused: the reason beside the field. Custom Store URL: the shell's banner on every main screen. Model Gateway: running on port N, not reachable on port N, or not running (read when the page opens and after Copy).

**Key copy.** Language / 语言 · Check for Harness updates / 检查 Harness 更新 · Every hour / 每小时 · Every 6 hours / 每 6 小时 · Every 24 hours / 每 24 小时 · Never / 从不 · Check now / 立即检查 · "Checked the Store. No updates available." / "已检查商店，没有可用更新。" · Data location / 数据位置 · Open folder / 打开文件夹 · Open logs folder / 打开日志文件夹 · Advanced / 高级 · Store URL / 商店地址 · "Applying a new address signs you out of the Store." / "应用新地址会退出商店登录。" · Apply / 应用 · Use default / 恢复默认 · Re-run setup / 重新运行设置向导 · Clear usage data / 清除用量数据 · Diagnostics / 诊断信息 · "Not reachable on port {port}" / "无法访问，端口 {port}" · Copy diagnostics / 复制诊断信息 · Diagnostics copied / 已复制诊断信息.

---

## Report dialog — owner P0-12

**Purpose.** Let any User flag a Harness for review.

**Elements.** Opened from the detail page's footer (the version in its header: the Store's latest, or the installed one on a page built from the install; no Report on the "no longer available" page or a local install's page the Store does not have) and a Library card's menu (the installed version). Reason radio list (Malicious behaviour, Bypasses the Model Gateway, Broken, Inappropriate content, Spam, Other; one per `report_reason` value; none preselected, Submit disabled until one is picked), details text area with the characters left (2000, the contact line included), optional contact email (a loose `x@y` check; sent at the start of the details as `Contact: <email>`), then what else is sent, shown before Submit: Harness ID, version ("All versions" when unknown), platform, app version and the random install ID, with "No IP address or account is stored". Cancel, Submit.

**States.** Loading (the client info, read each time the dialog opens). Submitting. Sent: the toast below, and the dialog closes. Rate limited, before Submit (this install already sent 3 Reports of the Harness the Store took in 24 hours; no request is made, and the hint below says so) or answered by the Store (no hint, since the Store's limit is per IP address or install across Harnesses; focus moves to Close): "You've already reported this Harness recently" with only Close. Any other error (offline, the Store's error): the message under the form, everything typed kept, Submit becomes Retry; Submit is not disabled while offline.

**Key copy.** "Report {name}" / "举报 {name}" · Reason / 原因 · Malicious behaviour / 恶意行为 · Bypasses the Model Gateway / 绕过 Model Gateway · Broken / 无法使用 · Inappropriate content / 不当内容 · Spam / 垃圾信息 · Other / 其他 · Details (optional) / 详细说明（可选） · "{count} characters left" / "还可输入 {count} 个字符" · "{count} characters too many" / "超出 {count} 个字符" · Contact email (optional) / 联系邮箱（可选） · "Sent at the start of the details, so a reviewer can reply." / "会放在详细说明的开头发送，便于审核人员回复。" · "Enter an email address like name@example.com, or leave it empty." / "请输入形如 name@example.com 的邮箱地址，或留空。" · "Sent with this Report: Harness ID, version, platform, app version, a random install ID" / "随举报发送：Harness ID、版本、平台、应用版本、一个随机的安装 ID" · Version / 版本 · All versions / 所有版本 · Platform / 平台 · App version / 应用版本 · Install ID / 安装 ID · "No account is needed. No IP address or account is stored with the Report." / "无需账号。举报不会保存 IP 地址或账号。" · Submit / 提交 · "Preparing the Report…" / "正在准备举报…" · Submitting… / 正在提交… · Retry / 重试 · "You've already reported this Harness recently" / "你最近已经举报过这个 Harness" · "You can report a Harness up to 3 times in 24 hours. A reviewer will look at your earlier Reports." / "24 小时内同一个 Harness 最多可举报 3 次，审核人员会查看你之前的举报。" · Close / 关闭 · "Thanks, a reviewer will look at this." / "感谢反馈，审核人员会尽快查看。"
