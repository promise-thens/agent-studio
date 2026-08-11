# P0-04 中性 Agent IPC 边界实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0 / 权重 5（主进程安全与多 Runtime 的阻塞性基础）

**目标：** 用静态、类型化的 `window.agent` / `agent:*` 替换现有 `window.grok` / `grok:*`，将目录选择迁移到 `window.app` / `app:*`，并在主进程统一实施来源验证、参数限长和脱敏错误封套。

**核心数据流：** Runtime 操作由 Renderer 调用 `window.agent`，Preload 只向固定 `agent:*` channel 发送结构化请求，主进程先验证来源、请求形状、UTF-8 大小与状态准入，再委托现有 `GrokAgentBridge`。工作目录选择独立经过 `window.app.chooseWorkspace()` / `app:choose-workspace`；状态、事件和权限由 `GrokAgentBridge` 通过固定 `agent:*` 推送，经 Preload 类型化订阅进入 Renderer。

**约束与边界：** 保持 `contextIsolation: true` 与 `sandbox: true`；最终 Renderer 只保留窄范围的 `window.agent`、`window.app`、`window.provider`，不得暴露通用 `ipcRenderer`、`process.env`、任意文件系统读取能力、Shell、子进程或 Runtime 原对象。本期不创建 Agent Service 或 Runtime Adapter，不接入历史恢复，不改变 Provider IPC 业务契约。

**主要风险：** IPC channel 通过字符串跨进程连接，GitNexus 不能完整追踪 Renderer → Preload → Main 的动态边，因此本计划按 HIGH 回归风险管理。迁移不得保留双 channel 状态源；来源验证、事件出口和 Renderer 调用必须在同一实施周期原子切换，并用自动测试和开发版走查保护连接、Prompt、取消、权限、新会话与 Provider 重连。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 编码前确认

### 已满足前置依赖

- P0-01 已提供中性 Agent 领域类型。
- P0-02 已提供有界、有序的 AgentEvent 封套和 Renderer 顺序守卫。
- P0-03 已提供 Runtime 能力快照、运行证据提升、真实新会话重建和 Renderer 能力门禁。
- 当前 Grok Runtime 的连接、Prompt、取消、权限、状态和事件链均已有测试基线，本计划只收口 IPC 边界，不改写 ACP 协议语义。

### 当前安全缺口

- `src/preload/index.ts` 暴露的 `window.electron` 来自 `@electron-toolkit/preload`，包含任意 `ipcRenderer.invoke/send/on/sendSync`、`process.env`、`webFrame` 和 `webUtils`。即使业务代码没有调用，Renderer 仍具备自选 channel 和读取 Preload 环境的能力，必须在 P0-04 删除。
- 现有 `assertTrustedSender()` 只比较 `event.sender` 与主窗口 `webContents`，没有拒绝同一窗口的子 frame，也没有验证调用页面 URL 或窗口销毁状态。
- `workspace`、`prompt`、`requestId`、`optionId` 只有 TypeScript 声明，没有主进程运行时类型、字段、控制字符和 UTF-8 字节限制。
- 当前 IPC 错误主要依赖 Electron Promise rejection；自定义错误属性不能保证跨进程保留，Renderer 无法稳定消费错误码。

### GitNexus 门禁

- 计划文档本身的 upstream impact 为 LOW，没有代码执行流依赖。
- 编码前必须对每个将修改的目标符号逐个执行 upstream impact，至少覆盖：
  - `initializeServices`
  - `registerIpcHandlers`
  - `assertTrustedSender`
  - `persistProviderConfig`
  - `subscribe`
  - `startNewChat`
  - `chooseWorkspace`
  - `connectAgent`
  - `disconnectAgent`
  - `sendPrompt`
  - `cancelTurn`
  - `respondPermission`
- 即使单个符号显示 LOW 或 MEDIUM，也必须把整条跨进程迁移按 HIGH 风险告知用户并保护相关流程。
- 完成后运行 `detect_changes({ scope: "all" })`；准备提交时再用 `detect_changes({ scope: "compare", base_ref: "main" })` 复核。

## 已锁定决策

