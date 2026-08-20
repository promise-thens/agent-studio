# P0-10B 设置弹窗与外观 实施计划

> **状态：** 2026-08-20 代码已落地；单元测试 570、typecheck、build 通过。开发版三主题走查待做。
>
> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务落地。步骤使用复选框 (`- [ ]`) 跟踪。

**优先级：** P0-A / 权重 3（工作台设置壳；不阻塞 Runtime 主线）

**目标：** 已配置 Provider 后，侧栏齿轮打开带左侧菜单的设置弹窗：第一项是现有供应商表单，第二项是外观（深色 / 米白 / 跟随系统）。首次未配置仍走全屏引导。

**Architecture：** 外观偏好由主进程版本化 JSON 持久化，经 `app:*` IPC 读写；`nativeTheme.themeSource` 在创建窗口前生效，Renderer 只消费 `{ mode, resolved }` 并写到 `html[data-theme]`。设置弹窗是工作台上的 overlay，不替换首次引导。

**Tech Stack：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。不新增 UI 框架。

**Spec：** 产品确认见会话设计：三选默认深色；首次全屏引导；弹窗两项（供应商 / 外观）；不抄 Claude 的 Privacy、字体、代码高亮。

## Global Constraints

- Node `>=20`，本机验证优先 22/24；pnpm 10。
- 新增 IPC 使用 `app:*`，不得新增 `grok:*`。
- API Key 不得进入外观存储、日志或 Renderer。
- 配置写 `app.getPath('userData')`，目录 `0700`、文件 `0600`，原子写入。
- 继续同一套 CSS 变量，米白只换 token，不引入第二套组件库。
- 首次 Provider 配置完成前不展示可误操作的工作台。
- 执行任务期间可以改主题（只动 UI）。
- 中文注释写原因和边界；协议字段保持英文。

---

## 非目标

- 不复制 Claude 设置里的 Search、Privacy、Usage、Skills、Plugins、代码字体、Transcript 宽窄、语法高亮主题。
- 不把首次引导改成挡在工作台上的强制弹窗。
- 不把外观存进 `localStorage` 或 Provider 配置。
- 不修改 `~/.grok`。

## 数据流

```text
齿轮 click
→ SettingsDialog overlay（默认供应商页）
→ 外观单选
→ window.app.setAppearance({ mode })
→ 主进程校验 → AppearanceStore 原子写入
→ nativeTheme.themeSource + BrowserWindow.setBackgroundColor
→ push app:appearance { mode, resolved }
→ Renderer 写 html[data-theme] / data-color-mode / color-scheme
```

系统外观变化：仅当 `mode === 'system'` 时，`nativeTheme` `updated` 重新解析 `resolved` 并推送。

## 安全边界

- Renderer 不能指定 channel、路径或任意 JSON。
- `setAppearance` 只接受 `{ mode }`，`mode` 必须是 `dark | light | system`。
- 推送 payload 在 Preload 再解析一次，非法丢弃。
- 损坏 / 超大 / 未知版本的外观文件回退默认 `dark`，不抛给 UI 堆栈。
- Handler 校验主窗口来源，字符串限长。

## 文件范围

**创建：**

- `src/shared/app-appearance.ts`、`src/shared/app-appearance.test.ts`
- `src/main/appearance/appearance-store.ts`、`appearance-store.test.ts`
- `src/main/appearance/appearance-controller.ts`、`appearance-controller.test.ts`
- `src/renderer/src/settings-dialog.ts`、`settings-dialog.test.ts`
- `src/renderer/src/components/SettingsDialog.vue`

**修改：**

- `src/shared/app-ipc.ts`、`src/shared/agent-ipc.test.ts`
- `src/main/app-ipc.ts`、`src/main/app-ipc.test.ts`
- `src/main/index.ts`（组装；`createWindow` 读已解析背景色）
- `src/preload/desktop-api.ts`、`desktop-api.test.ts`、`index.d.ts`
- `src/renderer/src/App.vue`、`ProjectSidebar.vue`、`ProviderOnboarding.vue`
- `src/renderer/src/assets/base.css`、`main.css`
- `src/renderer/index.html` 保持默认 dark，避免未 hydrate 闪白
- `docs/superpowers/plans/roadmap-index.md`、`AGENTS.md`、`CLAUDE.md`

