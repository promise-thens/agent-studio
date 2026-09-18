# P3-06 Chrome Native Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 独立浏览器设置页（对标 ChatGPT Browser Use，出厂开放）+ Agent 自己开右栏 + 配套扩展装上即同步 Cookie/登录态并允许连接用户 Chrome。

**Architecture:** 设置与权限走现有 `app:*` IPC 和 `HostBrowserSettingsStore`。Native Host 放在 `src/main/browser/chrome/`（不新建 Capability Pack）。扩展只经 Native Messaging 说话，不解析磁盘 Chrome Profile。内置页继续用 `src/main/browser/`。三条战场共用已有 overlay；配套扩展有窗 DIP 才画 `browser-plugin` 针。

**Tech Stack:** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Chrome MV3 Native Messaging。

**Spec:** [2026-09-17-computer-use-development.md](../specs/2026-09-17-computer-use-development.md) §0.4 / §1.1 / §1.5 / §1.7 / 阶段 0 / 阶段 0b。

## Global Constraints

- 中文沟通以外的代码注释必须用中文，解释原因/边界/风险，不翻译语法。
- Renderer 不得碰文件系统、Shell、子进程、`safeStorage`、Provider 网络；IPC 静态 channel，主进程重校验。
- 不得新增 `grok:*` IPC；通用能力用 `app:*` / `agent:*` / `task:*`。
- API Key / Cookie 明文不得进 Renderer、日志、Timeline、测试快照。
- 不解析 `~/Library/Application Support/Google/Chrome/` Profile。
- 不依赖 P3-01 / P3-02 Capability Pack；禁止新建 `src/main/capability/`。
- Native Host 不得变成任意 Shell：固定 extension id、zod schema、长度上限、命令白名单。
- `browser` L3 已开，不得改回 `unsupported`。货架 chrome-devtools 的 viewport-css `click_at` 仍不得发明光标。
- 配套扩展已连并上报屏幕 DIP 后必须画 `browser-plugin` 针；没有几何宁可不画。
- 出厂：总开关开、智能体权限四列始终允许、完整 CDP 开、连接开、Cookie 同步开、谨慎模式关、下载前询问关。
- 任务执行中禁止改总开关；保存必须等主进程确认，禁止乐观 UI。
- 清浏览数据只清内置 `persist:as-browser:{projectId}` partition，不动用户 Chrome。
- TDD：先写失败测试，再写最小实现。核心函数/IPC/权限边界写中文 TSDoc。
- 提交：Conventional Commits 中文主语，`--trailer Made-with: Grok`。只提交本任务文件。
- 工作目录必须是 git worktree：`/Users/huyaohang/Desktop/个人/agent-studio/.worktrees/p3-06-chrome-native-bridge`。禁止改主仓未提交脏文件。
- 验证：`pnpm exec eslint <files> --no-cache`、相关 Vitest、`pnpm typecheck`（整任务结束前至少一次）、`git diff --check`。Node 20+ / pnpm 10。
- 不得宣称任意 App Computer Use 完成，也不得宣称已和 Codex 一样。

### 本计划裁定（执行者不得再解释）

1. Native Host 路径：`src/main/browser/chrome/`，不是 `src/main/capability/chrome/`。
2. 密码管理器与下载历史：设置页必须有分组标题和「尚未接入」说明，不实现密码库/下载列表。
3. 智能体权限 `browse === 'always'` 且 `cautiousMode === false` 时，Broker 对 `operationType === 'browser'` 走与 takeover 相同的一次性 auto-allow，不弹卡。谨慎模式或 `ask` 保持现有 L3。
4. `setHostBrowserEnabled` 保留为总开关（继续 `assertGrokConfigCanReload`）。其它字段走新的 `app:set-host-browser-settings`。
5. schemaVersion 升到 2；读到 v1 只取 `enabled`，其余出厂默认。
6. 任意成功的宿主 MCP `perform` 都打开右栏，不限于 navigate / tabs_open。
7. ACP 插件 overlay 通道仍剥离不可映射 pointer；配套扩展经 Native Host 合成屏幕 DIP 后走 `createAgentPointerSnapshot({ surface: 'browser-plugin', pointer })`。

---

### Task 1: 设置领域类型、解析与 Store v2

