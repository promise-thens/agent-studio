# P0-19f 插件操作浏览器表面 实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。步骤使用复选框 (`- [ ]`) 跟踪。
>
> **状态：** 任务 1–5 代码已落地。任务 6 overlay 窗口与停止芯片已落地，**虚拟鼠标硬验收未过**（ACP 指针键 not-observed；`click_at` 为 viewport-css，不可映射到 overlay 屏幕 DIP；未发明光标）。任务 7 自动验证已过；**开发版 GUI 未走查**。`screen` / `clipboard` 仍 deny。不得宣称计划完成。2026-09-07 产品对齐：**本计划只做插件操作浏览器**；**虚拟鼠标是硬验收**；点桌面软件 / `screen` / `clipboard` 后置到软件表面 / P3-07。方案 A 置顶 HUD 光标，不注入系统鼠标（方案 B / P3-07）。
>
> **插入点：** [P0-19](p0-19-grok-host-capability-polish.md) 插件浏览器表面。前置：P0-10E 能安装市场插件；GACP-03 不得把 `browser` 放进「本任务写文件」grant。
>
> **文件名：** 保留 `p0-19f-browser-computer-use-surface.md` 以免断链。范围已从「browser / screen / clipboard / Computer Use」收成「插件操作浏览器」。
>
> **2026-09-04：** Codex 式「和 Agent 看同一页」仍由 [P0-21](p0-21-host-managed-browser.md) 负责，本计划 **不** 自建 WebContentsView。[P3-05](p3-05-managed-browser.md) 不再作为本计划的后续。

**优先级：** P0-A 能力层 / 权重 4（Grok 已经能靠插件上网；桌面缺审批、证据、停止和可见虚拟鼠标）

**Goal：** 用户安装并信任 Grok 官方货架上的浏览器插件后：相关工具走 `browser` L3、截图进 Artifacts、进行中有可见停止，并且 **必须看见虚拟鼠标**。桌面不操作桌面软件、不自建 BrowserView、不读用户 Chrome Profile、不发系统鼠标事件。

**Architecture：** 执行仍是 Grok 插件（chrome-devtools / browser-use / tinyfish）。桌面做四件事：

1. **权限：** 只打开 `browser` 为 L3；目标尽量投影为 origin；没有可信目标就 unknown，不能自动过，不能被写文件 grant 复用。`screen` / `clipboard` 本计划保持 `deny + unsupported`。
2. **证据：** 插件截图若已落在 execution root 或已冻结的 Grok session 图片目录，注册为 Task Artifact；Timeline 只存 artifact 引用。失败不阻断 Turn。
3. **窗口内停止条：** 未完成的 browser 工具或未决 L3 浏览器权限时，主窗口显示不可拖丢的停止（复用 `cancelTurn`，与 P0-19g 共用一条 HUD，文案区分）。
4. **虚拟光标 HUD（A，硬验收）：** 浏览器插件进行中，独立透明置顶层画虚拟鼠标。主窗口最小化或失焦时仍可见。光标只跟随观察冻结且可映射到屏幕 DIP 的坐标；**禁止**用 uid、截图像素、title 猜点。没有可映射坐标则 **不得宣称虚拟鼠标已完成**。叠加层除停止芯片外点击穿透。

**Tech Stack：** Electron 39 透明 `BrowserWindow`（`alwaysOnTop` + `setIgnoreMouseEvents`）、现有插件页、Permission Broker、P0-13 Artifact、P0-11 evidence、runtime media 路径、electron-vite 增加 overlay 入口。

**Spec：** [P0-19](p0-19-grok-host-capability-polish.md)；本文件即实施方案。2026-09-07 确认：范围是插件浏览器 + 虚拟鼠标，不是 Computer Use。

## Global Constraints

- 沿用 P0-19。
- IPC 只用 `agent:*` / `app:*` / `task:*`，不得新增 `grok:*`。
- `clientCapabilities` 保持 `{}`。
- Inspector 顶层标签不增加 `browser`。截图走 `artifacts`，动作走 `timeline`。
- 不实现 CDP 转发、Playwright 进程、Native Messaging、Accessibility Helper。
- 不调用 Accessibility / ScreenCaptureKit / CGEvent 移动或点击系统光标。不申请辅助功能权限来画 HUD。
- `_meta` / `rawInput` 默认丢掉；只有观察冻结的字段能进公开状态（坐标同 P0-19e 纪律）。
- 不把插件 stderr、cookie、页面全文、绝对路径写入日志、Timeline 或 overlay。
- 安装源仍只允许 P0-10E 已校验的货架 name。
- Titlebar / overlay 可点控件必须 `-webkit-app-region: no-drag`，有 `title` 或 `aria-label`。
- 保留 `prefers-reduced-motion`：光标可瞬移，不要强制缓动。
- 中文注释写原因和边界；协议字段保持英文。
- 不得把仓库测试夹具里的 `computer-use` MCP 名当成官方货架插件。

---

## 产品冻结（2026-09-07）

| 这期做 | 这期不做 |
| --- | --- |
| 插件操作 **浏览器** | 插件或 Helper 操作 **桌面软件** |
| `browser` 从 `deny + unsupported` 改为 L3 | 打开 `screen` / `clipboard` |
| 虚拟鼠标 HUD（方案 A） | 注入系统鼠标（方案 B / P3-07） |
| chrome-devtools / browser-use / tinyfish | 自建 WebContentsView（P0-21） |
| 截图 Artifact + 主窗口停止 | 把虚拟光标画进 P0-21 内置页 |

