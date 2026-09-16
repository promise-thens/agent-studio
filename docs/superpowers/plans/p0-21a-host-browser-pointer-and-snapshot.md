# P0-21a 内置页指针 Overlay 与可交互 Snapshot 实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。步骤使用复选框 (`- [ ]`) 跟踪。
>
> **Spec：** [2026-09-16-host-browser-pointer-overlay-design.md](../specs/2026-09-16-host-browser-pointer-overlay-design.md)
>
> **状态：** 任务 1–4 代码已落地。任务 5 文档与自动验证以本任务命令为准；开发版 GUI 未走查。不包含 P3-07 Helper。不得宣称任意 App Computer Use / P0-19f 插件虚拟鼠标完成。

**Goal：** 右栏内置页能被 Grok 点到搜索框和关闭按钮，并在现有 overlay 上画出可滑动软件光标；overlay DTO 成为后续 Computer Use 的接入面。

**Architecture：** 抽出 `agent-pointer-overlay` 共享快照。插件路径继续不投影 pointer。宿主 click/type 的 viewport CSS 经窗口+view bounds 映射成 overlay DIP。Snapshot 改为 dialog/可交互优先，上限 150。同一扇 P0-19f 透明置顶窗，不新开全屏窗，不申请辅助功能。

**Tech Stack：** Electron 39、Vue 3、TypeScript、Vitest、现有 overlay 窗与 `WebContentsView`。

## Global Constraints

- IPC 只用 `agent:*` / `app:*` / `task:*`，不得新增 `grok:*`。
- `clientCapabilities` 保持 `{}`。
- 不移动系统指针；无 CGEvent / Accessibility / ScreenCaptureKit。
- 插件 `click_at` 仍不得画光标。
- `computer-use` surface 本波无 producer。
- 坐标不进 MCP 回包、Timeline、日志。
- 中文注释写原因和边界；协议字段保持英文。
- 用户已有未跟踪文件必须保留。

---

### Task 1: 共享指针 DTO 与 DIP 映射

**Files:**
- Create: `src/shared/agent-pointer-overlay.ts`
- Create: `src/shared/agent-pointer-overlay.test.ts`
- Modify: `src/shared/browser-plugin-overlay.ts`（改 re-export / 消费共享类型，`projectBrowserPluginPointer` 仍恒 `undefined`）
- Modify: `src/shared/browser-plugin-overlay.test.ts`（pointer 仍不得出现）

**Interfaces:**
- Consumes: 无
- Produces: `AgentPointerSurface`、`AgentPointerSnapshot`、`mapViewportCssToOverlayDip`、`shouldRenderAgentPointerCursor`、`resolveAgentPointerHudCopy`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  mapViewportCssToOverlayDip,
  resolveAgentPointerHudCopy,
  shouldRenderAgentPointerCursor
} from './agent-pointer-overlay'

describe('mapViewportCssToOverlayDip', () => {
  it('把 view 内 CSS 点映射为 overlay 本地 DIP', () => {
    const pointer = mapViewportCssToOverlayDip({
      cssX: 40,
      cssY: 60,
      zoomFactor: 1,
      contentBounds: { x: 100, y: 80, width: 1200, height: 700 },
      viewBounds: { x: 200, y: 40, width: 640, height: 640 },
      overlayBounds: { x: 0, y: 0, width: 1440, height: 900 }
    })
    expect(pointer).toEqual({ x: 340, y: 180 })
  })

  it('点在 view 矩形外则不投影', () => {
    expect(
      mapViewportCssToOverlayDip({
        cssX: 9000,
        cssY: 10,
        zoomFactor: 1,
        contentBounds: { x: 0, y: 0, width: 800, height: 600 },
        viewBounds: { x: 0, y: 0, width: 400, height: 400 },
        overlayBounds: { x: 0, y: 0, width: 800, height: 600 }
      })
    ).toBeUndefined()
  })
})

