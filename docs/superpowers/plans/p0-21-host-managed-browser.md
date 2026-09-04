# P0-21 宿主内置浏览器（Codex 式共享页）实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。步骤使用复选框 (`- [ ]`) 跟踪。
>
> **状态：** 计划已写（2026-09-04 产品确认）。代码未开工。
>
> **插入点：** 不挡 [P0-19b](p0-19b-grok-sandbox-profile.md)。实现建议在 19b 空闲重建 session 纪律之后（MCP 注入只发生在 `session/new` / `load` / `resume`）。可与 19c–e 并行。权限层与 [P0-19f](p0-19f-browser-computer-use-surface.md) 共享：本计划先把 `browser` 从 `unsupported` 改成 L3；19f 继续覆盖 **插件自己的** browser / screen / clipboard，不自建第二只 Chrome。本计划取代 [P3-05](p3-05-managed-browser.md) 的第一波共享页面，不依赖 P3-01 Capability Pack。

**优先级：** P0+ / 权重 4（用户要和 Agent 看同一只浏览器；Grok 已经会调 MCP，缺的是宿主视图）

**Goal：** 工作台右侧有一只独立 Profile 的真实浏览器。用户在 Composer 里正常说话，Grok 经注入的窄动作 MCP 操作 **这只** 视图，而不是再开一只 Chrome。用户能看见、能自己点、能停。

**Architecture：** 主进程持有 `WebContentsView` 与 Project 级 persist partition。Renderer 只画壳（地址栏、tab、开关）和上报 bounds。Grok 仍是 ACP Agent：`session/new` 多注入一个随应用发布的 stdio MCP；该进程经本机 socket 把 `navigate` / `snapshot` / `click` 等转到主进程。每次动作先过 Permission Broker，`browser` 为 L3，grant 按 origin，不能复用写文件授权。桌面不当通用 MCP Host，不广告 `clientCapabilities.fs/terminal`，不暴露任意 CDP。

**Tech Stack：** Electron 39 `WebContentsView` + `Session` partition、现有 Permission Broker / Artifact Registry / P0-10D `mcpServers` 注入、Vue 3 工作区右栏。MCP 子进程只实现 `initialize` / `tools/list` / `tools/call` 最小 JSON-RPC，不新增 MCP SDK 依赖，不引入 Playwright。

**Spec：** 2026-09-04 讨论。对标 Codex 桌面「对话在左、内置浏览器在右、Agent 操作同一页」。文件编辑器另开计划，不在本文件。

## Global Constraints

- 沿用仓库安全基线：`contextIsolation` + `sandbox`，Renderer 不碰文件系统、CDP、用户 Chrome、明文密钥。
- IPC 只用 `task:*` / `app:*` / `agent:*`，不得新增 `grok:*`。
- `clientCapabilities` 保持 `{}`。
- 不读取、不写入用户 Chrome / Edge Profile、cookie、历史。
- 不把完整 CDP、`Runtime.evaluate` 或 `webContents.executeJavaScript` 交给 Grok、MCP 子进程或 Renderer。
- 不和 [P0-16](p0-16-isolated-html-preview.md) 的 Preview session 共用 partition、protocol 或 WebContents。
- 斜杠命令板继续只消费 Grok 广告，不手写 `/browser`。
- 中文注释写原因和边界；协议字段、工具名、ACP / MCP 方法保持英文。
- 执行中禁止切换会重建 session 的浏览器开关；切换必须等主进程确认。
- 不得把「MCP 工具能调」写成「完整支持任意网站工作流」。

---

## 产品决定（已确认）

2026-09-04 确认：

1. **形态是 Codex 式共享页**，不是 Artifacts 截图墙，也不是插件自己的无头 Chrome。
2. **用户发普通指令即可。** 不要求先开面板，不要求斜杠命令。第一次被允许的 `navigate` 自动打开右栏。
3. **Agent 操作的是宿主这只浏览器。** 同一 `WebContentsView`，同一登录态。
4. **独立 Profile。** 站点要在这只浏览器里重新登录；登录后 Agent 也能用该会话，因此登录、下载、外发表单、新窗口单独说明。
5. **默认注入宿主浏览器 MCP。** 设置里可关；关闭后须空闲重建 session 才生效。
6. **文件编辑器不是本计划。** Changes 仍只读审阅。