**虚拟鼠标一定要有。** 不是「有坐标才画、没有就只留停止条也算过」。停止条是必要护栏，不能替代虚拟鼠标。坐标来源以任务 1 观察为准，禁止猜点。

### 对应的浏览器插件

官方货架（`xai-org/plugin-marketplace`，2026-09-07 核对 22 项）里和「操作浏览器」对得上的是：

| 货架 name | 已装 id（若不同） | 作用 |
| --- | --- | --- |
| `chrome-devtools` | `chrome-devtools-mcp` | 控制本机活的 Chrome：导航、快照、点元素、截图。P0-10E 安装样例，**本计划主路径**。 |
| `browser-use` | 以 registry 为准 | 用户自己的 Chrome（带登录）或云浏览器。 |
| `tinyfish` | 以 registry 为准 | 托管式网页自动化。 |

货架上 **没有** 名为 `computer-use` 的官方插件。点桌面 App 不是这期。

默认 `chrome-devtools` 点击是 `click(uid)`（无障碍树），不是屏幕坐标。带坐标的 `click_at(x, y)` 需插件 `--experimentalVision`，默认未开。桌面 **不得** 为了画光标去改用户插件 MCP 启动参数。

### 与相邻计划

| 计划 | 关系 |
| --- | --- |
| P0-21 | 宿主右栏内置页。共享 `browser` L3 原则。谁先改策略谁打开 `browser`；后到者不得改回 `unsupported`。虚拟光标在本计划的插件 overlay，**不**画在 WebContentsView 上。 |
| P3-07 | 真控系统鼠标、点任意软件。后置。 |
| 以后的软件表面 | 打开 `screen` / `clipboard`、Computer Use 类插件。未立项，不在本文件实现。 |

`browser` 策略与 P0-21 对齐，避免两份计划互撕：

- `approval` + L3
- `allowedScopes: ['once', 'task']`
- `OPERATION_TARGET_KINDS.browser = ['origin', 'unknown']`
- grant 键必须含 origin（不同 origin 不能互相复用）
- 写文件 / 普通命令 grant 不能 `grant-reused` 成 browser

## 非目标

- 不做共享 DOM 标注、WebMCP、Edge/Chrome 扩展桥（P3-06）。
- 不做 macOS Computer Use Helper，不注入系统鼠标（P3-07 / 方案 B）。
- 不打开 `screen` / `clipboard`。
- 不为每个网站做桌面内嵌登录浏览器（共享页走 P0-21）。
- 不把虚拟光标画进 P0-21 的 WebContentsView。
- 不实现 `get_command_or_subagent_output` 轮询器，不把插件输出写进 Inspector「终端」。
- 不把 overlay 做成第二条 Task 或第二条 Runtime。
- 不把 chrome-devtools 接到 P0-21 视图的调试端口。
- 不强制给插件加 `--experimentalVision`。

## 方案 A 与方案 B

| | 方案 A（本计划） | 方案 B（P3-07，后置） |
| --- | --- | --- |
| 谁在点 | Grok 浏览器插件 | Agent Studio Helper |
| 光标 | 置顶 HUD 画出来 | 真的移动系统指针 |
| 系统权限 | 不需要辅助功能 | Accessibility + 屏幕录制 |
| 主窗口在后台 | HUD 仍可见 | Helper 仍可点任意 App |
| 停止 | `cancelTurn` | Helper 紧急停止 + cancelTurn |

「后台虚拟光标」= Agent Studio 失焦时 HUD 仍画在桌面上，**不是**后台偷偷控鼠标，也不是点 Finder / 其它 App。

## 数据流

```text
用户在插件页安装并信任 chrome-devtools（或 browser-use / tinyfish）
  → 下一 session Grok 加载 MCP
Grok 申请 browser
  → mapper：工具名落在观察冻结的浏览器白名单，或冻结 URL 能解析
  → 校验后投影 origin；userinfo / query secret 丢掉；失败则 unknown + L3
  → Broker L3：once 或本任务该 origin；已有写文件 allow-task 不得 grant-reused
  → 允许后 Grok 插件执行（点的是插件自己的 Chrome，不是 P0-21 视图）
  → 截图走已允许路径 → P0-13 Artifact；失败不阻断 Turn
  → Timeline 工具行 + Artifacts 缩略图

browser 进行中或未决 L3
  → 主窗口停止 HUD：「Grok 正在使用浏览器插件」
  → 置顶 overlay：有可映射坐标则画虚拟鼠标；停止芯片始终可点
  → 无坐标：overlay 不得发明光标位置；计划级验收保持未完成
用户点 overlay 停止或 Composer 停止
  → 现有 cancelTurn
  → overlay 与停止文案消失，不得再声称正在控制浏览器
```

## 安全边界