describe('HUD', () => {
  it('宿主进行中用内置浏览器句；插件用原句；接管优先', () => {
    expect(
      resolveAgentPointerHudCopy({
        surface: 'host-browser',
        overlayVisible: true,
        turnActive: true,
        takeoverCopy: null
      })
    ).toBe('Grok 正在使用内置浏览器')
    expect(
      shouldRenderAgentPointerCursor({
        visible: true,
        surface: 'host-browser',
        persistWhenUnfocused: false,
        pointer: { x: 1, y: 1 }
      })
    ).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run src/shared/agent-pointer-overlay.test.ts
```

预期：模块不存在而失败。

- [ ] **Step 3: 最小实现**

`mapViewportCssToOverlayDip` 按 spec 公式；zoom 非有限或 <=0 返回 undefined。`createAgentPointerSnapshot` 不得在 surface=`computer-use` 时被宿主/插件调用方使用（本任务只提供类型）。plugin overlay 的 `parse` / `create` 改为基于共享 snapshot，并继续丢弃 plugin pointer。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm exec vitest run src/shared/agent-pointer-overlay.test.ts src/shared/browser-plugin-overlay.test.ts
```

- [ ] **Step 5: 提交（仅当用户要求 git commit）**

---

### Task 2: Snapshot 可交互优先

**Files:**
- Modify: `src/main/browser/host-browser-actions.ts`
- Modify: `src/main/browser/host-browser-actions.test.ts`

**Interfaces:**
- Consumes: 现有 `Accessibility.getFullAXTree` 形状（`nodeId` / `childIds` / `role` / `name` / `ignored` / `backendDOMNodeId`）
- Produces: 上限 150；dialog 子孙 + 可交互角色优先；click/type 主进程侧可读取 viewport 点（MCP 回包仍不含坐标）

- [ ] **Step 1: 失败测试**

在 `host-browser-actions.test.ts` 增加：

1. 前 200 个 `link` 热搜 + 末尾一个 `textbox`「搜索」→ snapshot 含该 textbox，`truncated: true`，长度 <= 150。
2. `alertdialog` 子树里无名 `button` 出现在清单前部。
3. 旧用例「120 个超长 name link 截到 80」改为截到 **150**，name 仍 <= 200。
4. click 成功后，主进程动作结果带 viewport 点；序列化给 MCP 的 `toCallResult` 路径不得含 `viewportX`（在 Task 3 或本任务对 stdio 测试补一条）。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run src/main/browser/host-browser-actions.test.ts
```

- [ ] **Step 3: 改 `flattenAxTree`**

收集顺序：dialog/alertdialog 子树 → 可交互角色（含无名 button）→ 其余可见节点。上限 `MAX_SNAPSHOT_NODES = 150`。click/type 在 `quadCenter` 后把 `{ viewportX, viewportY }` 留在引擎内部字段或结果 `data` 的主进程专用分支；stdio `toCallResult` 若看到这些键必须剥掉。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm exec vitest run src/main/browser/host-browser-actions.test.ts src/main/browser/host-browser-mcp.test.ts
```

---

### Task 3: 宿主 Service 驱动 overlay 指针

**Files:**
- Modify: `src/main/browser/host-browser-service.ts` 及测试
- Modify: `src/main/browser-plugin-overlay.ts` 及测试
- Modify: `src/main/index.ts`（组装：窗口 bounds、失焦、view bounds 交给 overlay；不把几何写进 handler 细节）

**Interfaces:**
- Consumes: Task 2 的 viewport 点、`mapViewportCssToOverlayDip`
- Produces: `OverlayHost.acceptHostBrowserPointer` / `clearHostBrowserPointer`；失焦清针；`persistWhenUnfocused` 恒 false

- [ ] **Step 1: 失败测试**

- 成功 click 后 session 快照 `surface === 'host-browser'` 且 pointer 为映射后的 DIP。
- view 关闭或主窗口 `blur`：pointer 省略。
- `acceptBrowserTool` 插件 rawInput 仍无 pointer。
- 无任何测试把 `surface` 设成 `computer-use`。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm exec vitest run src/main/browser/host-browser-service.test.ts src/main/browser-plugin-overlay.test.ts
```

- [ ] **Step 3: 接线**

`HostBrowserService.perform` 成功 click/type 后通知 overlay。`index.ts` 在 `BrowserWindow` blur/minimize 和 `setOpen(false)` 时 `clearHostBrowserPointer`。overlay `show` / 指针映射用主窗所在屏（`resolveOverlayDisplayBounds`），换屏时 `relayout`。pointer 出 view 矩形则不画。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm exec vitest run src/main/browser src/main/browser-plugin-overlay.test.ts src/shared/agent-pointer-overlay.test.ts
```

---

### Task 4: Overlay UI 按 surface 显示

**Files:**
- Modify: `src/renderer/src/overlay/OverlayApp.vue`
- Modify: `src/main/browser-plugin-overlay.test.ts`（源码断言：无 CGEvent；有 host-browser 文案；cursor 节点仍仅 `snapshot.pointer` 时挂载）

**Interfaces:**
- Consumes: `AgentPointerSnapshot`
- Produces: 芯片文案随 surface；Turn 结束闲置光标无芯片；`prefers-reduced-motion` 已有则保留

- [ ] **Step 1: 失败测试 / 源码断言**

现有 overlay 测试已读 `OverlayApp.vue` 字符串。补：

- 含「Grok 正在使用内置浏览器」
- cursor `v-if="snapshot.pointer"`
- 不含 `CGEvent` / `Accessibility`

- [ ] **Step 2: 改 Vue**

`resolveAgentPointerHudCopy`；`turnActive === false` 时不渲染停止芯片但仍渲染 pointer。过渡 180ms。

- [ ] **Step 3: 跑测试**

```bash
pnpm exec vitest run src/main/browser-plugin-overlay.test.ts
```

---

### Task 5: 文档与自动验证

**Files:**
- Modify: `docs/superpowers/plans/p0-21-host-managed-browser.md`（任务 5 HUD 部分改为消费本 overlay；内置页允许软件光标）
- Modify: `docs/superpowers/plans/p0-19f-browser-computer-use-surface.md`（插件仍不画；宿主页走 21a）
- Modify: `docs/superpowers/plans/p3-07-macos-computer-use-helper.md`（消费 `agent-pointer-overlay`，不自建光标窗）
- Modify: `docs/superpowers/plans/roadmap-index.md`、`docs/product-vision.md` §7.3 快照、`AGENTS.md`、`CLAUDE.md`

- [x] **Step 1: 同步文档** — 明确：未宣称 P3-07 / 插件虚拟鼠标完成。
- [x] **Step 2: 自动验证**

```bash
node --version
pnpm --version
pnpm exec eslint src/shared/agent-pointer-overlay.ts src/shared/browser-plugin-overlay.ts src/main/browser src/main/browser-plugin-overlay.ts src/renderer/src/overlay src/preload/overlay.ts --no-cache
pnpm exec vitest run src/shared/agent-pointer-overlay.test.ts src/shared/browser-plugin-overlay.test.ts src/main/browser src/main/browser-plugin-overlay.test.ts src/preload/overlay.test.ts
pnpm typecheck
pnpm build
git diff --check
```

- [ ] **Step 3: 开发版 GUI**（执行者记录日期；未走查不得标完成）

最低路径见 spec §10。

**走查记录（2026-09-16）：** 本任务 **未跑** 开发版 GUI。不得宣称「内置页光标可用」、P0-19f 插件虚拟鼠标完成或任意 App Computer Use 完成。

---

## 验收标准

- [x] 可交互优先 snapshot 有测试。
- [ ] 宿主 click 能画出 overlay 光标；失焦消失。← 代码与聚焦测试已有；开发版 GUI 未走查，不得宣称可见。
- [x] 插件路径仍无 pointer。
- [x] 无 Helper、无系统鼠标、无 `grok:*` IPC。
- [ ] 自动验证通过；GUI 走查有记录后才能宣称「内置页光标可用」。← 自动验证已过（2026-09-16）；GUI 未跑。
- [x] 不得宣称任意 App Computer Use 已完成。