## 已锁定 UI

```text
┌ 设置 ✕ ─────────────────────────────────┐
│ 供应商   │  右侧：当前页                  │
│ 外观     │  供应商 = 现有表单（无全屏品牌头）│
└──────────┴──────────────────────────────┘
```

外观三项：深色（现有 token）/ 米白 / 跟随系统（系统浅色→米白，系统深色→现有深色）。默认深色。

Esc、点遮罩、右上角关闭。保存供应商成功不强制关弹窗。清除配置后关闭弹窗。

米白 token（约值，可微调对比度，不可改成冷灰 GitHub Light）：

| token | 米白 |
| --- | --- |
| `--app-bg` | `#f4efe6` |
| `--surface-1` | `#f7f3eb` |
| `--surface-2` | `#efe8db` |
| `--surface-3` | `#e6dccb` |
| `--border` | `#d9cdb8` |
| `--text-1` | `#2c261f` |
| `--accent` | 仍用 `#d98252` |

---

### Task 1: 共享外观契约

**Files:**

- Create: `src/shared/app-appearance.ts`
- Test: `src/shared/app-appearance.test.ts`

**Produces:**

```ts
export const APP_APPEARANCE_MODES = ['dark', 'light', 'system'] as const
export type AppAppearanceMode = (typeof APP_APPEARANCE_MODES)[number]
export type AppResolvedAppearance = 'dark' | 'light'
export interface AppAppearanceState {
  mode: AppAppearanceMode
  resolved: AppResolvedAppearance
}
export const DEFAULT_APP_APPEARANCE_MODE: AppAppearanceMode = 'dark'
export const APP_APPEARANCE_BACKGROUNDS: Record<AppResolvedAppearance, string> = {
  dark: '#0d1117',
  light: '#f4efe6'
}
export function isAppAppearanceMode(value: unknown): value is AppAppearanceMode
export function resolveAppearance(
  mode: AppAppearanceMode,
  systemPrefersDark: boolean
): AppResolvedAppearance
export function appearanceWindowBackground(resolved: AppResolvedAppearance): string
```

- [ ] **Step 1: 写失败测试**

```ts
it('跟随系统时按 OS 深浅解析，显式模式忽略 OS', () => {
  expect(resolveAppearance('system', true)).toBe('dark')
  expect(resolveAppearance('system', false)).toBe('light')
  expect(resolveAppearance('light', true)).toBe('light')
  expect(resolveAppearance('dark', false)).toBe('dark')
})
```

- [ ] **Step 2: 跑测试确认失败**（缺模块）
- [ ] **Step 3: 最小实现**
- [ ] **Step 4: 测试通过**

---

### Task 2: AppearanceStore

**Files:**

- Create: `src/main/appearance/appearance-store.ts`
- Test: `src/main/appearance/appearance-store.test.ts`

**Produces:** `AppearanceStore`：`userData/config/appearance.json`；`initialize()` 缺文件/损坏/未知版本 → `dark`；`save(mode)` 原子写 `{ schemaVersion: 1, mode, updatedAt }`。

- [ ] 用临时目录测：默认 dark、保存后新实例读回、损坏 JSON 回退、非法 mode 回退、不写密钥字段。

---

### Task 3: AppearanceController

**Files:**

- Create: `src/main/appearance/appearance-controller.ts`
- Test: `src/main/appearance/appearance-controller.test.ts`

**Produces:** 注入 `NativeThemeAdapter { shouldUseDarkColors, themeSource, onUpdated }`。`initialize` / `setMode` 设置 `themeSource`（`system`→`'system'`，否则 `'dark'|'light'`），返回 `AppAppearanceState`。系统 `updated` 仅在 `mode==='system'` 且 `resolved` 变化时回调。

---

