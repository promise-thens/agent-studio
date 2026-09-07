# P0-19f 浏览器 / Computer Use 插件表面 实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
>
> **状态：** 待开始。2026-09-07 产品确认：本计划做 **可见光标 HUD（方案 A）**，不做系统鼠标注入（方案 B / P3-07）。
>
> **插入点：** [P0-19](p0-19-grok-host-capability-polish.md) 插件 Computer Use / 外置浏览器表面。前置：P0-10E 能安装市场插件；GACP-03 不得把 browser/screen/clipboard 放进「本任务写文件」grant。
>
> **2026-09-04：** Codex 式「和 Agent 看同一页」改由 [P0-21](p0-21-host-managed-browser.md)，本计划 **不** 自建 WebContentsView。若 P0-21 尚未改策略，**本计划负责**把 `browser` / `screen` / `clipboard` 从 `deny + unsupported` 改成 L3 审批；P0-21 不得再改回去。本计划覆盖 **Grok 插件自己的** browser / screen / clipboard（chrome-devtools、computer-use 等）。[P3-05](p3-05-managed-browser.md) 不再作为本计划的后续。

**优先级：** P0-A 能力层 / 权重 4（Grok 已经能靠插件上网和点 GUI；桌面缺审批、证据、停止和可见光标）

**Goal：** 用户安装并信任 Grok 的浏览器 / Computer Use 类插件后：相关工具走 L3、截图进 Artifacts、进行中有可见停止；屏幕类 Computer Use 另有始终置顶、可穿透点击的虚拟光标 HUD。桌面不自建 BrowserView、不读用户 Chrome Profile、不发系统鼠标事件。

**Architecture：** 执行仍是 Grok 插件。桌面做四件事：

1. **权限：** `browser` / `screen` / `clipboard` 为 L3；目标尽量投影为 origin 或 app 名；没有可信目标就 unknown，不能自动过，不能被写文件 grant 复用。
2. **证据：** 插件截图若已落在 execution root 或已冻结的 Grok session 图片目录，注册为 Task Artifact；Timeline 只存 artifact 引用。
3. **窗口内停止条：** 未完成的 browser/screen 工具或未决 L3 时，主窗口显示不可拖丢的停止条（复用 `cancelTurn`）。
4. **虚拟光标 HUD（A）：** `screen` / Computer Use 进行中，独立透明置顶层画光标。主窗口最小化或失焦时仍可见。光标只跟随观察冻结的坐标字段；没有坐标就只留停止芯片，不猜位置。叠加层除停止芯片外点击穿透，不拦截插件自己的点击。

**Tech Stack：** Electron 39 透明 `BrowserWindow`（`alwaysOnTop` + `setIgnoreMouseEvents`）、现有插件页、Permission Broker、P0-13 Artifact、P0-11 evidence、runtime media 路径、electron-vite 增加 overlay 入口。

**Spec：** [P0-19](p0-19-grok-host-capability-polish.md)；本文件即实施方案。方案 A 已于 2026-09-07 确认。方案 B（Accessibility / CGEvent 真控鼠标）仍是 [P3-07](p3-07-macos-computer-use-helper.md)，本计划禁止提前做。

## Global Constraints

- 沿用 P0-19。
- IPC 只用 `agent:*` / `app:*` / `task:*`，不得新增 `grok:*`。
- `clientCapabilities` 保持 `{}`。
- Inspector 顶层标签不增加 `browser`。截图走 `artifacts`，动作走 `timeline`。
- 不实现 CDP 转发、Playwright 进程、Native Messaging、Accessibility Helper。
- 不调用 Accessibility / ScreenCaptureKit / CGEvent 移动或点击系统光标。不申请辅助功能权限来画 HUD。
- `_meta` / `rawInput` 默认丢掉；只有观察冻结的字段能进公开事件（坐标同 P0-19e 纪律）。
- 不把插件 stderr、cookie、页面全文、绝对路径写入日志、Timeline 或 overlay。
- 安装源仍只允许 P0-10E 已校验的货架 name。
- Titlebar / overlay 可点控件必须 `-webkit-app-region: no-drag`，有 `title` 或 `aria-label`。
- 保留 `prefers-reduced-motion`：光标可瞬移，不要强制缓动。
- 中文注释写原因和边界；协议字段保持英文。

---

## 非目标

- 不做共享 DOM 标注、WebMCP、Edge/Chrome 扩展桥（P3-06）。
- 不做 macOS Computer Use Helper，不注入系统鼠标（P3-07 / 方案 B）。
- 不为每个网站做桌面内嵌登录浏览器（共享页走 P0-21）。
- 不把虚拟光标画进 P0-21 的 WebContentsView。
- 不实现 `get_command_or_subagent_output` 轮询器，不把 Computer Use 输出写进 Inspector「终端」。
- 不把 overlay 做成第二条 Task 或第二条 Runtime。

## 方案 A 与方案 B 的冻结