当前策略代码把 `browser` / `screen` / `clipboard` 直接 `deny` + `unsupported`（见 `evaluatePermissionPolicy`）。本计划必须改 `browser`，不得顺手打开 `screen` / `clipboard`。

## 非目标

- 不实现文件编辑器、LSP、未保存缓冲、ACP `fs`（GACP-05）。
- 不实现 Chrome Native Bridge（P3-06）、macOS Computer Use Helper（P3-07）、虚拟光标。
- 不把 chrome-devtools-mcp 接到这只视图的调试端口。
- 不在 Inspector 增加 `browser` 标签。浏览器是工作区右栏。
- 不把桌面做成 MCP Host / Marketplace Host；Grok 仍是 MCP 客户端。
- 不把用户 PTY（P0-15）或 HTML Preview（P0-16）复用成浏览器。
- 不做多窗口弹出、扩展商店、密码管理器、与系统浏览器同步。
- 不为每个网站做桌面内嵌登录向导。
- 不在本计划实现「清除登录态」以外的 Profile 管理 UI（可后续加设置项）。

## 数据流

```text
创建 / 恢复 Task
  AgentService.resolveMcpServers()
    → 用户 MCP（P0-10D）
    → 另附宿主浏览器 MCP（若未关闭）
  session/new | load | resume { cwd, mcpServers }
  Grok 拉起 stdio MCP（ELECTRON_RUN_AS_NODE + 打包脚本）
  MCP 用 socket + token 连主进程 HostBrowserService

用户在 Composer：「打开百度，搜 agent-studio」
  → 普通 session/prompt，正文不改写
  → Grok 调用 MCP browser_navigate
        │
        ├─ 若 Grok 同时发 requestPermission：mapper 标 operationType=browser + origin
        └─ MCP tools/call 进入主进程后 **必须再走 Broker**（Grok 漏报也不能执行）
  → Broker：L3，grant 键含 origin；写文件 grant 不得 grant-reused
  → 允许后 WebContentsView 加载 URL，右栏若关闭则打开
  → snapshot / screenshot 沿 MCP 回到 Grok；Timeline 有 tool_call；截图可进 Artifact
  → 进行中 HUD：停止 = cancelTurn

用户自己在地址栏回车
  → task:user-navigate-browser（用户动作，不走 Runtime 审批）
  → 主进程校验 URL 后 loadURL；Agent 随后 snapshot 能看到同一页
```

## 安全边界

- Guest `webPreferences`：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、无 Preload、无 App IPC。
- Partition：`persist:as-browser:${projectId}`，禁止 `defaultSession`、禁止 `persist:as-html-preview*`。
- URL：只允许 `http:` / `https:`。拒绝 `file:`、`javascript:`、带用户信息的 URL、query/hash 里像密钥的值不进日志。
- 下载、`window.open`、地理/通知/摄像头权限、文件系统选择器默认拒绝；需要时单独 L3（v1 可全部拒绝并在 snapshot 里说明）。
- MCP 子进程环境只有 socket 路径和一次性 token，**不得**带上 `AGENT_STUDIO_MODEL_API_KEY_ENV` 或 Provider Key。
- Socket 文件 `0600`，目录尽量 `0700`；token 时序安全比较；校验调用方 taskId 与当前活动 Task。
- 动作白名单见下表。禁止通用 `evaluate`、`cdp.send`、读 cookie API。
- Artifact 沿用 P0-13：opaque id、类型白名单、不把绝对路径给 Renderer。
- 审计与 Timeline 只留 origin、工具名、结果摘要，不写 cookie、页面全文、MCP stderr 原文。

## 动作白名单

MCP 工具名固定如下，schema 用 JSON，字符串限长。