1. P0-04 完成后不保留 `window.electron`、`window.grok`、任何 `grok:*` channel 或 `GrokDesktopApi`。
2. 不设置长期双 channel 兼容期；实施过程中可以先接通新链路，但最终代码和测试只能存在 `agent:*` 单一状态、事件和权限源。
3. 主进程内部继续使用 `GrokAgentBridge`；不重命名、不移动，不提前实现 P0-05 的 `AgentService`、`AgentRuntimeAdapter` 或 `GrokAcpAdapter`。
4. `cancel()` 保持“取消当前 active turn”的现有语义，不接收 Renderer 提供的 `taskId`；停止操作始终属于在途收束动作。
5. `respondPermission()` 继续使用主进程生成的 `requestId`。未知或过期请求保持幂等无副作用；省略 `optionId` 或选项不匹配时按取消收束，不新增新的权限业务语义。
6. 本期“会话查询”仅指当前 `AgentRuntimeStatus` 的 `getStatus()`；不实现历史列表、持久化、`load`、`resume` 或最近会话恢复，这些属于 P0-06。
7. 工作目录选择属于桌面 App 能力，使用 `window.app.chooseWorkspace()` / `app:choose-workspace`；Agent IPC 只接收已经选好的 workspace。
8. Provider 继续使用 `window.provider` / `provider:*`，不改请求和响应类型；Provider Handler 复用加强后的来源验证，主进程内部的切模重连仍直接调用 `GrokAgentBridge`。
9. Preload 不保留 `contextIsolation` 关闭时向 `globalThis` 注入 API 的兼容分支；正式安全基线不满足时应拒绝暴露，而不是降级到宽权限全局对象。
10. Diff、Usage viewer、第二个 Runtime、能力快照持久化和 Agent 历史均不属于本期。

## 静态 IPC 契约

### 固定 invoke channel

| Channel                    | 线上的请求形状                             | 成功值               | 状态准入                                                                         |
| -------------------------- | ------------------------------------------ | -------------------- | -------------------------------------------------------------------------------- |
| `agent:get-status`         | 无参数                                     | `AgentRuntimeStatus` | 任意状态                                                                         |
| `agent:connect`            | `{ workspace: string }`                    | `AgentRuntimeStatus` | `idle`、`error`、`ready`；`connecting`、`busy` 返回 `invalid-state`              |
| `agent:disconnect`         | 无参数                                     | `AgentRuntimeStatus` | 任意状态，作为连接和任务收束动作                                                 |
| `agent:send-prompt`        | `{ prompt: string }`                       | `null`               | Handler 只要求 `ready`；active turn 仍由 `GrokAgentBridge.sendPrompt()` 二次校验 |
| `agent:cancel`             | 无参数                                     | `null`               | 任意状态；没有 active turn 时安全 no-op                                          |
| `agent:respond-permission` | `{ requestId: string, optionId?: string }` | `null`               | 任意状态；未知或已处理请求安全 no-op                                             |
| `app:choose-workspace`     | 无参数                                     | `string \| null`     | 任意状态；用户取消返回 `null`，不作为错误                                        |

补充规则：

- 不在任何请求中增加 `runtimeId` 或 `taskId`。当前只有 Grok Runtime，Runtime 选择与统一任务服务属于 P0-05。
- 无参数 channel 必须拒绝额外参数；有参数 channel 必须且只能接收一个普通对象。
- Preload 面向 Renderer 保持易用签名，例如 `connect(workspace)`、`sendPrompt(prompt)`，但线上统一包装为上述对象请求。
- `ready` 状态调用 `connect()` 保留现有行为：同目录幂等返回，目录变化时由 `GrokAgentBridge` 自行断开并重连；P0-04 不把这段编排上移到新服务。
- Handler 不读取或复制 `GrokAgentBridge` 的私有 active turn；任务并发保护继续由 Bridge 持有。
- `disconnect`、`cancel`、权限允许、拒绝和取消是收束动作，不受 Renderer 能力快照二次阻断；主进程仍执行来源、形状和标识符校验。

### 固定推送 channel

- `agent:status`：只发送 `AgentRuntimeStatus`。
- `agent:event`：只发送 P0-02 已归一化的 `AgentEvent`。
- `agent:permission`：只发送已投影、脱敏并限长的 `AgentPermissionRequest`。

每个订阅必须：

- 只监听一个写死的 channel，Renderer 不能传入 channel 名。
- 只把 payload 传给业务 listener，不暴露原始 Electron event。
- 返回只移除本次 handler 的幂等清理函数，禁止调用 `removeAllListeners()`。
- 在目标窗口或主 frame 不再可信时停止推送，不把状态、事件或权限发送到导航后的未知页面。

