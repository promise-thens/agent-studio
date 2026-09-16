# 内置浏览器指针 Overlay 与 Computer Use 底座 设计

> 日期：2026-09-16
> 状态：代码已落地，待 GUI
> 相关：[p0-21-host-managed-browser.md](../plans/p0-21-host-managed-browser.md)、[p0-21a-host-browser-pointer-and-snapshot.md](../plans/p0-21a-host-browser-pointer-and-snapshot.md)、[p0-19f-browser-computer-use-surface.md](../plans/p0-19f-browser-computer-use-surface.md)、[p3-07-macos-computer-use-helper.md](../plans/p3-07-macos-computer-use-helper.md)

## 1. 这一波实际做什么

用户要把「虚拟鼠标 / 关弹窗」提前做，并且 **把 overlay 做成后续 Computer Use 能接上的底座**，而不是给内置页单独糊一只光标。

本波交付：

1. **可交互优先的 `browser_snapshot`**，让搜索框、关闭按钮进入清单。
2. **通用指针 overlay 协议**：同一扇已有的透明置顶窗，按 `surface` 区分来源。
3. **第一个 producer：宿主内置浏览器**。`browser_click` / `browser_type` 已有 `getContentQuads`，可以诚实映射到 overlay DIP，画出可滑动的软件光标。
4. **为 `computer-use` 预留 surface 与映射口**。P3-07 Helper 以后只负责把 AX frame 变成同一套 DIP，不再自建第二只光标窗。

本波不交付：

- 不申请辅助功能 / 屏幕录制。
- 不实现 `list_apps` / `get_app_state` / 点 Notes、微信、系统 Chrome。
- 不移动系统指针，不调用 CGEvent / SkyLight。
- 不把插件 `click_at` 的 viewport-css 画到桌面（P0-19f 冻结仍有效）。
- 不做 Codex 弹簧物理、锁屏接管、全屏 Computer Use 遮罩。

关网页对话框：**不是**新 API。Grok 对快照里的关闭按钮 `browser_click`。

## 2. 为什么这样拆

Codex 能画虚拟鼠标，是因为 Helper 自己持有控件的屏幕几何。模型只报 `element_index`。

我们现在：

| 来源 | 几何在哪 | 能不能画 |
| --- | --- | --- |
| 宿主内置页 `getContentQuads` | 主进程，相对我们自己的 `WebContentsView` | 能。窗口 + view bounds 已知。 |
| 插件 chrome-devtools `click(uid)` / `click_at` | 别人的 Chrome，ACP 无屏幕 DIP | 不能。继续不发明光标。 |
| 未来 Computer Use AX frame | Helper 读到的屏幕矩形 | 能。接到同一 overlay。 |

所以提前做的「Computer Use 简单一些」，指的是 **overlay 快照、HUD、停止、坐标空间、失焦策略** 先成为稳定接口，而不是把 P3-07 整包提前。

## 3. Overlay 协议（CU 底座）

现有 P0-19f 全屏透明 `BrowserWindow`（`alwaysOnTop`、click-through、停止芯片、`.overlay-cursor` 已有 120ms 过渡）继续用，不新开第二扇全屏窗。

新增共享模块 `src/shared/agent-pointer-overlay.ts`（plugin overlay 改为消费它，避免两套 DTO）。

```ts
type AgentPointerSurface = 'host-browser' | 'browser-plugin' | 'computer-use'

interface AgentPointer {
  x: number
  y: number
}

interface AgentPointerSnapshot {
  visible: boolean
  surface: AgentPointerSurface
  taskId?: string
  turnId?: string
  executionId?: string
  pointer?: AgentPointer
  persistWhenUnfocused: boolean
}
```

约定：