| 工具 | 参数 | 权限 |
| --- | --- | --- |
| `browser_navigate` | `url` | L3，目标 `origin` |
| `browser_back` / `browser_forward` / `browser_reload` | 无 | 复用当前 tab origin 的 task grant；没有 grant 则 L3 |
| `browser_tabs_list` | 无 | L0（只读元数据：tabId、title、origin，无 cookie） |
| `browser_tabs_select` / `browser_tabs_close` | `tabId` | 同当前 origin grant |
| `browser_tabs_open` | 可选 `url` | 有 url 则按 navigate |
| `browser_snapshot` | 无 | 同当前 origin grant；返回无障碍简化树（tag/role/name/ref），截断 |
| `browser_screenshot` | 无 | 同当前 origin grant；png 字节上限，可注册 Artifact |
| `browser_click` | `ref` | 同当前 origin grant；ref 必须来自最近一次 snapshot |
| `browser_type` | `ref`, `text`, 可选 `submit` | 同当前 origin grant；密码框仍走同一授权，不得把输入回写 Timeline |
| `browser_scroll` | `direction`, 可选 `amount` | 同当前 origin grant |

`ref` 由主进程签发，短时有效，离开页面即失效。Renderer 拿不到 ref。

## 权限策略变更

当前：

```ts
if (['browser', 'screen', 'clipboard'].includes(intent.operationType)) {
  return { kind: 'deny', risk, reason: 'unsupported', allowedScopes: [] }
}
```

改为：

- `screen` / `clipboard` 仍 `unsupported`（留给 19f / P3-07）。
- `browser`：`approval` + L3；`allowedScopes: ['once', 'task']`。
- `OPERATION_TARGET_KINDS.browser` 改为 `['origin', 'unknown']`。能解析 origin 就用 origin；解析失败用 unknown，不得自动过。
- `createOperationGrantKey` 必须把 browser 的 origin 算进去，避免 `https://a.example` 的 task grant 覆盖 `https://b.example`。
- 已有 `write-file` / `execute-command` grant **不能**满足 browser。测试名见任务 1。

## 文件范围

- 新增：`src/shared/host-browser.ts` 及测试（chrome 快照 DTO、动作名、URL 校验纯函数）
- 新增：`src/main/browser/host-browser-service.ts`、`host-browser-session.ts`、`host-browser-actions.ts`、`host-browser-mcp-stdio.ts`、`host-browser-ipc.ts` 及就近测试
- 新增：`src/renderer/src/components/HostBrowserPane.vue`、`src/renderer/src/composables/useHostBrowser.ts`
- 修改：`src/main/security/permission-policy.ts`（打开 browser L3）
- 修改：`src/main/runtime/grok/grok-acp-mappers.ts`（MCP/权限请求映射 browser + origin）
- 修改：`src/main/agent/agent-service.ts` / `src/main/index.ts`（注入宿主 MCP）
- 修改：`src/shared/task-ipc.ts`、`src/preload/desktop-api.ts`、`src/preload/index.d.ts`
- 修改：`src/renderer/src/App.vue`、工作区 CSS（右栏，不是 Inspector tab）
- 修改：`electron.vite.config.ts` 增加 MCP 子进程入口；必要时 `electron-builder.yml` 保证 `out/main/host-browser-mcp-stdio.js` 打进包
- 文档：本文件、roadmap、P0-19、P0-19f、P3-05、product-vision、AGENTS.md / CLAUDE.md

---

### 任务 1: 打开 browser L3，且不能捎带写文件

**任务目标：** 策略层先能审批浏览器，且与写文件 grant 隔离。没有这一步，后面的 MCP 只能被 `unsupported` 挡死。

**涉及范围：** `permission-policy.ts` 及测试。

- [ ] **第 1 步: 失败测试**

说明：在 `permission-policy.test.ts` 增加：

1. `evaluatePermissionPolicy(browser + origin https://example.com)` 为 `approval` / L3 / `['once', 'task']`。
2. `screen`、`clipboard` 仍 `deny` + `unsupported`。
3. 同一 Task 先 `allow-task` 写文件，再 `browser` 同一 Broker：不得 `grant-reused`，必须再审批。
4. `browser` + origin A 的 task grant 不得批准 origin B。
5. 内嵌用户信息的 URL（`https://user:pass@host/`）在校验函数里拒绝，不得变成 origin grant。

- [ ] **第 2 步: 最小策略实现**