### 结果封套与稳定错误

在 `src/shared/ipc-result.ts` 中定义可结构化克隆、可 JSON 往返的结果联合，Agent 和 App invoke 都直接返回该封套。Preload 只转发结果，不创建或抛出跨 isolated world 的自定义 Error；Renderer 使用纯 helper 解包，并在自己的执行环境中构造只包含 `code` 和脱敏 `message` 的错误对象。

```ts
/** IPC 失败只保留稳定错误码和脱敏文案，不透传原始异常。 */
export type DesktopIpcErrorCode =
  | 'forbidden'
  | 'invalid-input'
  | 'payload-too-large'
  | 'invalid-workspace'
  | 'runtime-unavailable'
  | 'invalid-state'
  | 'operation-failed'

export interface DesktopIpcError {
  code: DesktopIpcErrorCode
  message: string
}

export type DesktopIpcResult<T> = { ok: true; value: T } | { ok: false; error: DesktopIpcError }
```

API 签名规则：

- `AgentDesktopApi` 的 invoke 方法统一返回 `Promise<DesktopIpcResult<T>>`；事件订阅仍直接接收已经归一化的 payload。
- `AppDesktopApi.chooseWorkspace()` 返回 `Promise<DesktopIpcResult<string | null>>`，其中用户取消是 `{ ok: true, value: null }`。
- Renderer 的 `unwrapDesktopIpcResult()` 只处理联合类型：成功返回 `value`，失败在 Renderer 本地抛出带稳定 `code` 的有限错误。
- App、composable 和新会话 helper 不直接判断 Electron rejection 文案，也不各自重复实现结果解包。

错误映射规则：

- 未知窗口、子 frame、错误页面或已销毁目标统一映射为 `forbidden`，文案不得包含预期 URL、窗口 ID、内部文件路径或调用参数。
- 类型错误、空白字符串、未知字段、错误参数数量或 NUL 字符映射为 `invalid-input`。
- 单字段或整体请求超过 UTF-8 上限映射为 `payload-too-large`，标识符和 Prompt 一律拒绝，不截断后继续执行。
- workspace 不是绝对路径、无法访问或不是现有目录时映射为 `invalid-workspace`。
- Runtime 尚未完成主进程初始化时映射为 `runtime-unavailable`。
- 操作与当前 `AgentRuntimeStatus` 不匹配时映射为 `invalid-state`。
- 其余 Runtime、Dialog 或系统异常先统一脱敏，再映射为 `operation-failed`。
- 错误文案最多 4 KiB UTF-8；先脱敏，再按 Unicode code point 安全截断，不得切坏中文或 emoji。
- 无返回值的成功操作使用 `{ ok: true, value: null }`，不使用 `undefined`。

## 来源与参数边界

### 调用来源验证

把现有来源判断抽成可注入、可单测的主进程安全函数，并由 Agent、App 和 Provider Handler 共用：

1. 当前主窗口必须存在且未销毁。
2. `event.sender` 必须严格等于当前主窗口的 `webContents`，且 `webContents` 未销毁。
3. `event.senderFrame` 必须存在并严格等于 `webContents.mainFrame`；同一窗口的子 frame 一律拒绝。
4. 开发环境只接受当前 `ELECTRON_RENDERER_URL` 的精确 origin，不信任请求自行携带的 origin。
5. 生产环境只接受打包 Renderer `index.html` 对应的精确 `file:` URL；比较前使用 URL API 规范化，不使用宽松 `startsWith()`。
6. 来源校验必须发生在读取请求字段、访问 Provider 配置、打开 Dialog 或调用 Runtime 之前。
7. Runtime 向 Renderer 推送前也要确认目标窗口、主 frame 和页面仍可信；不把仅适用于 invoke 的 event 对象长期缓存。
8. 校验函数及 Handler 必须用中文 TSDoc 说明信任边界、拒绝原因和禁止泄漏的内容。

### 请求形状与大小