**Files:**
- Modify: `src/shared/host-browser.ts`
- Modify: `src/shared/host-browser.test.ts`
- Modify: `src/shared/app-ipc.ts`（`AppHostBrowserSettings` 改为完整类型别名）
- Modify: `src/main/browser/host-browser-settings.ts`
- Modify: `src/main/browser/host-browser-settings.test.ts`

**Interfaces:**
- Consumes: 现有 `HostBrowserSettingsStore` 只存 `{ schemaVersion: 1, enabled, updatedAt }`
- Produces:

```ts
export type HostBrowserLinkOpenTarget = 'studio' | 'system'
export type HostBrowserScreenshotAnnotation = 'always' | 'ask' | 'never'
export type HostBrowserAgentPermissionMode = 'always' | 'ask'

export interface HostBrowserAgentPermissions {
  browse: HostBrowserAgentPermissionMode
  download: HostBrowserAgentPermissionMode
  upload: HostBrowserAgentPermissionMode
  debug: HostBrowserAgentPermissionMode
}

export interface HostBrowserSettings {
  enabled: boolean
  linkOpenTarget: HostBrowserLinkOpenTarget
  showFullUrl: boolean
  screenshotAnnotation: HostBrowserScreenshotAnnotation
  downloadAskBefore: boolean
  agentPermissions: HostBrowserAgentPermissions
  fullCdp: boolean
  cautiousMode: boolean
  cookieSyncEnabled: boolean
  chromeConnectEnabled: boolean
  syncBlacklist: string[]
}

export const DEFAULT_HOST_BROWSER_SETTINGS: HostBrowserSettings = {
  enabled: true,
  linkOpenTarget: 'studio',
  showFullUrl: false,
  screenshotAnnotation: 'always',
  downloadAskBefore: false,
  agentPermissions: {
    browse: 'always',
    download: 'always',
    upload: 'always',
    debug: 'always'
  },
  fullCdp: true,
  cautiousMode: false,
  cookieSyncEnabled: true,
  chromeConnectEnabled: true,
  syncBlacklist: []
}

export function parseHostBrowserSettings(value: unknown): HostBrowserSettings | null
export function parseHostBrowserSettingsPatch(
  value: unknown
): Partial<Omit<HostBrowserSettings, 'enabled'>> | null
```

`parseHostBrowserEnabledState` 保留并改为调用完整 parse 后只返回 `{ enabled }`，避免旧 preload 测试碎一地；新 preload 任务会改用完整 parse。

黑名单：最多 64 项；每项必须是 `parseBrowserOrigin` 能认出的 http(s) origin；重复去掉；非法整包 parse 失败。

Store：
- `getSettings(): HostBrowserSettings`
- `isEnabled()` 继续返回 `getSettings().enabled`
- `save(enabled: boolean)` 继续只改 enabled，其余字段保持内存值
- `saveSettings(next: HostBrowserSettings): Promise<HostBrowserSettings>`
- 写盘 `{ schemaVersion: 2, updatedAt, ...settings }`
- 坏文件 / 缺文件 → 出厂默认（enabled 仍为 true）
- 读 v1 `{ schemaVersion: 1, enabled, updatedAt }` → enabled 采用文件值，其余默认

- [ ] **Step 1: Write the failing test**

在 `src/shared/host-browser.test.ts` 增加：

```ts
it('完整设置出厂默认开放，丢掉未知键，拒绝非法黑名单', () => {
  expect(parseHostBrowserSettings({ enabled: true })).toEqual(DEFAULT_HOST_BROWSER_SETTINGS)
  expect(parseHostBrowserSettings({
    ...DEFAULT_HOST_BROWSER_SETTINGS,
    cookie: 'secret',
    syncBlacklist: ['https://mail.example.com']
  })).toEqual({
    ...DEFAULT_HOST_BROWSER_SETTINGS,
    syncBlacklist: ['https://mail.example.com']
  })
  expect(parseHostBrowserSettings({
    ...DEFAULT_HOST_BROWSER_SETTINGS,
    syncBlacklist: ['not-an-origin']
  })).toBeNull()
  expect(parseHostBrowserSettings({ enabled: 'yes' })).toBeNull()
})
```