说明：只改 `browser` 分支和 `OPERATION_TARGET_KINDS`。增加 `parseBrowserOrigin(url: string): string | null`（纯函数，放 `src/shared/host-browser.ts`）：只接受 http/https，去掉路径/query/hash/用户信息，失败返回 null。

- [ ] **第 3 步: 跑测试**

```bash
pnpm exec vitest run src/main/security/permission-policy.test.ts src/shared/host-browser.ts
```

预期：新断言全绿；写文件、删除、execute 旧用例不变。

---

### 任务 2: 主进程会话与 WebContentsView 隔离

**任务目标：** 证明能创建、显示、销毁一只与 App、Preview 隔离的页面，还不接 Grok。

**涉及范围：** `host-browser-session.ts`、`host-browser-service.ts`、窗口 bounds、测试。

- [ ] **第 1 步: 失败测试（session 隔离）**

说明：用 Electron 可 mock 的纯逻辑测：partition 名 = `persist:as-browser:${projectId}`；不同 projectId 不同 partition；拒绝空 projectId；`webPreferences` 快照不含 preload / nodeIntegration。

- [ ] **第 2 步: 创建 WebContentsView**

说明：`HostBrowserSession` 由主进程持有。`webPreferences` 固定 sandbox / contextIsolation / 无 preload。`will-navigate`、`setWindowOpenHandler`、`session.setPermissionRequestHandler`、download 默认拒绝。只允许 http/https 顶层导航。

- [ ] **第 3 步: 挂到主窗口并跟随 bounds**

说明：Renderer 只传 `{ x, y, width, height }` 的整数；主进程再校验范围后 `setBounds`。窗口 resize、Task 切换、关闭右栏必须 `removeChildView` 并隐藏，不得留下不可见仍加载的视图。切 Project 销毁旧 session，不得把 A 项目的 cookie 带到 B。

- [ ] **第 4 步: 用户导航 IPC**

说明：新增 `TASK_INVOKE_CHANNELS`：

- `task:get-browser-chrome`
- `task:set-browser-open`
- `task:user-navigate-browser`
- `task:update-browser-bounds`

推送 `task:browser-chrome`（url、title、loading、tab 摘要、open）。Handler 校验主窗口 sender、taskId、字符串长度。用户导航不创建 Runtime `OperationIntent`。

预期：开发版能打开右栏、输入 `https://example.com`、看见页面；Renderer DevTools 里 guest 没有 `window.agent`。

---

### 任务 3: 窄动作引擎

**任务目标：** 主进程能执行白名单动作，并生成 snapshot/screenshot，仍不暴露 CDP。

**涉及范围：** `host-browser-actions.ts` 及测试。

- [ ] **第 1 步: 失败测试**

说明：未知动作名拒绝；`javascript:` URL 拒绝；`click` 的 ref 不存在或过期拒绝；snapshot 超长截断；screenshot MIME 只能是 png。

- [ ] **第 2 步: 实现动作**

说明：导航用 `webContents.loadURL`。snapshot 用 `webContents.debugger` **仅** 附加后调用允许的 CDP 方法白名单（例如 `DOM.getDocument` + `DOM.getOuterHTML` 的裁剪方案，或 Accessibility.getFullAXTree），封装成 `{ ref, role, name, tag }[]`，不得把 debugger 句柄或原始 CDP 结果传出模块。screenshot 用 `webContents.capturePage`。click/type：用 snapshot ref 解析为 backend node，再 dispatch 受控事件；失败返回脱敏错误。

- [ ] **第 3 步: 把动作接到 Broker**

说明：`HostBrowserService.perform(taskId, action)` 构造 `OperationIntent`（`initiator: { kind: 'runtime', runtimeId: 'grok' }`），等 Broker 决议后再执行。拒绝或取消则 MCP 侧收到错误，磁盘/页面不变。

---

### 任务 4: stdio MCP 桥与 session 注入

**任务目标：** Grok 在下一轮 session 能看见浏览器工具；调用落到任务 3。桌面仍不解释 MCP 业务工具。

**涉及范围：** `host-browser-mcp-stdio.ts`、`electron.vite.config.ts`、`agent-service` / `index.ts` 注入。

- [ ] **第 1 步: 最小 MCP stdio 测试**