| 项目                              | UTF-8 上限 | 运行时规则                                                                                    |
| --------------------------------- | ---------: | --------------------------------------------------------------------------------------------- |
| 单次 Agent/App IPC 请求序列化结果 |    512 KiB | 超限立即拒绝，不触发 Dialog 或 Runtime；该上限必须容纳 P0-02 已允许的权限选项回传             |
| `workspace`                       |      4 KiB | 非空、无 NUL、必须为绝对路径，主进程 `stat` 确认为现有目录                                    |
| `prompt`                          |     64 KiB | `trim()` 后非空、无 NUL；保留用户原始首尾内容发送，不能用截断值执行                           |
| `requestId`                       |      4 KiB | 非空、无 NUL；标识符不得截断或改写                                                            |
| `optionId`                        |    256 KiB | 可省略；存在时必须非空、无 NUL且不得截断，确保所有已通过 P0-02 权限投影的合法选项都能原值回传 |
| 错误 `message`                    |      4 KiB | 先脱敏，再按 UTF-8 安全截断                                                                   |

所有对象请求还必须满足：

- 主进程实际收到的值必须是普通对象，拒绝数组、函数、Date、Map 等非普通对象；不依赖调用方自定义 class 原型在 structured clone 后仍然存在。
- 只允许契约声明字段；未知字段直接拒绝，避免以后被误当成隐式协议扩展。
- 按 UTF-8 bytes 而不是 JavaScript 字符数判断上限；测试覆盖中文和 emoji 的临界值。
- 对输入只做验证，不把超长值截短后继续执行。
- 不记录完整 Prompt、workspace、权限标识符或原始请求对象。

## 文件范围

### 创建

- `src/shared/ipc-result.ts`：Agent/App 共用的结果封套、稳定错误码和白名单错误结构。
- `src/shared/ipc-result.test.ts`：结果联合、错误码、结构化克隆和 JSON 往返测试。
- `src/shared/agent-ipc.ts`：固定 Agent channel、请求 DTO，以及返回 `DesktopIpcResult` 的 `AgentDesktopApi`。
- `src/shared/app-ipc.ts`：固定 App channel，以及返回 `DesktopIpcResult`、只包含 `chooseWorkspace()` 的 `AppDesktopApi`。
- `src/shared/agent-ipc.test.ts`：契约完整性、唯一 channel 和请求形状测试。
- `src/main/security/ipc-sender-validation.ts`：主窗口、主 frame、Renderer URL 来源验证和发送前可信 Renderer 检查。
- `src/main/security/ipc-sender-validation.test.ts`：未知窗口、子 frame、错误 URL、销毁状态、脱敏拒绝和导航后停止推送测试。
- `src/main/agent/ipc.ts`：可注入依赖的 Agent Handler 注册、参数校验、状态准入和错误封套。
- `src/main/agent/ipc.test.ts`：固定 channel、输入边界、状态矩阵、委托与错误脱敏测试。
- `src/main/app-ipc.ts`：可注入 Dialog 和来源验证的 App Handler 注册。
- `src/main/app-ipc.test.ts`：目录选择成功、取消、异常和来源拒绝测试。
- `src/main/provider/ipc.ts`：从主进程入口抽出可注入的 Provider Handler 注册，保持原 channel、DTO 和业务语义。
- `src/main/provider/ipc.test.ts`：证明 Provider Handler 使用统一来源校验，且非法来源不会读取配置、发送请求或重连 Runtime。
- `src/preload/desktop-api.ts`：可注入窄 `ipcRenderer` 能力的 Agent/App API 和订阅工厂，不直接暴露 Electron 对象。
- `src/preload/desktop-api.test.ts`：固定 channel、线上请求包装、payload 转发与精确清理测试。
- `src/preload/index.test.ts`：最终 `contextBridge` 暴露面和非隔离拒绝测试。
- `src/renderer/src/desktop-ipc-result.ts`：Renderer 唯一的结果封套解包和本地错误构造 helper。
- `src/renderer/src/desktop-ipc-result.test.ts`：成功解包、稳定错误码和有限文案测试。

### 修改

- `src/main/index.ts`：只保留服务创建、依赖组装、Provider 业务编排及 Agent/App/Provider IPC 注册；推送通过可测试的可信 Renderer helper 发送。
- `src/preload/index.ts`：只暴露 `window.agent`、`window.app`、`window.provider`，移除非隔离降级和通用 Electron API。
- `src/preload/index.d.ts`：声明中性窄 API，移除 `ElectronAPI` 与 `GrokDesktopApi`。
- `src/renderer/src/App.vue`：状态订阅、连接、断开、Prompt、取消、权限响应改用 `window.agent`，目录选择改用 `window.app`。
- `src/renderer/src/runtime-session-actions.test.ts`：验证新会话重建使用分离后的 Agent/App API，保持 P0-03 成功后清空语义。
- `package.json`、`pnpm-lock.yaml`：确认源码无引用后移除 `@electron-toolkit/preload`。
- P0-04 完成后更新本计划验证证据、路线索引、`AGENTS.md` 和 `CLAUDE.md`。