- L3 不能被 GACP-03 / 写文件 `allow-task` 捎带。测试：先 `allow-task` 写文件，再 `browser`，必须再弹卡。
- `screen` / `clipboard` 本计划仍 `unsupported`。接管（P0-19g）下 `browser` **不再弹卡**（已确认的接管本意）。HUD / overlay 必须写「浏览器插件」，停止仍可用。
- Artifact 沿用 P0-13：opaque id、路径白名单、类型 png/jpeg/webp。恶意 SVG 不执行。
- Overlay 窗口：`skipTaskbar`；除停止芯片外 `setIgnoreMouseEvents(true, { forward: true })`，避免挡住插件自己的点击。停止芯片 hover 时临时关闭穿透。
- 坐标只接受有限数字；NaN、Infinity、超屏幕很多的值丢弃，光标隐藏。
- Overlay 不读键盘、不截屏自己、不把 display 列表或窗口标题送给 Renderer 以外的协议。
- 内嵌用户信息的 URL 拒绝投影 origin（与 Provider URL 纪律一致）。
- HUD / overlay 停止失败返回脱敏错误，不含路径和原始异常。

## 文件范围

- 创建：`docs/superpowers/plans/grokACP计划/observations/p0-19f-browser-plugin-pointer-observation.md`
- 创建：`src/shared/browser-origin.ts` 及测试（`parseBrowserOrigin`）
- 创建：`src/shared/browser-plugin-overlay.ts` 及测试（快照 DTO、HUD 文案、坐标校验）
- 创建：`src/main/browser-plugin-overlay.ts` 及测试（overlay 窗口生命周期）
- 创建：`src/preload/overlay.ts`、`src/renderer/overlay.html`、`src/renderer/src/overlay/main.ts`、`src/renderer/src/overlay/OverlayApp.vue`
- 修改：`src/main/security/permission-policy.ts`（只打开 `browser`；`screen` / `clipboard` 仍 deny）
- 修改：`src/main/security/permission-broker.test.ts`（写文件不得捎带；接管下 browser 可执行但仍要 overlay）
- 修改：`src/main/runtime/grok/grok-acp-mappers.ts`（浏览器工具白名单、origin、可选指针）
- 修改：P0-13 Artifact 注册从 runtime 图片接到当前 Task（若尚未接线）
- 修改：`src/renderer/src/components/TaskComposer.vue`（与 P0-19g 共用一条 HUD）
- 修改：`electron.vite.config.ts`（overlay 入口 + preload `isolatedEntries`，禁止沙箱 `require('./chunks/*')`）；必要时 `electron-builder.yml`
- 修改：`src/main/index.ts` 只组装 overlay 生命周期，不把窗口细节堆进入口
- 测试：grant 不捎带；screen 仍 deny；无坐标不发明光标；停止关闭 overlay；无截图降级；overlay 源码不含 Accessibility / CGEvent
- 走查：装 chrome-devtools → L3 卡 → 允许后主窗口 HUD + overlay；停止后消失

公开状态（任务 4–6 共用）：

```ts
/** 本计划只有浏览器插件一种 overlay，不为 screen 预留 kind。 */
export type BrowserPluginOverlayKind = 'browser'

/** 主进程投影给 overlay / 主窗口 HUD 的可序列化快照。缺 pointer 表示不得画光标。 */
export interface BrowserPluginOverlaySnapshot {
  visible: boolean
  kind: BrowserPluginOverlayKind
  taskId: string
  pointer?: { x: number; y: number }
}
```

坐标单位：相对 **当前 overlay 所在 display** 的 DIP。任务 1 必须写明插件给出的是屏幕 DIP 还是页面 viewport CSS 像素。viewport 坐标若没有无辅助功能的映射方法，视为 **不可映射**，不得按数值原样画到桌面上。多屏首期只跟主屏或 pointer 所在屏之一，禁止猜其它屏。

---

### 任务 1: 观察浏览器插件的 ACP 字段

**任务目标：** 冻结「哪些工具算操作浏览器」以及「虚拟鼠标坐标从哪来」。没有这张表，后面不得从 title 猜 URL，也不得发明光标。

**Files:**
- Create: `docs/superpowers/plans/grokACP计划/observations/p0-19f-browser-plugin-pointer-observation.md`
- Modify: `docs/superpowers/plans/grokACP计划/observations/README.md`

**Interfaces:**
- Consumes: 无代码接口。对照材料是 SDK 1.3 `schema.json`、chrome-devtools / browser-use 公开工具文档、Grok 二进制字符串。
- Produces: 观察表。任务 3 的工具名白名单、任务 6 的 pointer 键和坐标空间都以本表为准。

- [x] **第 1 步: 写观察记录（禁止冒充真机）**

方法写清 `sdk+docs+binary` 或隔离 ACP。真机 ACP 会话未跑就标明 **未做**，不得把夹具 `computer-use` 写进表。

观察文件必须包含：