说明：不引入 `@modelcontextprotocol/sdk`。对 stdin/stdout 跑：`initialize` → `tools/list`（上表工具）→ `tools/call browser_navigate`。无 token 或错误 token 的 socket 连接立即断开。

- [ ] **第 2 步: 打包入口**

说明：electron-vite 增加独立入口 `src/main/browser/host-browser-mcp-stdio.ts` → `out/main/host-browser-mcp-stdio.js`。注入的 `mcpServers` 项：

```ts
{
  name: 'agent-studio-browser',
  transport: 'stdio',
  command: process.execPath,
  args: [absoluteScriptPath],
  env: [
    { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
    { name: 'AGENT_STUDIO_BROWSER_SOCKET', value: socketPath },
    { name: 'AGENT_STUDIO_BROWSER_TOKEN', value: token }
  ]
}
```

`command` 必须是绝对路径。env **只**这三项（外加 MCP 子进程必需的 `PATH` 若 Grok 不继承）。禁止转发模型 Key。名字占用 `agent-studio-browser`；若用户 MCP 撞名，宿主项优先，用户项改报冲突且不静默覆盖。

- [ ] **第 3 步: 注入 create/load/resume**

说明：改 `getSessionMcpServers`：`listEnabledResolved()` 之后 `appendHostBrowserMcpServer(...)`。设置关闭或脚本缺失则不注入，现有用户 MCP 回归不变。测试：`createSession` 在开启时 mcpServers 含该 name；关闭时不含；用户 MCP 仍在。

- [ ] **第 4 步: 空闲开关**

说明：设置「使用内置浏览器」默认开。执行中不可改；空闲改完必须走与 19b 相同的「下一 session 生效」文案，不得假装当前 Turn 已有/已无工具。

---

### 任务 5: Grok 权限映射与 HUD

**任务目标：** Timeline / 审批卡认得出「Grok 要开这个网站」；控制期间停止条不能被拖丢。

**涉及范围：** `grok-acp-mappers.ts`、Composer 或 Task 头 HUD、测试。

- [ ] **第 1 步: mapper**

说明：当权限请求或 tool_call 名称属于 `agent-studio-browser` / 上表工具名，或参数含可解析 URL 时，`operationType: 'browser'`，target 为 origin。不要用中文标题猜。映射不到则 unknown + L3。

- [ ] **第 2 步: HUD**

说明：当前 Task 有未完成的 browser 动作，或有未决 browser 审批时，主窗口显示停止条。复用 `cancelTurn`。` -webkit-app-region: no-drag`，有 `aria-label`。普通写文件不要出这根条。文案写「Grok 正在使用内置浏览器」，不要写 Runtime 内部 id。

- [ ] **第 3 步: 截图 Artifact**

说明：`browser_screenshot` 成功且文件落在已允许的 media/artifact 路径时注册 P0-13 Artifact；失败不阻断 Turn，Timeline 标「无可用截图」。

---

### 任务 6: 工作区右栏

**任务目标：** 看起来像 Codex：对话在左，浏览器在右。不是 Inspector 第五个标签。

**涉及范围：** `HostBrowserPane.vue`、`useHostBrowser.ts`、`App.vue`、CSS。

- [ ] **第 1 步: 右栏壳**

说明：tab 条、后退/前进/刷新、地址栏、关闭。交互控件 `no-drag`。地址栏提交走 `task:user-navigate-browser`。小窗口可变窄，但必须留下对话输入和发送。复用现有颜色变量，不新做一套主题。

- [ ] **第 2 步: 自动打开**

说明：第一次 browser 动作被允许，或 chrome 快照 `open` 因 navigate 变为 true 时打开右栏。用户关掉后，同一 Turn 内 Agent 仍可操作（视图可隐藏但仍挂在主进程）；下一 Turn 再 navigate 再次打开。不要做成「关面板 = 拔掉 MCP」。

- [ ] **第 3 步: 与 Inspector 共存**

说明：Inspector 保持 overlay / 右侧吸附。浏览器右栏打开时，工作区变成「对话 | 浏览器」；Inspector 吸附则盖在浏览器上或临时收起浏览器——选一种写进 CSS 并测，禁止三列挤到输入框消失。Changes / Artifacts 审阅加宽逻辑仍只对 Inspector，不要把浏览器当成 Diff 工作区。