### 删除

- `src/shared/grok.ts`：中性 API 全量迁移后删除 `GrokDesktopApi` 及过渡别名。

### 明确不修改

- 不重命名或移动 `src/main/grok-agent.ts`，不改变 `GrokAgentBridge` 的 ACP 握手、能力快照、事件归一化和权限业务语义。
- 不新增 `src/main/agent/agent-service.ts`、Runtime Adapter 或 Runtime 选择框架。
- 不修改 Provider 的共享 DTO、channel 名或凭据存储规则。
- 不启用最近会话，不增加历史存储、load/resume、Diff viewer 或 Usage viewer。

## 实施任务

### 任务 1：建立静态契约、来源验证与输入边界

**任务目标：**

- 先冻结 Renderer 可见 API、线上请求形状、错误码和所有运行时边界，让后续迁移不再临场决定字段或失败语义。

**涉及范围：**

- 创建 `src/shared/ipc-result.ts`、`src/shared/agent-ipc.ts`、`src/shared/app-ipc.ts` 及共享契约测试。
- 创建 `src/main/security/ipc-sender-validation.ts` 及测试。
- 在 `src/main/agent/ipc.ts` 中实现纯参数校验和结果映射基础函数。

**前置依赖：**

- 复用 `AgentRuntimeStatus`、`AgentEvent`、`AgentPermissionRequest` 和现有统一脱敏函数。
- 编码前完成本计划列出的目标符号 upstream impact。

**数据流/接口梳理：**

- Preload 把固定方法参数转换为唯一请求 DTO。
- 主进程先验证来源，再验证参数数量、普通对象、字段白名单、UTF-8 大小和 workspace 目录属性。
- 验证失败直接返回有限错误封套，Bridge/Dialog 调用次数必须保持为零。

- [x] **第 1 步：定义 Agent/App 静态契约**
      说明：落地固定 invoke/push channel、请求 DTO、`DesktopIpcResult`、`AgentDesktopApi`、`AppDesktopApi` 和稳定错误码；所有 invoke API 直接返回结果封套，不加入 `runtimeId`、`taskId`、历史查询或通用 invoke。
      预期：所有 channel 完整、唯一，类型可结构化克隆和 JSON 往返，无 `grok:*` 或 ACP 私有字段。

- [x] **第 2 步：实现来源和请求校验基础函数**
      说明：实现主窗口、主 frame、Renderer URL、销毁状态、严格参数数量、普通对象、字段白名单、NUL、UTF-8 上限、绝对目录与状态准入校验；核心函数写中文 TSDoc。
      预期：任何非法来源或输入都在副作用前失败，并映射为稳定、脱敏、有限的错误结果。

- [x] **第 3 步：完成共享边界测试**
      说明：覆盖中文/emoji 临界字节、刚好等于上限、超过一个字节、未知字段、主进程实际收到的非普通对象、额外参数、相对路径、文件路径、缺失目录、结构化克隆和错误限长。
      预期：合法值保持原样，非法值被拒绝且不截断执行；Secret、环境变量、内部 URL 和堆栈不进入结果。

### 任务 2：实现可注入 Handler、可信推送与窄 Preload 模块

**任务目标：**

- 先在不切断现有应用的前提下实现并测试新 Agent/App Handler、Provider 注册、可信推送和 Preload API 工厂，为任务 3 的原子接线准备完整模块。

**涉及范围：**

- 创建 `src/main/agent/ipc.ts`、`src/main/app-ipc.ts` 及测试。
- 创建 `src/main/provider/ipc.ts` 及测试；在统一来源安全模块中提供可测试的可信 Renderer 推送 helper。
- 创建 `src/preload/desktop-api.ts` 及测试，不在本任务提前替换生产 `contextBridge` 暴露。

**前置依赖：**

- 依赖任务 1 已冻结且通过测试的共享契约、来源验证和输入校验。
- 继续把现有 `GrokAgentBridge` 作为唯一 Runtime 实现注入 Handler，不建设新服务层。