在 `host-browser-settings.test.ts` 增加 v1 升级、损坏回退、saveSettings 不丢其它字段。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/shared/host-browser.test.ts src/main/browser/host-browser-settings.test.ts`
Expected: FAIL because `parseHostBrowserSettings` / schema v2 不存在。

- [ ] **Step 3: Write minimal implementation**

实现类型、parse、Store v2。中文 TSDoc 写清：v1 只认 enabled；坏文件回退出厂开放，避免一次损坏把能力关死。

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/shared/host-browser.test.ts src/main/browser/host-browser-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/host-browser.ts src/shared/host-browser.test.ts src/shared/app-ipc.ts src/main/browser/host-browser-settings.ts src/main/browser/host-browser-settings.test.ts
git commit -m "feat(p3-06): 扩展内置浏览器设置为出厂开放的完整偏好" --trailer "Made-with: Grok"
```

---

### Task 2: IPC、Preload 与主进程读写

**Files:**
- Modify: `src/shared/app-ipc.ts`（新 channel `setHostBrowserSettings`、`clearHostBrowserData`；`AppHostBrowserSettings` = `HostBrowserSettings`）
- Modify: `src/shared/agent-ipc.test.ts`（channel 清单）
- Modify: `src/main/app-ipc.ts` 与 `src/main/app-ipc.test.ts`
- Modify: `src/preload/desktop-api.ts` 与 `src/preload/index.d.ts`（若有显式方法列表）
- Modify: `src/preload/desktop-api.test.ts`（若断言 channel）
- Modify: `src/main/index.ts`（get 返回完整 settings；setEnabled 只改 enabled；新增 setSettings；clear 本任务可先接依赖空实现，Task 4 填）
- Test: 现有 `src/main/index.test.ts` 若断言 `{ enabled: true }` 形状，改为完整对象或 `toMatchObject({ enabled: true })`

**Interfaces:**
- Consumes: Task 1 `HostBrowserSettings` / Store
- Produces:

```ts
setHostBrowserSettings: 'app:set-host-browser-settings'
clearHostBrowserData: 'app:clear-host-browser-data'

interface AppClearHostBrowserDataRequest {
  kinds: Array<'cookies' | 'cache' | 'history' | 'downloads'>
}
```

Handler 规则：
- `getHostBrowserSettings`：无参，返回完整 settings。
- `setHostBrowserEnabled`：仍只收 `{ enabled }`；busy 时 `assertGrokConfigCanReload` 拒绝。
- `setHostBrowserSettings`：只收 patch（**不得含 enabled**）。主进程 `parseHostBrowserSettingsPatch`，与当前 settings merge 后 `saveSettings`。执行中允许改非总开关字段。
- `clearHostBrowserData`：本任务 handler 必须存在并校验 `kinds`（1–4 个，仅白名单）。真正清 partition 可先调用依赖 `clearHostBrowserData`；index 里先返回 `{ ok: true }` 的占位也可以，但测试要锁住非法 kinds。推荐本任务只做校验+依赖注入，Task 4 实现清数据。

Preload：`parseHostBrowserSettings` 解析 get/set 返回值；未知键丢掉。

- [ ] **Step 1: Write the failing test**

`app-ipc.test.ts`：
- get 返回完整默认
- setSettings 丢掉 `enabled` 键（含 enabled 的请求 invalid-input）
- 非法 blacklist invalid-input
- clear 空数组 / `files` 非法

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/app-ipc.test.ts src/shared/agent-ipc.test.ts src/preload/desktop-api.test.ts`
Expected: FAIL（缺 channel / 缺 parse）

- [ ] **Step 3: Write minimal implementation**

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(p3-06): 增加浏览器完整设置 IPC" --trailer "Made-with: Grok"
```

---

### Task 3: 独立浏览器设置页 UI

**Files:**
- Modify: `src/renderer/src/host-browser-settings.ts`（全部分组文案常量）
- Modify: `src/renderer/src/host-browser-settings.test.ts`
- Modify: `src/renderer/src/components/HostBrowserSettingsPanel.vue`
- Modify: `src/renderer/src/settings-dialog.test.ts`（源码包含分组标题）
- Modify: `src/renderer/src/components/SettingsDialog.vue` 仅当需要加宽弹窗（浏览器页内容变长）；优先面板内部滚动，不改无关栏目。