### Task 4: App IPC + Preload

**Files:**

- Modify: `src/shared/app-ipc.ts`、`src/shared/agent-ipc.test.ts`
- Modify: `src/main/app-ipc.ts`、`src/main/app-ipc.test.ts`
- Modify: `src/preload/desktop-api.ts`、`desktop-api.test.ts`、`index.d.ts`

**Produces:**

```ts
APP_INVOKE_CHANNELS.getAppearance = 'app:get-appearance'
APP_INVOKE_CHANNELS.setAppearance = 'app:set-appearance'
APP_PUSH_CHANNELS.appearance = 'app:appearance'
```

`setAppearance` 请求仅 `{ mode }`。未知字段 / 非法 mode → `invalid-input`。来源拒绝先于存储。

`AppDesktopApi` 增加 `getAppearance`、`setAppearance(mode)`、`onAppearanceChanged`（返回清理函数）。Preload 解析 push，非法 payload 不回调。

---

### Task 5: 主进程组装

**Files:** Modify `src/main/index.ts`（及 electron mock 如需 `nativeTheme`）

**步骤：** `initializeServices` 里 `AppearanceStore` + `AppearanceController.initialize()`。`createWindow` 的 `backgroundColor` 用 `appearanceWindowBackground(state.resolved)`。`nativeTheme.updated` 时更新窗口背景并 `sendToTrustedRenderer(..., APP_PUSH_CHANNELS.appearance, state)`。`registerAppIpcHandlers` 注入 get/set。

GitNexus：改 `registerAppIpcHandlers` 的上游是 `registerIpcHandlers`（LOW）。

---

### Task 6: Renderer 设置壳与主题应用

**Files:**

- Create: `src/renderer/src/settings-dialog.ts` + 测试、`components/SettingsDialog.vue`
- Modify: `App.vue`、`ProviderOnboarding.vue`、`ProjectSidebar.vue`、`base.css`、`main.css`

**Produces:**

```ts
export type SettingsSection = 'provider' | 'appearance'
export function resolveSettingsSection(value: unknown): SettingsSection
export function applyResolvedAppearance(resolved: AppResolvedAppearance, root?: Pick<HTMLElement, ...>): void
```

`applyResolvedAppearance` 写 `data-theme`、`data-color-mode`、`style.colorScheme`。

- `showProviderScreen` **不再**包含 `showProviderSettings`；仅 `boot !== 'ready' && projects.length === 0`。
- 工作台齿轮打开 `SettingsDialog` overlay（`.modal-backdrop`）。
- `ProviderOnboarding` 增加 `layout: 'page' | 'embedded'`；embedded 隐藏品牌头和「返回工作台」。
- 侧栏按钮 title 改为「设置」。
- CSS：`:root` 深色；`html[data-theme="light"]` 与 `@media (prefers-color-scheme: light) { html:not([data-theme="dark"]) }` 米白。
- 把 `rgba(255,255,255,0.04)` 等 hover 改成 `color-mix(in srgb, var(--text-1) 6%, transparent)`，避免米白上发白斑。

---

### Task 7: 验证与文档

- [ ] `pnpm test`、目标文件 ESLint、`pnpm typecheck`、`pnpm build`、`git diff --check`
- [ ] 更新 `roadmap-index.md`、`AGENTS.md`、`CLAUDE.md` 当前进度
- [ ] 开发版手工：首次仍全屏；配好后齿轮开弹窗；三主题；跟随系统；小窗关闭/Esc

## 验收标准

- [ ] 未配置且无 Project：仍是全屏供应商引导，看不到工作台弹窗。
- [ ] 已配置：齿轮打开弹窗，工作台仍在背后；默认供应商页。
- [ ] 外观三选可用，重启后保持；跟随系统随 OS 浅/深在米白/深色间切换。
- [ ] 保存后 Key 仍只显示「已保存」；外观文件无密钥。
- [ ] 深色 token 仍是一套变量；米白只覆盖值。
- [ ] 自动测试覆盖解析、存储回退、IPC 校验与 Preload 解析。