**数据流/接口梳理：**

- `registerAgentIpcHandlers()` 只接收窄依赖并委托 Bridge；`registerAppIpcHandlers()` 只封装目录 Dialog。
- `registerProviderIpcHandlers()` 保持原 channel、DTO 和业务回调，只把注册与来源验证从 `src/main/index.ts` 抽成可测试接缝。
- `sendToTrustedRenderer()` 在发送状态、事件或权限前重新检查窗口、主 frame 和 URL；不缓存 invoke event。
- Preload API 工厂只接受测试可注入的 `invoke/on/removeListener` 窄接口，返回固定方法并直接转发 `DesktopIpcResult`，不解包、不暴露 channel、Electron event 或底层对象。
- 本任务结束时旧生产接线仍可运行；新旧 channel 不得同时发布或订阅，真正切换统一留在任务 3。

- [x] **第 1 步：实现 Agent/App Handler 与状态边界**
      说明：实现固定 `agent:*`、`app:*` 注册模块，按状态准入表调用 Bridge/Dialog；Agent/App 成功和失败均返回结果封套，目录选择取消返回成功值 `null`。
      预期：合法依赖下所有操作能被正确委托；来源或输入非法时 Runtime 与 Dialog 调用次数为零，Bridge 私有 active turn 不被复制到新模块。

- [x] **第 2 步：实现 Provider 注册、可信推送和 Preload API 工厂**
      说明：抽出保持原业务语义的 Provider Handler 注册；实现发送前重新验证目标的 `sendToTrustedRenderer()`；实现只绑定固定 channel、直接返回结果封套的 Agent/App API 与订阅工厂。
      预期：非法来源不会触发 Provider 副作用，导航后的未知页面收不到推送，Preload 工厂无法接收 Renderer 提供的 channel，订阅清理精确且幂等。

- [x] **第 3 步：完成新模块的隔离测试**
      说明：测试固定 channel、来源拒绝、状态矩阵、Runtime/Dialog 异常脱敏、Provider 守卫、可信推送、线上请求包装、重复订阅和清理；本步骤不修改生产 Main/Preload/Renderer 接线。
      预期：新模块全部可独立验证，现有应用仍能 typecheck 和运行，为任务 3 的一次性切换提供稳定基础。

### 任务 3：迁移 Renderer、删除旧边界并完成验收

**任务目标：**

- 把真实工作台调用原子迁移到中性 API，删除所有旧 Grok 和通用 Electron 入口，并证明 P0-03 已有交互及 Provider 重连没有回归。

**涉及范围：**