**Interfaces:**
- Consumes: `window.app.getHostBrowserSettings` / `setHostBrowserEnabled` / `setHostBrowserSettings` / `clearHostBrowserData`
- Produces: 设置 → 浏览器按说明书 §1.7 分组可见

必须出现的分组与控件（文案用产品名，不写 ChatGPT）：

1. 页标题「浏览器」；副标题「管理 Browser Use 偏好设置和网站访问权限」。
2. **总开关**：legend「让 Grok 控制内置浏览器」；checkbox；hint 写明下一 session 生效；`runtimeBusy` 时 disabled，title 为现有 busy 文案。
3. **常规**：链接打开位置（select：`studio` = Agent Studio / `system` = 系统浏览器）；显示完整网址；批注截图（always/ask/never，默认 always，旁注会增加 token）；「清除浏览数据」按钮（cookies+cache+history+downloads）。
4. **自动填充和密码**：分组存在，正文「内置密码库尚未接入。Chrome 若未开放密码 API，不会假装已同步密码。」
5. **下载**：下载前询问，默认关。
6. **智能体权限**：browse/download/upload/debug 四列，每列 select always/ask，出厂 always。
7. **配套扩展**：安装状态占位「未检测到配套扩展」（Task 6 接真状态）；可选黑名单 textarea（一行一个 origin）；Cookie 同步开关；连接用户 Chrome 开关。二者出厂开。
8. **完整 CDP**：开关，出厂开；风险文案保留。
9. **谨慎模式**：开关，出厂关。

交互：
- 加载/保存/失败/重试明确。
- 改控件必须等 IPC 成功再更新 checkbox/select，禁止乐观。
- 总开关走 `setHostBrowserEnabled`；其它走 `setHostBrowserSettings`。
- 所有图标按钮有 title 或 aria-label。
- 复用现有 `--text-*` / `--border` / fieldset 风格，不另造颜色系统。
- Titlebar 无关；设置弹窗已是 no-drag。

- [ ] **Step 1: Write the failing test**

`host-browser-settings.test.ts` 与 `settings-dialog.test.ts` 用读 Vue 源码断言分组标题、出厂文案、「尚未接入」、busy title。不要上 Vue Test Utils 挂载整页，除非仓库已有同类挂载测试。

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write minimal implementation**

- [ ] **Step 4: Run tests + 目标 ESLint**

Run: `pnpm exec vitest run src/renderer/src/host-browser-settings.test.ts src/renderer/src/settings-dialog.test.ts`
Run: `pnpm exec eslint src/renderer/src/components/HostBrowserSettingsPanel.vue src/renderer/src/host-browser-settings.ts --no-cache`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(p3-06): 把浏览器设置做成完整偏好页" --trailer "Made-with: Grok"
```

---

### Task 4: 自己开右栏、技能、清数据、浏览始终允许

**Files:**
- Modify: `src/main/browser/host-browser-service.ts`（`opensPane`）
- Modify: `src/main/browser/host-browser-service.test.ts`
- Modify: `src/main/runtime/grok/host-browser-grok-skill.ts`
- Modify: `src/main/runtime/grok/host-browser-grok-skill.test.ts`
- Modify: `.agents/skills/host-browser/SKILL.md`（与 grok-home 技能正文同步新增「自己开标签」）
- Modify: `src/main/security/permission-broker.ts` 与 `permission-broker.test.ts`
- Modify: `src/main/index.ts`（authorize 传入 browserAlwaysAllow；实现 clearHostBrowserData）
- Modify: `src/main/browser/host-browser-session.ts`（如需 `clearPartitionData` 辅助函数）
- Test: `src/main/browser/host-browser-session.test.ts`

**Interfaces:**
- Consumes: Task 1 settings；现有 Broker `takeoverEnabled`
- Produces:
  - 任意成功 `perform` 后 `getChrome().open === true`
  - 技能要求 `browser_navigate` / `browser_tabs_open`，禁止等地球图标，禁止 OCR/PIL，禁止 chrome-devtools `click_at`
  - `browse === 'always' && !cautiousMode` → browser 操作 auto-allowed once
  - `session.fromPartition(createBrowserPartition(projectId)).clearStorageData` 只清当前 Task 的 project partition

`opensPane` 改为对任何 `HostBrowserAction` 返回 true（或删除该函数，成功后一律 `wantOpen = true`）。补测试：`browser_snapshot` 成功也 `open === true`；denied 的 navigate 仍不打开。

Broker：新增 `AuthorizeOperationOptions.browserAlwaysAllow?: boolean`。仅当 `resolved.operationType === 'browser'` 且该标志为 true 时走 takeover 同款 `executeAllowed(..., 'auto-allowed', 'once')`。写文件不得被这个标志放行。测试必须锁住这一点。

清数据：需要当前选中 Task 的 projectId。若没有 Task，返回 `invalid-state`「没有可清理的内置浏览器会话。」禁止收 Renderer 传来的 partition 名或路径。

- [ ] **Step 1: Write the failing tests**（snapshot 开栏、技能文案、broker 不捎带写文件、clear 无 project 失败）
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Minimal implementation**
- [ ] **Step 4: Tests pass + eslint 目标文件**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(p3-06): 让 Agent 自己打开内置页并默认放行浏览" --trailer "Made-with: Grok"
```