```markdown
# P0-19f 浏览器插件字段观察

> 冻结浏览器工具白名单与虚拟鼠标坐标。method 必须可核验。没见到的字段写 not-observed。

## 0. 观察环境

| 项 | 值 |
| --- | --- |
| 记录日期 | YYYY-MM-DD |
| method | sdk+docs+binary / 隔离 ACP |
| Grok CLI | 版本 + commit |
| 真机 ACP 会话 | 未做 / 已做（脱敏） |

## 1. 货架插件

| 货架 name | 是否官方货架 | MCP 工具是否操作浏览器 | 备注 |
| --- | --- | --- | --- |
| chrome-devtools | 是 |  | 主路径 |
| browser-use | 是 |  |  |
| tinyfish | 是 |  |  |
| computer-use | 否 | 不得当货架项 | 测试夹具名 |

## 2. 映射为 operationType=browser 的工具名

只抄稳定 `toolCall.name`（或文档中的 MCP tool name）。禁止用中文 title。

| name | 来源 | 映射 |
| --- | --- | --- |
| navigate_page | chrome-devtools docs | browser |
| click | chrome-devtools docs | browser |
| click_at | chrome-devtools docs（需 experimentalVision） | browser |
| take_screenshot | chrome-devtools docs | browser |

未出现在本表的 name 不得标 browser。

## 3. 指针字段

| 键 | 结果 | 坐标空间 |
| --- | --- | --- |
| rawInput.x / rawInput.y | observed / not-observed | screen-DIP / viewport-css / unknown |
| rawInput.coordinate |  |  |
| rawInput.position |  |  |
| ToolCall 顶层 x/y | 预期 not-observed |  |

`_meta` 一律不读。

## 4. 冻结策略

1. 只按上表 name 映射 browser，禁止 title 正则猜 URL。
2. URL 只从冻结键拷贝，经 `parseBrowserOrigin`；失败则 unknown。
3. pointer 只在「键 observed 且空间 = screen-DIP（或已证明可映射）」时写入快照。
4. `click(uid)` 没有坐标 → 不得发明光标。
5. 本计划不打开 screen / clipboard。
```

- [x] **第 2 步: README 加指针**

在 `observations/README.md` 追加一段，格式与 P0-19e 条相同。

- [x] **第 3 步: 提交**

```bash
git add docs/superpowers/plans/grokACP计划/observations/p0-19f-browser-plugin-pointer-observation.md \
        docs/superpowers/plans/grokACP计划/observations/README.md
git commit -m "docs(p0-19f): freeze browser plugin tool and pointer observation"
```

**门：** 若第 3 节全部 not-observed，或坐标空间不可映射到屏幕 DIP，任务 6 **不得**标完成。任务 2–5 仍可继续。

---

### 任务 2: 打开 browser L3，堵住 grant 捎带

**任务目标：** `browser` 可审批；`screen` / `clipboard` 仍拒绝；写文件通行证带不走浏览器。

**Files:**
- Create: `src/shared/browser-origin.ts`
- Create: `src/shared/browser-origin.test.ts`
- Modify: `src/main/security/permission-policy.ts`
- Modify: `src/main/security/permission-policy.test.ts`
- Modify: `src/main/security/permission-broker.test.ts`

**Interfaces:**
- Consumes: 现有 `evaluatePermissionPolicy` / `createOperationGrantKey` / Broker `authorizeOperation`
- Produces:

```ts
/** 只接受 http(s)；剥路径/query/hash；userinfo 或解析失败返回 null。 */
export function parseBrowserOrigin(url: string): string | null
```

- [x] **第 1 步: 失败测试 — origin 纯函数**

```ts
import { parseBrowserOrigin } from './browser-origin'

it('http(s) URL 投影为 origin，userinfo 与残缺值返回 null', () => {
  expect(parseBrowserOrigin('https://example.com/path?q=1')).toBe('https://example.com')
  expect(parseBrowserOrigin('http://localhost:5173/')).toBe('http://localhost:5173')
  expect(parseBrowserOrigin('https://user:pass@example.com/')).toBeNull()
  expect(parseBrowserOrigin('file:///tmp/x')).toBeNull()
  expect(parseBrowserOrigin('not-a-url')).toBeNull()
})
```

- [x] **第 2 步: 失败测试 — 策略**

说明：扩展 `src/main/security/permission-policy.test.ts`。`createIntent('browser')` 默认目标若仍是 `unknown`，补一条 origin 目标。

```ts
it('browser 改为 L3 审批，screen 与 clipboard 仍 unsupported', () => {
  expect(
    evaluatePermissionPolicy({
      ...createIntent('browser'),
      targets: [{ kind: 'origin', value: 'https://example.com' }]
    })
  ).toEqual({
    kind: 'approval',
    risk: 'L3',
    allowedScopes: ['once', 'task']
  })
  expect(evaluatePermissionPolicy(createIntent('screen'))).toMatchObject({
    kind: 'deny',
    reason: 'unsupported'
  })
  expect(evaluatePermissionPolicy(createIntent('clipboard'))).toMatchObject({
    kind: 'deny',
    reason: 'unsupported'
  })
})

it('写文件 task grant 不能复用到 browser，不同 origin 不能互相复用', async () => {
  const writeResolved = await resolveOperationIntentTargets(createIntent('write-file'))
  const browserA = await resolveOperationIntentTargets({
    ...createIntent('browser'),
    targets: [{ kind: 'origin', value: 'https://a.example' }]
  })
  const browserB = await resolveOperationIntentTargets({
    ...createIntent('browser'),
    turnId: 'turn-2',
    targets: [{ kind: 'origin', value: 'https://b.example' }]
  })
  expect(createOperationGrantKey(writeResolved)).not.toBe(createOperationGrantKey(browserA))
  expect(createOperationGrantKey(browserA)).not.toBe(createOperationGrantKey(browserB))
})
```

Broker 集成：同一 Task 先 `allow-task` 写文件，再 `browser`，不得 `grant-reused`，必须再弹卡。接管下 `browser` 从「unsupported 不可执行」改为可 `auto-allowed`（P0-19g 本意）；改 `permission-broker.test.ts` 里「完全访问仍不把 browser 当成可执行」那条，browser 不再断言 `unsupported`，`screen` 仍是。

- [x] **第 3 步: 跑测试确认失败**