| | 方案 A（本计划） | 方案 B（P3-07，后置） |
| --- | --- | --- |
| 谁在点 | Grok 插件 | Agent Studio Helper |
| 光标 | 置顶 HUD 画出来 | 真的移动系统指针 |
| 系统权限 | 不需要辅助功能 | Accessibility + 屏幕录制 |
| 主窗口在后台 | HUD 仍可见 | Helper 仍可点任意 App |
| 停止 | `cancelTurn` | Helper 紧急停止 + cancelTurn |

「后台虚拟光标」= Agent Studio 失焦时 HUD 仍画在桌面上，**不是**后台偷偷控鼠标。

## 数据流

```text
用户在插件页安装并信任 chrome-devtools 或 computer-use
  → 下一 session Grok 加载 MCP
Grok 申请 browser / screen / clipboard
  → mapper 标 operationType；URL 能解析则 target.kind=origin
  → Broker L3：once 或拒绝；已有写文件 allow-task 不得 grant-reused
  → 允许后 Grok 插件执行
  → 截图走已允许路径 → P0-13 Artifact；失败不阻断 Turn
  → Timeline 工具行 + Artifacts 缩略图

browser 进行中或未决 L3
  → 主窗口停止条：「Grok 正在使用浏览器插件」

screen / Computer Use 进行中或未决 L3 屏幕权限
  → 主窗口停止条 + 置顶 overlay
  → 若 tool 事件带冻结坐标：overlay 光标移到该点
  → 若无坐标：overlay 只留停止芯片，不发明光标位置
用户点 overlay 停止或 Composer 停止
  → 现有 cancelTurn
  → overlay 与停止条消失，文案不得再声称正在控制
```

## 安全边界

- L3 不能被 GACP-03 / 写文件 `allow-task` 捎带。测试：先 `allow-task` 写文件，再 `browser` / `screen` / `clipboard`，必须再弹卡。
- 接管（P0-19g）下 L3 **不再弹卡**（已确认的接管本意）。HUD / overlay 在已安装相关插件时必须提到屏幕或浏览器，停止仍可用。
- Artifact 沿用 P0-13：opaque id、路径白名单、类型 png/jpeg/webp。恶意 SVG 不执行。
- Overlay 窗口：`skipTaskbar`；除停止芯片外 `setIgnoreMouseEvents(true, { forward: true })`，避免挡住插件点击。停止芯片 hover 时临时关闭穿透。
- 坐标只接受有限数字；NaN、Infinity、超屏幕很多的值丢弃，光标隐藏。
- Overlay 不读键盘、不截屏自己、不把 display 列表或窗口标题送给 Renderer 以外的协议。
- 内嵌用户信息的 URL 拒绝投影 origin（与 Provider URL 纪律一致）。
- HUD / overlay 停止失败返回脱敏错误，不含路径和原始异常。

## 文件范围

- 修改：`src/main/security/permission-policy.ts`（browser/screen/clipboard 从 deny 改为 L3 approval；`browser` 允许 `origin` 目标）
- 修改：`src/main/runtime/grok/grok-acp-mappers.ts` 权限映射与可选坐标白名单
- 修改：P0-13 Artifact 注册从 runtime 图片接到当前 Task（若尚未接线）
- 修改：主窗口停止条（与 P0-19g 共用一条，文案按模式区分；不要 Composer / Task 头 / App 各做一套）
- 创建：`src/main/computer-use-overlay.ts`（主进程 overlay 窗口生命周期）
- 创建：最小 overlay 渲染入口（electron-vite extra input + 单页 Vue），只画光标和停止芯片
- 创建：观察记录 `docs/superpowers/plans/grokACP计划/observations/p0-19f-computer-use-pointer-observation.md`
- 测试：grant 不捎带；无坐标不发明光标；停止关闭 overlay；无截图降级；overlay 源码不含 Accessibility / CGEvent
- 走查：装插件 → L3 卡 → 允许后 HUD；screen 类另见 overlay；停止后消失

公开状态（任务 3–4 共用，可放 `src/shared/computer-use-overlay.ts`）：

```ts
export type ComputerUseOverlayKind = 'browser' | 'screen'

/** 主进程投影给 overlay / 主窗口 HUD 的可序列化快照。缺 pointer 表示只显示停止，不画光标。 */
export interface ComputerUseOverlaySnapshot {
  visible: boolean
  kind: ComputerUseOverlayKind
  pointer?: { x: number; y: number }
}
```

坐标单位：相对 **当前 overlay 所在 display** 的 DIP。多屏首期只跟主屏或 pointer 所在屏之一，禁止猜其它屏。

---

### 任务 1: 堵住 grant 捎带，打开 L3

**任务目标：** `browser` / `screen` / `clipboard` 可审批，且不能被写文件通行证带走。

- [ ] **第 1 步: 失败测试**

说明：`evaluatePermissionPolicy` 对这三类不再 `deny + unsupported`，改为 `approval` + L3 + `allowedScopes: ['once']`（不要 `task` 宽 grant）。同一 Task 先 `allow-task` 写文件，再来这三类，Broker 必须再弹，不能 `grant-reused`。

- [ ] **第 2 步: origin 目标**