- [ ] **第 4 步: reduced-motion 与 a11y**

说明：`prefers-reduced-motion` 下右栏不播放滑入。所有图标按钮有 `title` 或 `aria-label`。

---

### 任务 7: 开发版走查与回归

**任务目标：** 用真实 Grok 证明「说一句话就能操作我们的浏览器」。

- [ ] **第 1 步: 自动验证**

```bash
node --version   # >= 20，优先 22/24
pnpm --version   # 10.x
pnpm exec eslint src/main/browser src/shared/host-browser.ts src/main/security/permission-policy.ts src/renderer/src/components/HostBrowserPane.vue --no-cache
pnpm exec vitest run src/main/browser src/shared/host-browser.ts src/main/security/permission-policy.test.ts src/main/runtime/grok/grok-acp-mappers.test.ts
pnpm typecheck
pnpm build
git diff --check
```

改了窗口 / 打包入口时加 `pnpm build:unpack`。

- [ ] **第 2 步: 开发版 GUI**

最低路径：

1. 新 Task，不装 chrome-devtools。Composer 发「打开 example.com，告诉我页面标题」。
2. 出现 L3 卡，origin 为 `https://example.com`。允许后右栏打开同一页。
3. 再发「点击页面上的 More information」类指令，看见 click/snapshot，不必再为写文件授权。
4. 同一 Task 先允许写某个文件，再要求打开另一个 origin：必须再弹 browser L3。
5. 停止后 HUD 消失，面板不再声称正在控制。
6. 拒绝权限：页面不加载，无截图。
7. 设置关闭内置浏览器 → 空闲后新 session → 同样 prompt 不得再出现宿主 MCP 工具（Grok 只能靠自己的网络/插件，且那不是这只视图）。

记录日期、开发版或解包版、通过/失败。未走查不得把本计划标成「开发版 GUI 已过」。

---

## 验收标准

- [ ] 用户只发自然语言，Grok 能操作右侧那只浏览器。
- [ ] 用户也能在同一只浏览器里导航；两边看到同一文档。
- [ ] Profile 与用户 Chrome、App defaultSession、HTML Preview 隔离。
- [ ] `browser` 为 L3 + origin；写文件 grant 不能捎带；`screen` / `clipboard` 仍未接入。
- [ ] 无任意 CDP、无 `grok:*` IPC、`clientCapabilities` 仍为 `{}`。
- [ ] 控制期间停止可见；截图按 P0-13 注册或明确降级。
- [ ] 自动验证通过；开发版走查有记录。
- [ ] 不宣称支持任意站点登录工作流或 Computer Use。

## 与相邻计划

| 计划 | 关系 |
| --- | --- |
| P0-19b | 空闲重建 session 纪律；开关 MCP 依赖它。本计划不挡 19b 开工。 |
| P0-19f | 插件 browser/screen/clipboard 的 HUD 与截图。共享 L3 原则；**不**在 19f 里建 WebContentsView。 |
| P3-05 | **被本计划取代第一波共享页。** 文件保留，状态改为后置/取代，不开工。 |
| P3-06 | 用户 Chrome 标签页桥，仍后置。 |
| P0-16 | HTML Artifact 预览；禁止共用 session。 |
| GACP-05 | 仍不广告 fs/terminal。 |
| 文件编辑器 | 另开计划，尚未立项。 |

## 风险

- Grok 可能不调我们的 MCP，改用自带 fetch 或用户安装的 chrome-devtools。缓解：工具描述写明「这是用户正在看的内置浏览器」；走查记录实际选了哪条；不在 v1 禁止用户 MCP。
- `webContents.debugger` 权限过大。必须把允许的 CDP 方法写成白名单常量，测试拒绝未列出的方法。
- `ELECTRON_RUN_AS_NODE` 子进程若继承错误 env 会漏 Key。注入 env 用白名单对象，不拷 `process.env`。
- 登录态在 Project partition：换 Task 同项目会共享 cookie。这是产品选择；文档和 HUD 必须说「本项目内置浏览器的登录态」，不要暗示已隔离到 Task。