```bash
pnpm exec vitest run src/shared/browser-origin.test.ts src/main/security/permission-policy.test.ts src/main/security/permission-broker.test.ts
```

Expected: FAIL（`parseBrowserOrigin` 未定义，或 browser 仍 deny）。

- [x] **第 4 步: 最小实现**

`src/shared/browser-origin.ts`：

```ts
/** 浏览器授权只绑 origin，避免把完整 URL、账号或 query 里的 Secret 写进 grant。 */
export function parseBrowserOrigin(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  return parsed.origin
}
```

`evaluatePermissionPolicy`：把

```ts
if (['browser', 'screen', 'clipboard'].includes(intent.operationType)) {
  return { kind: 'deny', risk, reason: 'unsupported', allowedScopes: [] }
}
```

改成只拦 `screen` / `clipboard`。`browser` 走后面的 L3 分支（`allowedScopes: ['once']` 的 L3 默认），但本任务要求 browser 允许 `once` **和** `task`：为 `browser` 单开 `allowedScopes: ['once', 'task']`，不要把其它 L3（unknown 命令等）放宽成 task。

`OPERATION_TARGET_KINDS.browser` 改为 `['origin', 'unknown']`。

`createGrantKeyMaterial`：browser 必须把 origin target 算进去（走现有「精确目标」分支即可，禁止把 browser 做成和 write-file 一样的整类钥匙）。

- [x] **第 5 步: 跑测试确认通过**

```bash
pnpm exec vitest run src/shared/browser-origin.test.ts src/main/security/permission-policy.test.ts src/main/security/permission-broker.test.ts
```

Expected: PASS

- [x] **第 6 步: 提交**

```bash
git add src/shared/browser-origin.ts src/shared/browser-origin.test.ts \
        src/main/security/permission-policy.ts src/main/security/permission-policy.test.ts \
        src/main/security/permission-broker.test.ts
git commit -m "feat(p0-19f): open browser L3 without piggybacking file grants"
```

---

### 任务 3: mapper 把浏览器插件标成 browser

**任务目标：** Grok 的 chrome-devtools 等工具不再掉进 `unknown` 或 `fetch` 宽桶；有 URL 则投影 origin。

**Files:**
- Modify: `src/main/runtime/grok/grok-acp-mappers.ts`
- Modify: `src/main/runtime/grok/grok-acp-mappers.test.ts`

**Interfaces:**
- Consumes: 任务 1 的 name 白名单；`parseBrowserOrigin`
- Produces: `mapGrokPermissionRequest` 对白名单工具返回 `operationType: 'browser'`。公开事件仍不得含 `rawInput`。

授权快照可增加可选字段（不要把整份 rawInput 留下来）：

```ts
export interface GrokValidToolCallAuthorizationSnapshot {
  integrity: 'valid'
  toolCallId: string
  kind?: acp.ToolKind
  locationPaths: string[]
  diffPaths: string[]
  diffFingerprint?: string
  /** 仅任务 1 冻结的浏览器工具 name。 */
  browserToolName?: string
  /** 已通过 parseBrowserOrigin 的 origin。 */
  browserOrigin?: string
}
```

- [x] **第 1 步: 失败测试**

白名单以任务 1 表为准。下面用 chrome-devtools 文档名做骨架，实现时改成观察表抄下来的集合。

```ts
it('chrome-devtools 导航工具映射为 browser origin，不泄露 rawInput', () => {
  const request = mapGrokPermissionRequest(
    {
      sessionId: SESSION_ID,
      options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
      toolCall: {
        toolCallId: 'tool-nav',
        title: '打开内部页',
        kind: 'other',
        name: 'navigate_page',
        rawInput: { url: 'https://example.com/secret?token=fake-key', apiKey: FAKE_KEY }
      }
    },
    'permission-nav',
    'task-mapper',
    'turn-mapper',
    redactFakeText,
    true
  )
  expect(request).toMatchObject({
    operationType: 'browser',
    minimumRisk: 'L3',
    targets: [{ kind: 'origin', value: 'https://example.com' }]
  })
  expect(JSON.stringify(request)).not.toContain('rawInput')
  expect(JSON.stringify(request)).not.toContain(FAKE_KEY)
  expect(JSON.stringify(request)).not.toContain('token=')
})

it('未冻结的工具名即使 title 像网址也不得标 browser', () => {
  const request = mapGrokPermissionRequest(
    {
      sessionId: SESSION_ID,
      options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
      toolCall: {
        toolCallId: 'tool-edit',
        title: 'https://evil.example 看起来像浏览器',
        kind: 'edit',
        locations: [{ path: '/tmp/fixture/src/a.ts' }]
      }
    },
    'permission-not-browser',
    'task-mapper',
    'turn-mapper',
    redactFakeText,
    true
  )
  expect(request?.operationType).toBe('write-file')
})

it('带 userinfo 的 URL 降为 unknown 目标，不得投影 origin', () => {
  const request = mapGrokPermissionRequest(
    {
      sessionId: SESSION_ID,
      options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }],
      toolCall: {
        toolCallId: 'tool-userinfo',
        kind: 'other',
        name: 'navigate_page',
        rawInput: { url: 'https://user:pass@example.com/' }
      }
    },
    'permission-userinfo',
    'task-mapper',
    'turn-mapper',
    redactFakeText,
    true
  )
  expect(request).toMatchObject({
    operationType: 'browser',
    targets: [{ kind: 'unknown', value: 'Runtime 未提供可信的目标 origin。' }]
  })
  expect(JSON.stringify(request)).not.toContain('user:pass')
})
```