说明：`OPERATION_TARGET_KINDS.browser` 增加 `origin`。mapper：Grok 已给 URL 则校验后投影 origin；userinfo / query 里的 secret 丢掉；解析失败则 `unknown` + L3。`screen` / `clipboard` 仍可 `unknown`。禁止从 title 正则猜 URL。

- [ ] **第 3 步: 提交**

`test(p0-19f): keep browser screen clipboard as L3 once-only`

### 任务 2: 截图进 Artifact

**任务目标：** 插件截图可审阅，失败不卡死 Turn。

- [ ] **第 1 步: 复用 P0-13 注册**

说明：只注册已允许路径上的 png/jpeg/webp。失败不阻断 Turn，Timeline 标记「无可用截图」。不把绝对路径给 Renderer。

- [ ] **第 2 步: Artifacts 列表**

说明：标题用脱敏后的工具摘要（例如「屏幕截图」），opaque artifact id。

- [ ] **第 3 步: 提交**

`feat(p0-19f): register computer-use screenshots as artifacts`

### 任务 3: 主窗口停止条

**任务目标：** 控制期间主窗口永远有停止入口；普通写文件不要出这根条。

- [ ] **第 1 步: 进行中条件**

说明：当前 Task 有未完成的 `browser` / `screen` 工具，或有未决 L3 屏幕/浏览器权限。与 P0-19g 完全访问 HUD 共用一条停止，文案区分：「完全访问中」vs「Grok 正在使用浏览器插件」vs「Grok 正在使用屏幕」。`no-drag`，有 `aria-label`。停止 = 现有 `cancelTurn`。

- [ ] **第 2 步: 测试**

说明：写文件 in_progress 不出条；browser in_progress 出条；cancel 后消失。

- [ ] **第 3 步: 提交**

`feat(p0-19f): show stop hud while plugin browser or screen runs`

### 任务 4: 虚拟光标 HUD（方案 A）

**任务目标：** 屏幕类 Computer Use 进行中，失焦也能看见光标或停止芯片；桌面不移动系统指针。

- [ ] **第 1 步: 观察坐标字段**

说明：对照 Grok computer-use / screen 工具的 ACP `tool_call` / `tool_call_update`。记录哪些键稳定（例如 `x`/`y`、`coordinate`、`position`）。没有稳定字段：overlay 只显示停止芯片，**禁止**用截图像素或 title 猜点。写进 `observations/p0-19f-computer-use-pointer-observation.md`，方法写清 `sdk+docs+binary` 或隔离 ACP，不得冒充未跑的真机。`observations/README.md` 加指针。

- [ ] **第 2 步: 冻结白名单并投影**

说明：仅当冻结键是有限数字时写入 `ComputerUseOverlaySnapshot.pointer`。测试：未知键 / `_meta` / 假 Key / 非数字 → 无 pointer。系统不得出现 `CGEvent`、`AXUIElement`、`robotjs`、`nut-js`。

- [ ] **第 3 步: overlay 窗口**

说明：主进程创建透明置顶窗口，覆盖 pointer 所在 display（首期一块屏）。`alwaysOnTop`、`skipTaskbar`、macOS 尽量 `visibleOnFullScreen`。除停止芯片外点击穿透。主窗口 blur / 最小化时 overlay 仍显示。Turn 结束、cancel、无进行中 screen 工具 → destroy 或 hide。新 electron-vite overlay 入口只含光标 + 停止芯片，不加载整站工作台。

- [ ] **第 4 步: 停止芯片**

说明：芯片调用现有 `cancelTurn`，不新 channel。`aria-label` 例如「停止屏幕控制」。失败出脱敏错误。`prefers-reduced-motion` 下光标瞬移。

- [ ] **第 5 步: 提交**

`feat(p0-19f): show click-through overlay cursor for screen tools`

### 任务 5: 走查与文档快照

- [ ] **第 1 步: 自动走查意图**

说明：单元/源码测试锁：无 Accessibility；screen 无坐标时 DOM 无移动光标；browser 不强制打开 overlay；停止后 `visible: false`。

- [ ] **第 2 步: 开发版走查（本任务不宣称已过）**

说明：装插件 → 公开页或 localhost → L3 → 允许后主窗口 HUD；若有 screen 工具则 overlay；停止后不再声称控制。拒绝权限则无截图、无 overlay。未跑 GUI 不得打勾「开发版 GUI 已过」。

- [ ] **第 3 步: 文档**

说明：同步 `AGENTS.md` / `CLAUDE.md` 第 15 节、roadmap、P0-19 程序索引。P0-21 注明插件 HUD 光标在 19f，内置页仍不画虚拟光标。product-vision §7.3 区分插件 HUD 与 Helper。

## 验收标准

- [ ] 写文件授权不能捎带浏览器 / 屏幕 / 剪贴板。
- [ ] 有截图则进 Artifact；无截图有明确降级。
- [ ] 控制期间主窗口停止入口始终可见。
- [ ] screen / Computer Use 进行中：Agent Studio 失焦时 overlay 仍在；无坐标不发明光标。
- [ ] 没有 BrowserView、没有读用户 Chrome、没有系统鼠标注入。
- [ ] 自动验证 + 开发版走查记录（走查未跑则保持未过）。