- `pointer` 的 `x/y` **已经是 overlay 窗口本地 DIP**。Renderer 只 `translate`，不再换算、不猜。
- 谁生产谁映射。映射失败则 **省略 pointer**，DOM 不得挂光标节点。
- `browser-plugin`：继续走 `projectBrowserPluginPointer`，恒为 `undefined`。
- `host-browser`：仅主进程用 view 矩形映射成功后写入。
- `computer-use`：本波只出现在类型联合里。任何代码路径不得伪造该 surface 的 pointer。
- `persistWhenUnfocused`：宿主页为 `false`（主窗口失焦/最小化立刻清指针，避免 alwaysOnTop 把箭头留在别的 App 上）。未来 Helper 对前台目标 App 可为 `true`。本波没有任何调用方传 `true`。

HUD 文案：

| surface | 进行中 | Turn 已结束但仍显示闲置光标 |
| --- | --- | --- |
| `host-browser` | Grok 正在使用内置浏览器 | 无芯片，只留光标 |
| `browser-plugin` | Grok 正在使用浏览器插件（现句） | 隐藏 overlay |
| `computer-use` | 本波不出现 | — |

停止仍走 `agent:cancel-turn`。芯片 `aria-label` 跟 surface 走。接管文案（P0-19g）仍优先。

可见性：

- 插件：保持现状（执行中且有未决 browser L3 或未完成插件 browser 工具）。
- 宿主：右栏打开，且本 Task 有过一次成功映射的 click/type；或当前有进行中的宿主 browser 动作 / 未决 browser 审批。
- 两路同时存在时：overlay 仍一扇窗；HUD 优先进行中的那路；pointer 只画 **当前有合法映射** 的那一路，禁止把插件 rawInput 和宿主四边形混成一个点。

## 4. 宿主坐标映射

主进程已有：

- 主窗口 `getContentBounds()`（屏幕 DIP）
- `WebContentsView` 的 bounds（相对 content view）
- click/type 时 `DOM.getContentQuads` 的视口 CSS 像素
- overlay 窗 bounds（主窗所在屏，由 `resolveOverlayDisplayBounds` 选交集最大的 display；不得钉死 `getPrimaryDisplay`）

映射：

```text
screenX = contentBounds.x + viewBounds.x + cssX / zoomFactor
screenY = contentBounds.y + viewBounds.y + cssY / zoomFactor
overlayX = screenX - overlayBounds.x
overlayY = screenY - overlayBounds.y
```

然后与「view 的 overlay 矩形」求交。点在矩形外 → 不写 pointer。

`zoomFactor` 默认 1；非有限数字视为失败。不读系统鼠标，不用辅助功能补几何。

窗口移动、resize、显示器变化：用 **上次成功的 viewport CSS 点** 重新映射；view 已卸或右栏关闭则清指针。

`browser_click` / `browser_type` 的动作结果在主进程内带上 `{ viewportX, viewportY }`，**不得**把该坐标写进 MCP 回包、Timeline 或日志。

## 5. Snapshot：可交互优先

现状：`Accessibility.getFullAXTree` 按数组顺序取前 80 个非 ignored 节点。百度首页导航占满名额，搜索框进不来。

改为：

1. 仍用同一 CDP 白名单，不 `evaluate`。
2. 若树里有 `dialog` / `alertdialog`，其子孙（含无名按钮）优先。
3. 其余按可交互角色优先：`button`、`link`、`textbox`、`searchbox`、`combobox`、`checkbox`、`radio`、`slider`、`tab`、`menuitem`、`switch`、`listbox`、`option`、`spinbutton`。无名 `button` 也收。
4. 名额填不满再补其它可见节点。
5. 上限从 80 提到 **150**。`truncated` 语义不变。name 仍截到 200 字。
6. `ref` 仍是本次 snapshot 内 `e1…`，离开页面即失效。Renderer 拿不到 ref。

不在本波做 snapshot 分页 API、不按截图像素猜控件。

## 6. 光标行为