`name` 目前被 mapper 丢掉。本任务允许 **只**为白名单比对读取 `toolCall.name`，读完丢弃，不得写入公开事件。URL 只从任务 1 冻结的 rawInput 键读取（文档主路径是 `url`）。禁止从 title 正则猜 URL。

- [x] **第 2 步: 跑测试确认失败**

```bash
pnpm exec vitest run src/main/runtime/grok/grok-acp-mappers.test.ts
```

Expected: FAIL（仍是 unknown / fetch）。

- [x] **第 3 步: 最小实现**

在 `mapGrokOperation` 里，白名单 `browserToolName` 优先于 `kind === 'fetch'`。有 `browserOrigin` 则 target.kind=`origin`，否则 `unknown`。`kind === 'fetch'` 且能解析冻结 URL 时也可以标 `network-egress`（保持旧行为），不要把普通 fetch 全部改成 browser。

- [x] **第 4 步: 跑测试确认通过**

```bash
pnpm exec vitest run src/main/runtime/grok/grok-acp-mappers.test.ts
```

Expected: PASS。序列化结果不含 rawInput、假 Key、userinfo。

- [x] **第 5 步: 提交**

```bash
git add src/main/runtime/grok/grok-acp-mappers.ts src/main/runtime/grok/grok-acp-mappers.test.ts
git commit -m "feat(p0-19f): map browser plugin tools to L3 origin intents"
```

---

### 任务 4: 截图进 Artifact

**任务目标：** 插件截图可审阅，失败不卡死 Turn。

**Files:**
- Modify: 现有 Grok runtime media / Artifact 接线（`src/main/runtime/grok/grok-runtime-media.ts`、`src/main/artifact/artifact-registry.ts`、adapter 调用点）
- Test: 就近 `*.test.ts`

**Interfaces:**
- Consumes: `ArtifactRegistry.registerFileCandidate`；P0-13 路径白名单
- Produces: 成功时 Turn 绑定 opaque `artifactId`；失败时 Timeline 可展示「无可用截图」，不抛到 Turn

- [x] **第 1 步: 失败测试**

只注册已允许路径上的 png/jpeg/webp。chrome-devtools `take_screenshot` 的 `filePath` 若落在 execution root 或已冻结 session `images/` 目录，才注册。越界路径、svg、空文件：返回降级，不 throw 到 prompt。

```ts
it('允许路径上的 png 注册为 image artifact，绝对路径不进描述符', async () => {
  const descriptor = await registerBrowserPluginScreenshot({
    taskId: 'task-1',
    turnId: 'turn-1',
    absolutePath: join(executionRoot, 'screenshots', 'page.png')
  })
  expect(descriptor?.kind).toBe('image')
  expect(JSON.stringify(descriptor)).not.toContain(executionRoot)
})

it('越界路径或非图片不阻断，返回无截图', async () => {
  await expect(
    registerBrowserPluginScreenshot({
      taskId: 'task-1',
      turnId: 'turn-1',
      absolutePath: '/etc/passwd'
    })
  ).resolves.toBeNull()
})
```

函数名以实现为准；不要把绝对路径塞进 Timeline 事件。标题用脱敏后的短句，例如「屏幕截图」，不要用 URL 全文。

- [x] **第 2 步: 跑测试确认失败**

```bash
pnpm exec vitest run src/main/runtime/grok src/main/artifact/artifact-registry.test.ts
```

Expected: FAIL 或新文件未定义。

- [x] **第 3 步: 最小实现**

复用 `readGrokSessionMediaFile` / `registerFileCandidate`。失败只记脱敏原因。不要为截图新开 IPC。

- [x] **第 4 步: 跑测试确认通过后提交**

```bash
git commit -m "feat(p0-19f): register browser plugin screenshots as artifacts"
```

---

### 任务 5: 主窗口停止条

**任务目标：** 控制浏览器期间主窗口永远有停止入口；普通写文件不要出这根浏览器文案。

**Files:**
- Create: `src/shared/browser-plugin-overlay.ts`（若任务 6 尚未建，本任务先放 HUD 纯函数）
- Create: `src/shared/browser-plugin-overlay.test.ts`
- Modify: `src/renderer/src/components/TaskComposer.vue`
- Modify: `src/renderer/src/workbench-walkthrough.test.ts` 或 Composer 就近测试

**Interfaces:**
- Consumes: 现有 `resolveTakeoverHudCopy`、`cancelTurn`、`BrowserPluginOverlaySnapshot.visible`
- Produces:

```ts
export const BROWSER_PLUGIN_HUD_COPY = 'Grok 正在使用浏览器插件'

/** 接管文案优先；否则浏览器插件进行中显示本句。写文件进行中返回 null。 */
export function resolveBrowserPluginHudCopy(input: {
  takeoverCopy: string | null
  overlayVisible: boolean
}): string | null {
  if (input.takeoverCopy) return input.takeoverCopy
  if (input.overlayVisible) return BROWSER_PLUGIN_HUD_COPY
  return null
}
```

- [x] **第 1 步: 失败测试**