- 修改 `src/main/index.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、`src/renderer/src/App.vue`、`src/renderer/src/runtime-session-actions.test.ts` 及必要的 Renderer 测试。
- 创建并接入 `src/renderer/src/desktop-ipc-result.ts` 及测试。
- 删除 `src/shared/grok.ts`，移除失去引用的 `@electron-toolkit/preload`。
- 完成计划、路线索引、`AGENTS.md`、`CLAUDE.md` 的进度和验证证据同步。

**前置依赖：**

- 依赖任务 2 的新请求、推送和 Preload API 全部通过测试。
- Renderer 迁移与旧入口删除必须属于同一最终变更，不保留长期双订阅或兼容 fallback。

**数据流/接口梳理：**

- App 启动只通过 `window.agent` 订阅状态、事件、权限并查询当前状态。
- 连接、断开、Prompt、取消和权限响应全部调用 `window.agent`；目录选择调用 `window.app`。
- Renderer 收到 `DesktopIpcResult` 后统一通过纯 helper 解包；成功值进入既有状态流，失败只消费稳定 `code` 和脱敏 `message`。
- 新对话继续执行“必要时选择目录 → 已连接则断开 → 使用同一目录连接 → ready 且得到新 `runtimeSessionId` 后清空界面”。
- Provider 配置保存或切模后的 Runtime 重连仍由主进程完成，Renderer 不直接编排 Bridge。

- [x] **第 1 步：原子切换 Main、Preload 与 Renderer 真实调用链**
      说明：在同一个可验证变更中注册 Agent/App/Provider 新模块，状态、事件、权限改用可信 `agent:*` 推送，Preload 暴露中性 API，Renderer 替换启动订阅、状态查询、目录选择、连接、断开、Prompt、取消、权限响应和新对话依赖，并统一解包结果封套。
      预期：应用始终保持可 typecheck、可构建；连接、目录切换、Enter 发送、停止、权限收束、新对话和断开行为与 P0-03 一致，单个事件不会被重复消费。

- [x] **第 2 步：删除旧 API、channel 与无用依赖**
      说明：删除 `window.grok`、`window.electron`、全部 `grok:*`、`GrokDesktopApi`、非隔离 fallback 和失去引用的 `@electron-toolkit/preload`；静态搜索确认没有遗漏。
      预期：`src` 中不存在旧入口；Renderer 全局类型只有 `agent`、`app`、`provider`，且没有 taskId 定向取消、历史恢复或 Adapter 提前实现。

- [x] **第 3 步：完成自动验证、开发版走查与文档证据**
      说明：运行目标及完整验证、`build:unpack`、静态边界搜索和 GitNexus 变更检测；开发版走查连接、Prompt、Enter、执行中门禁、停止、权限允许/拒绝/取消、新对话、Provider 切模重连、断开和重连。
      预期：全部自动检查通过，开发版没有重复事件或状态竞态，P0-04 勾选为 `9/9`、验收 `3/3`，路线和协作进度切换到 P0-05。

## 自动测试与验证

### 必须覆盖

- Preload 最终只暴露 `window.agent`、`window.app`、`window.provider`；不存在 `window.electron`、`window.grok` 或动态 channel API。
- 每个 Preload 方法只调用对应固定 channel，订阅不泄漏 Electron event，单次和重复清理都安全。
- Handler 拒绝未知窗口、同窗口子 frame、错误 Renderer URL、已销毁窗口和额外参数，并确认 Bridge、Dialog、Provider 均未被调用。
- 请求对象拒绝数组、`null`、主进程实际收到的非普通对象、未知字段、错误类型、NUL、空白 Prompt、相对 workspace、文件路径和不存在目录。
- UTF-8 限制覆盖 ASCII、中文和 emoji：恰好等于上限通过，超过一个字节拒绝且不产生破损字符。
- `connect` 在 `idle/error/ready` 保持现有连接或目录切换语义，在 `connecting/busy` 拒绝；`sendPrompt` 的 Handler 只校验 `ready`，active turn 继续由 Bridge 保护；`disconnect`、`cancel` 和权限响应保持可收束、可重复、无越权副作用。
- 未知或过期权限请求不影响其它 pending 请求；省略或不匹配的 `optionId` 按取消收束。
- 错误结果不包含假 Secret、Bearer Header、环境变量、完整 Prompt、workspace、实例 ID、内部 URL 或原始堆栈。
- 状态、事件和权限只通过 `agent:*` 到达一次；Renderer 继续使用 P0-02 顺序守卫，不根据事件私自改能力矩阵。
- `window.agent` / `window.app` 直接返回 `DesktopIpcResult`，Renderer 只通过统一 helper 解包并保留稳定错误码。
- Enter 不能绕过 Prompt 能力门禁；停止与权限收束操作始终可用。
- 新对话仍只在重连 ready 且返回新 `runtimeSessionId` 后清空旧界面，失败时保留旧记录。
- Provider 保存、切模、清除和 Runtime 重连不回归，非法来源不会触发 Provider 副作用，`provider:*` 不被 Agent/App 注册覆盖。
- `rg` 静态搜索确认没有旧 Grok IPC、通用 Electron API 或无用依赖残留。

### 验证命令

```bash
# 确认工具链满足项目基线。
node --version
pnpm --version

# 先验证本次目标文件，再运行完整质量门禁。
pnpm exec eslint <目标文件> --no-cache
pnpm exec eslint . --no-cache
pnpm test
pnpm typecheck
pnpm build
pnpm build:unpack
git diff --check