---

### Task 5: Native Host 协议与 Cookie 写入内置 partition

**Files:**
- Create: `src/shared/chrome-native-bridge.ts`（可序列化 DTO + parse，无 Electron）
- Create: `src/shared/chrome-native-bridge.test.ts`
- Create: `src/main/browser/chrome/native-host.ts`
- Create: `src/main/browser/chrome/native-host.test.ts`
- Create: `src/main/browser/chrome/native-host-stdio.ts`（stdin 4-byte LE 长度帧，可被 Electron `ELECTRON_RUN_AS_NODE` 拉起）
- Modify: `electron.vite.config.ts`（增加 `chrome-native-host-stdio` 入口，仿 `host-browser-mcp-stdio`）
- Modify: `electron-builder.yml` `asarUnpack` 加上该 js
- Modify: `src/main/index.ts`（app ready 后启动 host；按 settings 把 cookie 写入当前 project partition）

**Interfaces:**
- Consumes: `createBrowserPartition`、`HostBrowserSettings.syncBlacklist` / `cookieSyncEnabled`
- Produces:

```ts
export const CHROME_NATIVE_HOST_NAME = 'com.agentstudio.browser'
export const CHROME_EXTENSION_ID = 'ochabcdefghijklmnopqrstuvwxyz12345' // 用 manifest key 算出的固定 id；实现时生成真实 key 并在测试锁定

type ChromeNativeCommand = 'ping' | 'cookies.sync' | 'tabs.snapshot' | 'tabs.open'

interface ChromeNativeRequest {
  id: string
  command: ChromeNativeCommand
  payload?: unknown
}

interface ChromeNativeCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite?: 'no_restriction' | 'lax' | 'strict'
}
```

硬限制：
- 单帧最大 1_048_576 字节
- `id` / `command` 字符串上限 128
- cookies 数组上限 500；单个 value 上限 4096
- 未知 command → 错误对象，不执行
- 日志只记 command/count/origin，禁止 value
- 黑名单 origin 跳过
- `cookieSyncEnabled === false` 时忽略 sync
- 不读、不写磁盘 Chrome Profile
- Native Host 清单只含本 host 命令路径白名单

Cookie 写入：`session.fromPartition(partition).cookies.set({ url, name, value, domain, path, secure, httpOnly, expirationDate })`。url 由 domain+path+secure 合成；非法 domain 跳过该条。

本任务 **不要求** 真 Chrome。用 mock payload 单测 parse + apply。`tabs.snapshot` parse 可以先收下并返回 `{ accepted: true }`，光标映射放 Task 6。

安装 Native Messaging manifest 的函数：

```ts
export function buildChromeNativeHostManifest(execPath: string): object
export async function installChromeNativeHostManifest(options: {
  homeDir: string
  execPath: string
}): Promise<string>
```

macOS 路径：`$homeDir/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.agentstudio.browser.json`。测试用临时 homeDir，禁止写开发者真 Chrome 目录。