```ts
it('写文件进行中不出浏览器 HUD，browser overlay 可见时出停止文案', () => {
  expect(
    resolveBrowserPluginHudCopy({ takeoverCopy: null, overlayVisible: false })
  ).toBeNull()
  expect(
    resolveBrowserPluginHudCopy({ takeoverCopy: null, overlayVisible: true })
  ).toBe('Grok 正在使用浏览器插件')
  expect(
    resolveBrowserPluginHudCopy({
      takeoverCopy: '完全访问中，不再询问权限',
      overlayVisible: true
    })
  ).toBe('完全访问中，不再询问权限')
})
```

Composer：与 `.composer-takeover-hud` 共用一条 `role="status"`，不要再做第三套条。停止按钮仍走现有 `emit('stop')` → `cancelTurn`。`no-drag`，`aria-label` 保留。

主进程何时把 `overlayVisible=true`：当前 Task 有未完成的 `operationType=browser` 工具，或有未决 browser L3。写文件 in_progress 不得置 true。本任务可用纯函数 + 假快照测 UI；真正的窗口在任务 6。

- [x] **第 2 步: 跑测试 → 实现 → 再跑**

```bash
pnpm exec vitest run src/shared/browser-plugin-overlay.test.ts src/renderer/src/workbench-walkthrough.test.ts
```

- [x] **第 3 步: 提交**

```bash
git commit -m "feat(p0-19f): show stop hud while plugin browser runs"
```

---

### 任务 6: 虚拟光标 HUD（方案 A，硬验收）

> **2026-09-07 快照：** overlay 窗口 + 停止芯片已落地（`2f6b8f0` / `90ca64a`）。`projectBrowserPluginPointer` 恒返回 `undefined`；DOM 无 `.overlay-cursor`。**本任务不得打勾。** 阻塞：任务 1 冻结 ACP 指针键 not-observed；`click_at` 为 viewport-css，禁止用 Accessibility / 窗几何补映射。停止芯片 ≠ 虚拟鼠标。

**任务目标：** 浏览器插件进行中，失焦也能看见虚拟鼠标；桌面不移动系统指针。

**前置：** 任务 1 第 3 节必须有可映射到屏幕 DIP 的冻结键。否则停止本任务并写明阻塞原因，**不要**画一个假光标然后打勾。

**Files:**
- Create: `src/main/browser-plugin-overlay.ts`
- Create: `src/main/browser-plugin-overlay.test.ts`
- Create: `src/preload/overlay.ts`
- Create: `src/renderer/overlay.html`
- Create: `src/renderer/src/overlay/main.ts`
- Create: `src/renderer/src/overlay/OverlayApp.vue`
- Modify: `src/shared/browser-plugin-overlay.ts`（`projectBrowserPluginPointer`、快照）
- Modify: `electron.vite.config.ts`
- Modify: `src/main/index.ts`（组装，不堆细节）
- Modify: `src/shared/agent-ipc.ts` 或 `src/shared/task-ipc.ts`（push channel）

**Interfaces:**
- Consumes: 任务 1 冻结的 pointer 键；任务 5 的 HUD 文案；`agent:cancel-turn`
- Produces:

```ts
/** 仅当冻结键是有限数字且未远离当前 display 时返回指针。 */
export function projectBrowserPluginPointer(
  rawInput: unknown,
  bounds: { width: number; height: number }
): { x: number; y: number } | undefined
```

Push channel 建议：`task:browser-plugin-overlay`（中性 `task:*`，不要 `grok:*`）。Overlay preload **只**暴露：

- `onSnapshot(listener): () => void`
- `cancelTurn(): Promise<DesktopIpcResult<void>>`

禁止把完整 `window.agent` / `window.app` / `window.electron` 注入 overlay。

- [ ] **第 1 步: 失败测试 — 指针投影**

```ts
it('只拷贝冻结的有限数字坐标，未知键与非数字没有 pointer', () => {
  expect(
    projectBrowserPluginPointer({ x: 120, y: 80 }, { width: 1440, height: 900 })
  ).toEqual({ x: 120, y: 80 })
  expect(projectBrowserPluginPointer({ x: '120', y: 80 }, { width: 1440, height: 900 })).toBeUndefined()
  expect(projectBrowserPluginPointer({ _meta: { x: 1, y: 1 } }, { width: 1440, height: 900 })).toBeUndefined()
  expect(projectBrowserPluginPointer({ x: Number.NaN, y: 0 }, { width: 1440, height: 900 })).toBeUndefined()
  expect(
    projectBrowserPluginPointer({ x: 10_000_000, y: 0 }, { width: 1440, height: 900 })
  ).toBeUndefined()
})
```

键名必须改成任务 1 表里的。测试夹具用假坐标，不要真 Key。

- [ ] **第 2 步: 失败测试 — overlay 源码纪律**

```ts
it('overlay 主进程与渲染源不含系统鼠标注入', () => {
  const sources = [
    readFileSync(join(mainDir, 'browser-plugin-overlay.ts'), 'utf8'),
    readFileSync(join(overlayDir, 'OverlayApp.vue'), 'utf8')
  ].join('\n')
  expect(sources).not.toMatch(/CGEvent|AXUIElement|robotjs|nut-js|ScreenCaptureKit/)
})

it('无 pointer 时快照不得带 pointer 字段', () => {
  const snapshot = createBrowserPluginOverlaySnapshot({
    visible: true,
    taskId: 'task-1',
    pointer: undefined
  })
  expect(snapshot.pointer).toBeUndefined()
  expect(snapshot.kind).toBe('browser')
})
```