# 确认旧 IPC 和宽权限 Preload 已完全移除。
rg -n "window\\.(grok|electron)|grok:|GrokDesktopApi|@electron-toolkit/preload" src package.json pnpm-lock.yaml
```

静态搜索的预期结果是零命中；如果保留测试中的禁止字符串断言，应限定搜索范围或逐项核对，不能把测试证据误判为生产残留。

### GitNexus 完成检查

- `detect_changes({ scope: "all" })` 应只影响预期的 Main IPC 注册、Preload 暴露、Renderer Agent 调用和 Provider 来源验证链。
- `detect_changes({ scope: "compare", base_ref: "main" })` 用于提交前整体复核。
- 若出现 P0-05 Adapter、P0-06 历史存储或无关 Provider 业务流程，必须停止并收缩范围。

## 开发版手工走查

- 启动后只建立一组 `agent:status/event/permission` 订阅，无重复状态、消息、工具活动或权限弹窗。
- 首次选择工作目录、连接和断开正常；取消目录选择不改变当前状态。
- ready 时可发送 Prompt；空 Prompt、未 ready、能力未知/不支持时按钮和 Enter 均不能绕过门禁。
- busy 时停止始终可用；Runtime 确认取消后状态和事件正确收束。
- 权限允许、拒绝和取消均能结束同一个 pending 请求，重复响应不会影响后续请求。
- 新对话确实生成新的 `runtimeSessionId`；重连失败时保留旧界面记录。
- Provider 模型保存、切换和清除仍保持原有事务语义；已连接时切模能够由主进程完成断开、重连或失败回滚。
- 主窗口刷新或卸载后旧订阅已清理；重新挂载不会产生双消费。
- 错误 UI 只显示有限、脱敏文案，不出现 Secret、环境、内部路径或原始堆栈。
- 键盘 Tab/Enter、焦点轮廓、读屏名称和 reduced-motion 保持有效。

## 验收标准

- [x] Renderer 只能调用静态 `window.agent`、`window.app`、`window.provider`；不存在通用 Electron API、旧 Grok IPC、动态 channel、跨窗口/子 frame 绕过或导航后继续推送，所有越界输入均在触达 Runtime、Dialog 或 Provider 前被拒绝。
- [x] 连接、状态、Prompt、当前任务取消、权限响应、真实新会话和 Provider 重连完整可用；工作目录归入 App 域，历史恢复、taskId 定向取消、Agent Service 和 Runtime Adapter 均未被提前实现。
- [x] 在 Node.js 20+、pnpm 10.x 下通过目标/完整 ESLint、全部 Vitest、typecheck、build、`build:unpack`、diff-check、静态边界搜索、GitNexus 影响核对和 Electron 开发版走查，并同步 P0-04、路线索引、`AGENTS.md`、`CLAUDE.md` 的验证证据。

## 当前验证证据（2026-08-11）

- 自动验证：Node.js `v22.22.0`、pnpm `10.33.0`；完整 ESLint、`21` 个文件 `166` 个 Vitest、typecheck、build、`build:unpack`、`git diff --check` 和生产源码旧边界静态搜索均通过。
- GitNexus：使用 `--index-only` 更新至 `1,354` nodes、`3,156` edges、`114` flows；`detect_changes(scope: all)` 的 CRITICAL 评级来自预期的 Main IPC、Provider 操作、Renderer Prompt/取消/权限/新会话核心链路，未出现 P0-05 Adapter、P0-06 历史存储或其它越界模块。
- 开发版已验证：只加载一套中性订阅；目录选择、连接、真实 Prompt、Enter 发送、执行中门禁、停止收束、真实新会话和断开均正常，没有重复事件或状态竞态。
- 重连与 Provider 已验证：断开后重新连接经历 `连接中 → 已连接`，唯一探针返回 `P0-04 RECONNECT OK`；在 Runtime ready 时保持同 Base URL、同 `modelId`、空 Key 复用现有会话凭据执行“测试并保存”，主进程完成断开与重连，历史未被提前清空，随后唯一探针返回 `P0-04 PROVIDER RECONNECT OK`。
- 权限实机已验证：在独立目录 `/Users/huyaohang/Documents/agentStudioTest` 依次触发真实终端权限请求；允许后 `p004-permission-allow.txt` 创建成功，拒绝和取消分别收束为 failed，`p004-permission-reject.txt` 与 `p004-permission-cancel.txt` 均未创建，三次响应后 Runtime 都恢复 ready。测试期间 macOS Keychain 不可用，Provider Store 按设计降级为本次会话持有 Key，磁盘配置未写入明文或伪加密凭据。

## 完成后

- 勾选本计划任务步骤并补充自动测试、GitNexus 与开发版走查证据。
- 将路线索引更新为 P0-04 已完成、P0-05 待开始。
- 同步更新 `AGENTS.md` 与 `CLAUDE.md` 的当前进度、验证版本和测试数量。
- 不提交、不推送，除非用户另行要求。