- 第一次成功 click/type：光标出现在落点。
- 下一次：CSS `transform` 滑过去（现 overlay 已有 ~120ms；可收到 180ms）。`prefers-reduced-motion` 瞬移。
- 两次动作之间停在原地（你选的 Codex 闲置态）。
- 用户自己点页面：软件光标 **不跟随** 用户鼠标。
- 纯 `browser_navigate`：不移动光标（没有四边形）。
- 右栏关闭、Task 切换、主窗口失焦/最小化、guest 销毁：隐藏光标。
- 不做弹簧积分、不做 252px fog lens。光标是准星+圆心，原点对准 click 落点。

## 7. 数据流

```text
Grok MCP browser_click(ref)
  → HostBrowserService.perform → Broker（browser L3 + origin）
  → ActionEngine：scrollIntoView + getContentQuads + dispatchMouseEvent
  → 主进程留下 viewport 点
  → mapViewportCssToOverlayDip
  → OverlayHost.acceptPointer({ surface: 'host-browser', pointer })
  → overlay 窗 showInactive，光标 translate

未来 P3-07（不在本波执行）：
  Helper AX frame（屏幕 DIP）
  → mapScreenRectCenterToOverlayDip
  → OverlayHost.acceptPointer({ surface: 'computer-use', persistWhenUnfocused: true })
```

权限：宿主动作仍是 `operationType: 'browser'`。画光标不是新的 IPC 业务，不把 pointer 经 Preload 交给主 Renderer。只推 overlay 那条已有通道。

## 8. 文件范围（预计）

- 新增：`src/shared/agent-pointer-overlay.ts` 及测试
- 修改：`src/shared/browser-plugin-overlay.ts`（改消费共享 DTO，plugin pointer 仍恒空）
- 修改：`src/main/browser-plugin-overlay.ts`（surface、宿主 pointer、失焦清理）
- 修改：`src/main/browser/host-browser-actions.ts`（交互优先 snapshot；click/type 回传 viewport 点给主进程，不进 MCP）
- 修改：`src/main/browser/host-browser-service.ts`（映射并通知 overlay）
- 修改：`src/renderer/src/overlay/OverlayApp.vue`（按 surface 文案；闲置无芯片）
- 修改：`src/main/index.ts` 只组装，不把几何堆进入口
- 文档：本文件、`p0-21` 状态、roadmap、P0-19f 指针冻结「宿主页除外」、P3-07 注明消费本 overlay、AGENTS.md / CLAUDE.md 进度快照

不改 `clientCapabilities`。不新增 `grok:*` IPC。

## 9. 安全

- Guest 仍 sandbox、无 preload、无 App IPC。
- Overlay 仍独立 preload，只有快照 / 停止 / 芯片 hover。
- 坐标不进 Timeline、日志、MCP 文本。
- 插件路径不得调用宿主映射函数。
- `computer-use` surface 本波无 producer；测试断言没有任何路径能在无 Helper 时写出该 surface。
- `screen` / `clipboard` 仍 deny。

## 10. 验收

自动：

- 导航节点占满时，textbox / 对话框关闭按钮仍出现在 snapshot 里。
- 无名 button 可被收入。
- 150 上限与 truncated。
- 宿主 viewport 点映射到 overlay DIP，出 view 矩形则无 pointer。
- 插件 rawInput 仍投影不出 pointer。
- 失焦策略：`persistWhenUnfocused: false` 时 pointer 被清。
- 无 CGEvent / Accessibility 导入出现在宿主映射模块。

开发版 GUI：

- 新 Task，打开右栏百度（或 example.com）。
- 「点搜索框，输入 agent-studio 并搜索」→ 看见光标滑到输入框，页面真的输入。
- 若出现弹窗，「关掉它」→ snapshot 能点到关闭，光标落到该按钮。
- 切到其它 App：光标消失，不得停在桌面上。
- 不装 chrome-devtools 时，不得出现插件 HUD 句。

不得宣称：已支持任意 Mac App Computer Use、已完成 P0-19f 插件虚拟鼠标、已完成 P3-07。