- [ ] **第 3 步: 跑测试确认失败**

```bash
pnpm exec vitest run src/shared/browser-plugin-overlay.test.ts src/main/browser-plugin-overlay.test.ts
```

Expected: FAIL

- [ ] **第 4 步: overlay 窗口**

主进程创建透明置顶窗口，覆盖 pointer 所在 display（首期一块屏）。

- `alwaysOnTop: true`、`skipTaskbar: true`、`transparent: true`、`frame: false`
- macOS 尽量 `visibleOnFullScreen`
- 除停止芯片外 `setIgnoreMouseEvents(true, { forward: true })`
- 主窗口 blur / 最小化时 overlay 仍显示
- Turn 结束、cancel、无进行中 browser 工具 → hide 或 destroy
- 新 electron-vite 入口只含光标 + 停止芯片，不加载整站工作台
- sandbox + contextIsolation；独立 overlay preload

停止芯片：`aria-label`「停止浏览器控制」；调用现有 `cancelTurn`，不新业务 channel。失败出脱敏错误。`prefers-reduced-motion` 下光标瞬移。

无 pointer 时：**可以**显示停止芯片，但 DOM 里不得出现移动中的光标节点。这 **不** 等于任务 6 验收通过。

- [ ] **第 5 步: 跑测试确认通过**

```bash
pnpm exec vitest run src/shared/browser-plugin-overlay.test.ts src/main/browser-plugin-overlay.test.ts
pnpm exec eslint src/main/browser-plugin-overlay.ts src/shared/browser-plugin-overlay.ts src/preload/overlay.ts src/renderer/src/overlay --no-cache
```

Expected: PASS。源码扫描无 Accessibility / CGEvent。

- [ ] **第 6 步: 提交**

```bash
git commit -m "feat(p0-19f): show click-through overlay cursor for browser plugins"
```

仅当任务 1 证明坐标可映射、并且实现确实画出虚拟鼠标时，才把本任务打勾。

---

### 任务 7: 走查与文档快照

- [x] **第 1 步: 自动走查意图**

单元/源码测试锁：

- 无 Accessibility / CGEvent
- `screen` / `clipboard` 仍 deny
- 写文件 grant 不能捎带 browser
- 无 pointer 时 DOM 无移动光标
- 停止后 `visible: false`
- overlay 不是 P0-21 WebContentsView

```bash
node --version   # >= 20，优先 22/24
pnpm --version   # 10.x
pnpm exec eslint src/main/security/permission-policy.ts src/main/runtime/grok/grok-acp-mappers.ts src/main/browser-plugin-overlay.ts src/shared/browser-origin.ts src/shared/browser-plugin-overlay.ts --no-cache
pnpm exec vitest run src/main/security/permission-policy.test.ts src/main/security/permission-broker.test.ts src/main/runtime/grok/grok-acp-mappers.test.ts src/shared/browser-origin.test.ts src/shared/browser-plugin-overlay.test.ts src/main/browser-plugin-overlay.test.ts
pnpm typecheck
pnpm build
git diff --check
```

- [ ] **第 2 步: 开发版走查（本任务不宣称已过）**

1. 插件页安装并信任 `chrome-devtools`。
2. 新 Task，让 Grok 打开公开页或 localhost。
3. 必须出现 browser L3；允许后主窗口 HUD 为「Grok 正在使用浏览器插件」。
4. 若任务 1 有可映射坐标：失焦后仍能看见虚拟鼠标；停止后光标与文案消失。
5. 拒绝权限：无截图、无 overlay、不得声称正在控制。
6. 同一 Task 先允许写文件，再要求打开网页：必须再弹 browser 卡。

**走查记录（2026-09-07）：** 本任务 **未跑** 开发版 GUI。虚拟鼠标被任务 1 观察阻塞（ACP 指针键 not-observed；`click_at` 为 viewport-css，不可映射到 overlay 屏幕 DIP）。停止芯片不等于虚拟鼠标。不得打勾「开发版 GUI 已过」。

未跑 GUI 不得打勾「开发版 GUI 已过」。虚拟鼠标若因坐标不可映射没画出来，走查记录写阻塞，不得改口说「停止条就算虚拟鼠标」。

- [x] **第 3 步: 文档**

同步 `AGENTS.md` / `CLAUDE.md` 第 15 节、roadmap、P0-19 程序索引、P0-21 交叉引用、product-vision §7.2 / §7.3。P0-21 写明：插件虚拟鼠标在 19f；内置页仍不画光标；`screen` / `clipboard` 不再「留给 19f」，改留给后置软件表面 / P3-07。

## 验收标准

- [x] 写文件授权不能捎带浏览器。
- [x] `screen` / `clipboard` 仍未接入。
- [x] 有截图则进 Artifact；无截图有明确降级。
- [x] 控制期间主窗口停止入口始终可见（代码路径 + 聚焦测试；开发版 GUI 未走查）。
- [ ] **虚拟鼠标必须可见**（失焦仍在）；无坐标不发明光标，也不得把计划标成已完成。← 观察阻塞，保持开放。
- [x] 没有 BrowserView、没有读用户 Chrome Profile、没有系统鼠标注入、没有点桌面软件。
- [ ] 自动验证 + 开发版走查记录（走查未跑则保持未过）。← 自动验证已过（2026-09-07）；开发版 GUI 未跑。