- [ ] **Step 1: Failing tests**（超长拒绝、未知 command、黑名单跳过、value 不出现在 JSON.stringify(log) 夹具、v1 路径不读 Profile）
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Minimal implementation**
- [ ] **Step 4: Tests pass**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(p3-06): 用 Native Host 把扩展 Cookie 写入内置浏览器" --trailer "Made-with: Grok"
```

---

### Task 6: 配套 MV3 扩展、安装区、连接光标

**Files:**
- Create: `chrome-extension/agent-studio-browser/manifest.json`
- Create: `chrome-extension/agent-studio-browser/background.js`
- Create: `chrome-extension/agent-studio-browser/popup.html`（状态 only，**没有**「把当前标签交给 Agent」主按钮）
- Create: `chrome-extension/agent-studio-browser/README.md`（如何 unpacked 安装；中文）
- Modify: `src/renderer/src/components/HostBrowserSettingsPanel.vue`（安装按钮、上次同步时间）
- Modify: `src/shared/app-ipc.ts` 增加 `installHostBrowserExtension` / 扩展状态字段可放在 getSettings 派生信息或独立 get
- Modify: `src/shared/agent-pointer-overlay.ts` 与测试：配套扩展有限 pointer 可保留
- Modify: `src/main/browser/chrome/` 增加 snapshot → overlay DIP 映射
- Modify: `src/main/index.ts` 安装：把 unpacked 目录 reveal，并写入 Native Host 清单（测时注入 homeDir）

**光标合同：**

```text
screenX = windowScreenBounds.x + cssX * (windowScreenBounds.width / innerWidth)
```

更稳：扩展上报 `windowScreenBounds`（屏幕 DIP）、`dpr`、`zoom`、节点 `x,y,width,height`（viewport CSS）。主进程：

```
overlayX = windowScreenBounds.x + node.x * (dpr/dpr) / zoom - overlayBounds.x
```

实现时用与 host-browser 相同的 overlay `getBounds()` 回读。没有 `windowScreenBounds` → 不画针。

`createAgentPointerSnapshot`：`browser-plugin` 在 pointer 为有限数字时保留。更新测试「browser-plugin 恒丢弃 pointer」为「无几何仍丢弃；有限 DIP 保留」。ACP `browser-plugin-overlay.ts` 通道继续剥离 pointer（货架插件）。

扩展 background：
- 装上后 `chrome.runtime.connectNative(CHROME_NATIVE_HOST_NAME)`
- 定时/onChanged 调 `cookies.getAll` 后 `cookies.sync`（已在 Task 5）
- 不解析 Profile 文件
- popup 只显示「已连接 / 未连接」

设置页安装：
- 按钮「安装配套扩展」→ 主进程 reveal unpacked 目录 + 安装 native host manifest
- 文案：打开 Chrome 扩展页，启用开发者模式，加载已解压的扩展

- [ ] **Step 1: Failing tests**（manifest 无 give-tab 文案、popup 源码不含「交给 Agent」、pointer 有 DIP 保留、无 bounds 不画、ACP 通道仍剥 pointer）
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Minimal implementation**
- [ ] **Step 4: Tests + eslint + `pnpm typecheck` + `git diff --check`**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(p3-06): 落地配套扩展并在已连接时画出插件光标" --trailer "Made-with: Grok"
```

---

## 验收标准

- [ ] 设置 → 浏览器按 §1.7 分组可见，不再是单开关
- [ ] 用户只说话即可打开内置页；snapshot/navigate 都会开右栏
- [ ] 智能体权限出厂四列始终允许；谨慎模式出厂关；browse=always 时 browser 不弹卡，写文件仍弹
- [ ] `chrome-extension/agent-studio-browser/` 可 unpacked 安装
- [ ] Native Host 默认同步扩展 Cookie 到内置 partition，不解析磁盘 Profile；卸扩展或关同步即停（关开关后不再 apply）
- [ ] 扩展已连并带窗 DIP 时 overlay 画出 `browser-plugin` 针；无几何不发明
- [ ] 相关新增核心函数/IPC/权限边界有中文注释；测试只用假凭据
- [ ] 目标 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 通过

## 非目标（本计划不做）

- P3-07 Helper / `computer-use` surface producer
- 解析磁盘 Chrome Profile、同步密码库（API 未接）
- 导入浏览器数据按钮
- 把桌面做成 MCP Host
- 为对标依赖 Codex 私有二进制
