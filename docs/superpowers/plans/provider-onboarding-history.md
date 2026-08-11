# 首次模型服务配置与安全持久化实施计划

> **文档状态（2026-08-10）：** 此文件保留为提交 `fe2a81a` 对应的历史总计划，不再作为新任务清单更新。后续复核与演进请使用 [分阶段功能路线索引](roadmap-index.md) 中的 P1 独立功能计划，避免将多个功能继续堆在同一文档。

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**目标：** Agent Studio 首次启动时引导用户配置 OpenAI Chat Completions 兼容服务，安全保存 Base URL、API Key 和 Model ID，并在后续启动时自动恢复配置，不再重复要求输入。

**核心数据流：** Renderer 收集 Base URL、认证方式、API Key 和 Model ID，通过窄 IPC 一次性传给主进程；主进程完成 URL 校验、模型发现、真实请求验证和安全持久化，再生成不含明文密钥的 Grok 配置。用户选择工作目录后，主进程解密密钥并仅向当前 Grok Runtime 注入，Renderer 始终只能读取脱敏后的配置摘要。

**约束与边界：** 本期仅支持一个活动 Provider，协议固定为 OpenAI Chat Completions；支持 Bearer API Key 和本机无认证服务；不支持多 Provider、自定义 Header、Query Parameter、Responses API、Anthropic Messages、云同步和完整 Agent 能力评级。API Key 不得明文落盘、不得返回 Renderer、不得进入日志，也不得被 Grok 启动的 Bash/Terminal 工具读取。

**主要风险：** 应用身份仍使用旧名称会导致未来 `userData` 路径变化，因此必须先稳定 Agent Studio 的应用标识；所谓 OpenAI 兼容服务可能没有 `/models` 或不支持工具调用，因此提供 Model ID 手填兜底并只承诺基础连接验证；Grok Runtime 必须读取环境变量中的 Key，但工具子进程不能继承它，因此必须生成明确的 Shell Environment Policy；Linux 安全存储可能退化为 `basic_text`，此时禁止明文持久化，只允许本次会话使用。

**技术栈：** Electron 39 `safeStorage` / `ipcMain` / `app.getPath('userData')`、Vue 3、TypeScript、Node.js 文件系统、Grok Build ACP、自定义 `GROK_HOME`、Vitest。

---

## 1. 已确认的产品决策

### 1.1 首次启动字段

第一版配置页包含：

- Base URL；
- 认证方式：`Bearer API Key` 或 `无需认证`；
- API Key：选择 Bearer 时必填，使用密码输入框；
- Model ID：优先从 `/models` 获取，接口不可用时允许手动填写。

仅填写 URL 和 Key 不足以启动模型，因为推理请求仍需要明确的 Model ID。

### 1.2 首次启动判断

不保存独立的 `firstRun` 布尔值。启动时检查活动配置是否完整：

- 配置文件存在且 `schemaVersion` 可识别；
- Base URL 和 Model ID 合法；
- Bearer 模式下存在可解密的 API Key；
- 配置未被用户清除。

任一条件不成立则进入配置页。服务暂时离线不等于配置丢失，已经保存的配置不得因为一次网络失败而被清除或重新进入首次引导。

### 1.3 MVP 交互原则

- 第一次没有可用配置时必须完成配置，不提供“跳过后进入不可用主界面”；
- `/models` 失败不阻塞手动填写 Model ID；
- 保存前必须完成一次针对所选模型的最小真实请求；
- 保存后的 Key 不回填、不显示完整值，只显示“密钥已保存”；
- 模型快捷选择器放在输入框 footer 左侧，只显示接口真实返回的 `displayName ?? modelId`；
- Runtime 身份继续在顶部独立展示，模型标签禁止添加 `Grok ·`、`Codex ·` 或 Provider 前缀；
- 修改 Base URL 的 origin 时，不得静默复用旧 Key，必须重新输入；
- 用户可在设置中更换 Key、修改配置或清除全部配置；
- 清除配置前先断开当前 Runtime，完成后返回首次配置页。

### 1.4 URL 安全规则

- Provider 服务允许使用 `https:` 或 `http:`，兼容本机、局域网和公网自建服务；
- 使用 `http:` 时配置页必须明确提示 API Key 与请求内容不具备传输加密，但不阻断用户连接；
- URL 不允许内嵌用户名或密码；
- URL 的 query 和 hash 中不允许出现 Key、Token 等凭据；
- 保存前移除无意义的末尾 `/`，但不擅自添加或删除 `/v1`；
- API Key 不校验 `sk-` 前缀，以兼容 OpenRouter 和自建服务。

## 2. 目标数据模型

共享类型放在 `src/shared/provider.ts`，不得加入 Grok 专属类型文件。

```ts
export type ProviderAuthMode = 'bearer' | 'none'

export interface ProviderConfigInput {
  baseUrl: string
  authMode: ProviderAuthMode
  apiKey?: string
  modelId: string
  modelDisplayName?: string
}

export interface ProviderConfigSummary {
  configured: boolean
  baseUrl?: string
  authMode?: ProviderAuthMode
  modelId?: string
  modelDisplayName?: string
  hasApiKey: boolean
  credentialStorage: 'secure' | 'session-only' | 'unavailable' | 'corrupt'
  testedAt?: string
  updatedAt?: string
}

export interface ProviderModelOption {
  modelId: string
  displayName?: string
}

export interface ProviderTestResult {
  ok: boolean
  stage: 'validation' | 'models' | 'inference'
  message: string
  models?: ProviderModelOption[]
}
```

模型身份规则：

```ts
const modelLabel = modelDisplayName?.trim() || modelId
```

- `modelId` 是请求和持久化的权威标识；
- `modelDisplayName` 只保存接口真实返回的名称，用于离线和重启后的展示；
- 接口没有展示名称时只显示原始 `modelId`；
- 不根据 ID 猜测、翻译或编造名称；
- 不把 Runtime 或 Provider 名称拼入模型标签。

磁盘配置使用版本化结构，只保存 `safeStorage` 生成的加密结果：

```json
{
  "schemaVersion": 1,
  "baseUrl": "https://api.example.com/v1",
  "authMode": "bearer",
  "modelId": "example-model",
  "modelDisplayName": "Example Model",
  "encryptedApiKey": "<safeStorage Buffer 的 Base64>",
  "testedAt": "2026-08-07T00:00:00.000Z",
  "updatedAt": "2026-08-07T00:00:00.000Z"
}
```

配置文件位置：

```text
app.getPath('userData')/
├── config/
│   └── provider.json
└── grok-home/
    └── config.toml
```

## 3. 启动和运行数据流

### 3.1 第一次启动

```text
app.whenReady()
→ 初始化 ProviderConfigStore
→ Renderer 调用 provider:get-summary
→ 没有完整配置
→ 显示 ProviderOnboarding
→ 用户填写 Base URL 和认证信息
→ 主进程请求 /models
→ 用户选择或手填 Model ID
→ 主进程执行最小 Chat Completions 请求
→ safeStorage 加密 Key
→ 原子写入 provider.json
→ 生成无明文 Key 的 grok-home/config.toml
→ 返回脱敏摘要
→ 进入工作台并允许选择工作目录
```

### 3.2 后续启动

```text
app.whenReady()
→ 读取 provider.json
→ 校验版本和普通字段
→ Bearer 模式下验证密钥可解密
→ Renderer 只获得 ProviderConfigSummary
→ 配置完整则直接进入工作台
→ 用户选择工作目录后再启动 Grok Runtime
```

后续启动不主动对远程服务发请求，避免网络临时不可用时错误触发首次引导。真正连接失败时在工作台显示可重试错误，并提供“打开设置”入口。

### 3.3 Grok Runtime 注入

生成的 `grok-home/config.toml` 不包含明文 Key：

```toml
[model.agent-studio-default]
model = "<MODEL_ID>"
base_url = "<BASE_URL>"
name = "<MODEL_ID>"
env_key = "AGENT_STUDIO_MODEL_API_KEY"
api_backend = "chat_completions"
context_window = 32768

[shell_environment_policy]
inherit = "core"
ignore_default_excludes = false
exclude = [
  "AGENT_STUDIO_MODEL_API_KEY",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY"
]
```

启动命令语义：

```text
grok --no-auto-update agent --no-leader -m agent-studio-default stdio
```

主进程启动子进程前：

- 从安全存储解密当前 Key；
- 在子进程专属环境中设置 `GROK_HOME`；
- Bearer 模式下设置 `AGENT_STUDIO_MODEL_API_KEY`；
- 从继承环境中移除 `XAI_API_KEY` 和 `GROK_CODE_XAI_API_KEY`；
- 不修改全局 `process.env`；
- 通过 Shell Environment Policy 阻止工具子进程读取密钥。

App 独立 `GROK_HOME` 不修改用户的 `~/.grok/config.toml`。第一版接受暂不共享用户原有 Grok 登录、历史、插件和 Skills，后续另行设计导入机制。

## 4. IPC 边界

新增中性 IPC，不再把 Provider 能力塞入 `grok:*`：

```text
provider:get-summary
provider:list-models
provider:save
provider:select-model
provider:clear
```

Preload 只暴露类型化窄接口：

```ts
interface ProviderDesktopApi {
  getSummary(): Promise<ProviderConfigSummary>
  listModels(
    input?: Pick<ProviderConfigInput, 'baseUrl' | 'authMode' | 'apiKey'>
  ): Promise<ProviderTestResult>
  save(input: ProviderConfigInput): Promise<ProviderConfigSummary>
  selectModel(model: ProviderModelOption): Promise<ProviderConfigSummary>
  clear(): Promise<ProviderConfigSummary>
}
```

- 首次配置调用 `listModels(input)`，使用表单中尚未保存的 URL 和 Key；
- 工作台模型选择器调用无参数的 `listModels()`，由主进程读取已保存凭据；
- `save` 合并“最小推理测试”和“安全保存”，成功后 Renderer 立即清空 Key；
- `selectModel` 使用已保存凭据验证新模型、更新配置，并在需要时安全重启当前 Runtime；
- 切换失败时恢复旧模型配置，UI 不得先乐观显示新模型。

禁止注册任何能够读取已保存明文 Key 的 IPC，例如 `provider:get-api-key`。

主进程必须校验 IPC 参数，Renderer 校验只负责即时交互反馈，不能作为安全边界。

## 5. 实施任务

### 任务 0：稳定 Agent Studio 应用身份

**任务目标：**

- 在开始写入 `userData` 前完成应用身份迁移，避免后续 `productName`、`appId` 改动导致已保存配置路径变化或密钥无法恢复。

**文件：**

- 修改：`package.json`
- 修改：`electron-builder.yml`
- 修改：`src/main/index.ts`
- 修改：`src/main/grok-agent.ts`
- 修改：`src/renderer/index.html`
- 修改：`src/renderer/src/App.vue`
- 保留并复核：`README.md` 当前未提交的 Agent Studio 改名内容

**前置依赖：**

- 产品工作名已确定为 Agent Studio；GitHub 仓库已改为 `promise-thens/agent-studio`。

**数据流/接口梳理：**

- `productName` 和包名会影响安装包名称及 Electron `userData` 路径。
- `appId` 和 App User Model ID 会影响操作系统应用身份。
- ACP `clientInfo.name` 只是 Runtime 客户端标识，应改成 `agent-studio`，但 Grok Runtime 的类名和协议文案仍保留 Grok 含义。

- [ ] **第 1 步：统一应用名称和仓库元数据**
  - `package.json` 的 `name` 改为 `agent-studio`，描述改为多 Agent 本地工作台，homepage 改为新仓库地址。
  - `electron-builder.yml` 的 `appId`、`productName` 和 `executableName` 改为 Agent Studio 对应值。
  - HTML 标题、应用侧栏标题和选择目录文案改为 Agent Studio。
  - 保留代码中表示具体 Runtime 的 “Grok Build” 名称，不做机械全局替换。

- [ ] **第 2 步：验证应用身份稳定**
  - 运行 typecheck、lint 和构建。
  - 启动开发版确认窗口标题、侧栏标题和工作目录选择文案正确。
  - 记录新的 `app.getPath('userData')`，后续 Provider 配置以此路径为准。

**完成标志：**

- 仓库、包元数据、安装包产品名和界面品牌统一为 Agent Studio，Runtime 专属名称仍准确。

### 任务 1：建立 Provider 共享类型和输入校验

**任务目标：**

- 为 Renderer、Preload 和主进程建立统一的 Provider 输入、摘要和测试结果类型，并在主进程实现可靠的 URL 与字段校验。

**文件：**

- 创建：`src/shared/provider.ts`
- 创建：`src/main/provider-validation.ts`
- 创建：`src/main/provider-validation.test.ts`
- 修改：`package.json`

**前置依赖：**

- 任务 0 已完成，应用身份和 `userData` 路径稳定。

**数据流/接口梳理：**

- Renderer 提交原始字符串。
- 主进程将 Base URL 转换为 `URL`，验证协议、主机、凭据、query 和 hash。
- 校验成功后输出规范化字符串；失败时返回稳定错误码和可理解文案。

- [ ] **第 1 步：定义共享类型**
  - 实现本计划第 2 节中的输入、摘要、模型选项和测试结果类型。
  - 错误结果增加稳定错误码，用于区分 URL、认证、网络、限流、模型和协议问题。

- [ ] **第 2 步：实现主进程输入校验**
  - URL 仅允许 HTTP 或 HTTPS；HTTP 连接由 Renderer 显示明文传输风险提示。
  - 拒绝内嵌账号密码和疑似 Secret 的 query/hash。
  - Bearer 模式要求非空 Key；none 模式不得残留 Key。
  - Model ID 在保存和推理测试时必填，读取模型列表时允许为空。

- [ ] **第 3 步：添加校验测试**
  - 覆盖 HTTPS、本机/局域网/公网 HTTP、内嵌凭据、Secret query、空 Key、异常字符和 URL 规范化。

**完成标志：**

- 所有 Provider IPC 都可以复用同一套主进程校验，不依赖 Renderer 的可信输入。

### 任务 2：实现安全配置存储

**任务目标：**

- 使用 Electron `safeStorage` 和版本化 JSON 保存 Provider 配置，确保正常重启后可恢复且磁盘没有明文 Key。

**文件：**

- 创建：`src/main/provider-config-store.ts`
- 创建：`src/main/provider-config-store.test.ts`
- 创建：`src/main/sensitive-redaction.ts`
- 修改：`src/main/index.ts`

**前置依赖：**

- 任务 1 的共享类型和校验已完成。
- `safeStorage` 只在 `app.whenReady()` 后使用。

**数据流/接口梳理：**

- 保存时由主进程规范化输入，使用 `safeStorage.encryptString()` 加密 Key，并将 Buffer 转成 Base64。
- 读取时只向 Renderer 返回摘要；Runtime 通过主进程内部方法按需解密。
- 文件写入采用同目录临时文件和原子 rename，失败时保留旧配置。

- [ ] **第 1 步：实现版本化配置读写**
  - 路径固定为 `app.getPath('userData')/config/provider.json`。
  - 配置目录权限尽量设置为 `0700`，文件权限设置为 `0600`。
  - 对损坏 JSON、未知版本、非法 Base64 和解密失败提供可恢复状态。

- [ ] **第 2 步：实现平台安全策略**
  - macOS 使用 Keychain，Windows 使用 DPAPI。
  - Linux 只有安全后端可用时才允许持久化。
  - 检测到 `basic_text` 或安全存储不可用时，Key 只保留在本次主进程内存，并返回 `session-only`，不得启用明文加密降级。

- [ ] **第 3 步：实现脱敏函数**
  - 脱敏当前已知 Key、Bearer Header、`api-key`、`x-api-key` 和 URL 中的 Secret 参数。
  - 后续 Runtime stderr、IPC 错误和主进程日志统一经过脱敏。

- [ ] **第 4 步：添加存储测试**
  - 覆盖加密保存、重启读取、配置损坏、解密失败、原子写入失败、清除配置和不安全存储降级。

**完成标志：**

- 重启可以恢复配置摘要和内部 Key；Renderer、配置文件和日志中均无法获得明文 Key。

### 任务 3：实现模型发现与连接测试

**任务目标：**

- 让用户能够通过 Base URL 和认证信息读取模型列表，并验证选定模型能完成最小 Chat Completions 请求。

**文件：**

- 创建：`src/main/provider-connection-tester.ts`
- 创建：`src/main/provider-connection-tester.test.ts`
- 修改：`src/main/sensitive-redaction.ts`

**前置依赖：**

- 任务 1 的输入校验可用。
- 任务 2 的脱敏函数可用。

**数据流/接口梳理：**

- `listModels` 调用 `{baseUrl}/models`，Bearer 模式发送 Authorization Header。
- 标准响应读取 `data[].id`，排序去重后返回 Renderer。
- `test` 调用 `{baseUrl}/chat/completions`，发送最小非流式请求，并验证返回包含有效 assistant 内容。
- 所有服务端错误先脱敏，再映射为用户可操作的错误。

- [ ] **第 1 步：实现模型列表请求**
  - 设置明确的连接和响应超时。
  - `/models` 返回 404 或非标准结构时，返回“允许手动输入”的结果，而不是把整个配置判为失败。

- [ ] **第 2 步：实现最小推理测试**
  - 请求内容固定且 Token 消耗极小。
  - 区分 401/403、404、429、超时、TLS、模型不存在和响应协议不兼容。
  - 不在错误信息中输出完整 Header、Key 或原始请求对象。

- [ ] **第 3 步：添加连接测试单元测试**
  - 使用本地 Mock Server 覆盖模型列表成功、无 `/models`、错误 Key、限流、超时和错误响应结构。

**完成标志：**

- 用户可以自动选择或手填模型，并在保存前确认该 URL、认证和 Model ID 能完成一次真实请求。

### 任务 4：注册窄 Provider IPC 与 Preload API

**任务目标：**

- 建立 Renderer 到主进程的最小 Provider 接口，不暴露文件系统、safeStorage 或明文 Key 读取能力。

**文件：**

- 修改：`src/main/index.ts`
- 修改：`src/preload/index.ts`
- 修改：`src/preload/index.d.ts`
- 修改：`src/shared/provider.ts`

**前置依赖：**

- 任务 2 的存储和任务 3 的连接测试已完成。

**数据流/接口梳理：**

- `get-summary` 只返回脱敏摘要。
- 首次配置的 `list-models` 使用本次表单提交的 Key；工作台调用时由主进程读取已保存 Key，任何路径都不得返回 Key。
- `save` 必须在主进程执行真实请求验证，验证成功后才持久化，避免 Renderer 保存“已测试”假状态。
- `select-model` 使用已保存凭据验证候选模型；Runtime 正忙时拒绝切换，重连失败时回滚旧模型。
- `clear` 先断开 Runtime，再清除内存和磁盘配置。

- [ ] **第 1 步：注册 IPC Handler**
  - 实现本计划第 4 节列出的五个 channel。
  - 校验 sender 来自主窗口，并限制参数大小。

- [ ] **第 2 步：暴露窄 Preload API**
  - `window.provider` 只包含五个明确方法。
  - 不向 Renderer 暴露通用配置文件路径、密文或 `safeStorage`。

- [ ] **第 3 步：验证 IPC 安全边界**
  - 搜索确认没有 `provider:get-api-key` 或等价接口。
  - DevTools 中只能获取摘要，无法重新读取已保存 Key。

**完成标志：**

- Renderer 可以完成配置流程，但无法越过主进程读取明文凭据。

### 任务 5：实现首次配置页面与启动门禁

**任务目标：**

- 首次启动显示清晰的 Provider 配置流程；配置完整时直接进入现有工作台。

**文件：**

- 创建：`src/renderer/src/components/ProviderOnboarding.vue`
- 创建：`src/renderer/src/components/ModelSelector.vue`
- 修改：`src/renderer/src/App.vue`
- 修改：`src/renderer/src/assets/main.css`
- 修改：`src/preload/index.d.ts`

**前置依赖：**

- 任务 4 的 `window.provider` API 可用。

**数据流/接口梳理：**

- App 启动状态分为 `loading`、`needs-provider`、`ready` 和 `config-error`。
- `onMounted` 首先读取 Provider 摘要，再决定显示配置页或工作台。
- Provider 配置完成前不允许选择工作目录或连接 Grok。

- [ ] **第 1 步：实现启动门禁**
  - 加载摘要期间显示明确 Loading 状态，避免先闪现工作台再跳到配置页。
  - 配置损坏或 Key 无法解密时，保留可用的 URL 和 Model ID，要求重新输入 Key。

- [ ] **第 2 步：实现配置表单**
  - Base URL、认证方式、API Key、模型读取和 Model ID 手填具备明确验证提示。
  - Key 使用密码输入框；只有“测试并保存”成功后才清空 Renderer 中的 Key ref。
  - `/models` 不可用时切换到手动 Model ID，不把用户困死。

- [ ] **第 3 步：实现测试、保存和错误反馈**
  - 使用一个“测试并保存”动作完成主进程推理验证和持久化，不维护容易失效的 Renderer `tested` 布尔值。
  - 错误提示映射为 URL、认证、路径、限流、余额、模型和服务兼容问题。
  - 保存成功后切换到现有工作台，并引导选择工作目录。

- [ ] **第 4 步：实现输入框模型选择器**
  - 控件位于输入框 footer 左侧，替换或位于现有快捷键提示之前；下拉菜单向上展开。
  - 主标签严格使用 `modelDisplayName?.trim() || modelId`，禁止显示 Runtime 或 Provider 前缀。
  - 名称与 ID 不同时，下拉项副行显示真实 Model ID；长名称截断并通过 title 显示完整值。
  - Agent 处于 `connecting` 或 `busy` 时禁用切换；未选工作目录时仍允许切换模型。
  - 小窗口优先隐藏 Enter/Shift Enter 提示，保留模型选择器和发送按钮。

- [ ] **第 5 步：验证首次与再次启动**
  - 无配置启动显示表单。
  - 配置完成后重启直接显示工作台。
  - 服务离线时重启仍保留配置，不重新要求输入 Key。

**完成标志：**

- 用户可以不接触配置文件完成首次配置，后续正常启动无需再次输入。

### 任务 6：生成 App 专属 Grok 配置并接入 Runtime

**任务目标：**

- 使用保存的 Provider 配置启动 Grok ACP，同时确保用户原有 Grok 配置不被修改，模型 Key 不暴露给工具子进程。

**文件：**

- 创建：`src/main/grok-provider-config.ts`
- 创建：`src/main/grok-provider-config.test.ts`
- 修改：`src/main/grok-agent.ts`
- 修改：`src/main/index.ts`

**前置依赖：**

- 任务 2 可以在主进程内部解密 Key。
- 任务 5 已阻止无配置状态连接 Runtime。

**数据流/接口梳理：**

- 用户选择工作目录后，`GrokAgentBridge.connect()` 获取活动 Provider 内部配置。
- 主进程生成或更新 `grok-home/config.toml`。
- spawn 使用 App 专属 `GROK_HOME`、模型别名和临时 Key 环境变量。
- ACP initialize 和 session/new 成功后，现有聊天流程继续工作。

- [ ] **第 1 步：实现无密钥 TOML 生成器**
  - 转义 Model ID 和 Base URL，防止 TOML 注入或配置破坏。
  - 固定 `api_backend = "chat_completions"` 和保守的 `context_window = 32768`。
  - 生成 Shell Environment Policy，过滤所有 Key/Secret/Token 和明确的 Provider 变量。

- [ ] **第 2 步：调整 Grok 进程启动**
  - 参数改为 `agent --no-leader -m agent-studio-default stdio`。
  - 环境设置 App 专属 `GROK_HOME` 和本次解密的 Key。
  - 移除继承的 xAI Key，且不修改全局 `process.env`。
  - 子进程启动和退出错误继续经过脱敏。

- [ ] **第 3 步：验证 Runtime 闭环**
  - 使用测试 Provider 完成 ACP 初始化、创建会话和一次简单回答。
  - 让 Grok Bash 工具执行 `printenv AGENT_STUDIO_MODEL_API_KEY`，预期读不到值。
  - 搜索 `grok-home/config.toml`、日志和 UI 输出，预期没有 Key 明文。

**完成标志：**

- Agent Studio 使用用户配置的模型运行 Grok Runtime，且不污染用户 `~/.grok`，工具子进程无法读取模型凭据。

### 任务 7：补齐修改、清除和故障恢复

**任务目标：**

- 让用户能够安全更换服务或密钥，并从配置损坏、服务离线和 Keychain 变化中恢复。

**文件：**

- 修改：`src/renderer/src/components/ProviderOnboarding.vue`
- 修改：`src/renderer/src/App.vue`
- 修改：`src/main/provider-config-store.ts`
- 修改：`src/main/index.ts`

**前置依赖：**

- 任务 5 和任务 6 已完成基础闭环。

**数据流/接口梳理：**

- 设置按钮复用同一 Provider 表单，但已保存 Key 只显示状态。
- 更换 URL origin 时强制输入新 Key并重新测试。
- 输入框模型选择器只更换当前 Provider 下的模型，不修改 URL 或 Key。
- 清除配置先断开 Runtime，再删除内存凭据、配置文件和生成的 Grok 配置。

- [ ] **第 1 步：实现配置编辑**
  - URL 和 Model ID 可以修改；Bearer Key 留空表示沿用，但仅限 URL origin 未变化。
  - 更换 Key 使用显式“替换”操作，不通过空字符串隐式猜测。

- [ ] **第 2 步：实现清除配置**
  - 二次确认后断开 Grok、清除配置和临时密钥，并返回首次配置页。
  - 清除失败时给出明确错误，不能让 UI 和磁盘状态互相矛盾。

- [ ] **第 3 步：实现模型切换事务**
  - 使用已保存 Key 验证候选模型，验证失败保持旧模型和当前 Runtime。
  - Runtime 空闲且已连接时，保存候选模型后重启当前会话；重连失败则恢复旧配置并尝试恢复旧 Runtime。
  - 只有主进程确认切换和重连成功后，Renderer 才更新显示名称。

- [ ] **第 4 步：实现故障恢复**
  - Key 无法解密时保留 URL 和 Model ID，引导重新输入。
  - 服务离线时提供重试和打开设置，不自动删除配置。
  - 配置版本未知时标记 `corrupt`，保留原文件供诊断并阻止 Runtime 启动。

**完成标志：**

- 配置的新增、使用、修改、失效恢复和清除形成完整生命周期。

### 任务 8：完成安全与业务验收

**任务目标：**

- 对首次配置、持久化、Runtime 使用和异常路径做端到端验证，确认功能不是“表单保存成功”，而是模型真实可用且凭据未泄露。

**文件：**

- 修改：`package.json`
- 按需修改：本计划新增的测试文件
- 不修改：与 Provider 功能无关的业务模块

**前置依赖：**

- 任务 0 至任务 7 全部完成。

- [ ] **第 1 步：运行静态和单元验证**
  - 运行 `pnpm typecheck`。
  - 运行 `pnpm lint -- --no-cache` 或仓库等价无缓存命令。
  - 运行 Provider、存储、TOML 和连接测试。
  - 运行 `pnpm build`。

- [ ] **第 2 步：验证主流程**
  - 新用户配置远程 HTTPS 服务和 Bearer Key。
  - 新用户配置公网 HTTP 自建服务，并看到明文传输风险提示。
  - 新用户配置 localhost 无认证服务。
  - 自动获取模型并选择。
  - `/models` 不存在时手填 Model ID。
  - 关闭并重新打开应用，不再要求输入 Key。

- [ ] **第 3 步：验证异常路径**
  - 错误 URL、401/403、404、429、超时、TLS、模型不存在和响应不兼容均有明确提示。
  - 服务离线后重启不会丢配置。
  - Keychain 重置或密文损坏后可以重新输入恢复。
  - 修改 URL origin 不会自动把旧 Key 发给新服务。

- [ ] **第 4 步：验证密钥不泄露**
  - 使用唯一测试 Key 搜索 `userData`、项目目录、日志、DevTools、IPC 返回、Runtime stderr 和构建输出。
  - `provider.json` 只包含 safeStorage 密文。
  - `grok-home/config.toml` 不包含明文 Key。
  - Grok 的 Bash/Terminal 环境读取不到 Key。

- [ ] **第 5 步：验证现有功能回归**
  - 选择工作目录、连接、发送任务、停止、计划展示、工具活动和权限弹窗保持可用。
  - 无 Provider 配置时不允许误启动 Grok。

**完成标志：**

- 主流程、失败恢复、凭据安全和原有聊天闭环全部通过可复现验证。

## 6. 验收标准

### 功能正确性

- 新安装首次启动必须进入 Provider 配置页。
- 用户可以填写 Base URL、认证信息，并自动选择或手动填写 Model ID。
- 保存前完成一次真实模型请求。
- 配置完成后可以通过 Grok ACP 使用所选模型完成一次回答。
- 应用正常重启后不再要求重新输入 Key。
- 输入框左下角显示接口真实 `displayName`，缺失时显示原始 `modelId`，不添加 Runtime 或 Provider 前缀。
- Runtime 空闲时可以切换模型；切换失败保持或恢复旧模型。

### 交互完整性

- 加载、测试、保存、失败、重试、修改和清除均有明确状态。
- Key 输入后不回显，已保存状态可以被理解。
- `/models` 不可用时用户仍有手动 Model ID 路径。
- 服务离线不会被误判为首次启动。
- 模型菜单向上展开，执行任务期间明确禁用切换。

### 数据一致性

- Renderer 摘要、磁盘配置和 Runtime 实际使用的 URL、Model ID 保持一致。
- 配置更新采用原子写入，失败后旧配置仍可读取。
- 清除配置后 Runtime 断开、磁盘配置删除、内存凭据清空并返回首次配置页。

### 安全性

- API Key 不以明文出现在配置、TOML、日志、IPC 返回和 UI 中。
- Renderer 没有读取已保存 Key 的接口。
- HTTP 与 HTTPS 均可连接；HTTP 配置持续显示明文传输风险，且请求禁止自动跟随重定向。
- URL 内嵌凭据和 query/hash 被主进程拒绝。
- Grok 工具子进程无法读取模型 Key。
- Linux 不安全存储环境不会静默降级为明文持久化。

### 回归检查

- 现有 ACP 会话、聊天、计划、工具状态、停止和权限审批不被破坏。
- App 专属 `GROK_HOME` 不修改用户的 `~/.grok`。
- README 当前已有的 Agent Studio 改名内容被保留，不在本功能中误覆盖。

## 7. 本期明确不处理

- 多 Provider 列表、排序和切换；
- Responses API 和 Anthropic Messages；
- 自定义 Header、Query Parameter、代理和证书配置；
- 自动探测上下文窗口；
- Provider 模板市场；
- Key 云同步或跨设备迁移；
- 完整工具调用能力评级；
- Codex app-server 的 Provider 配置；
- 导入用户原有 Grok 登录、历史、MCP、Skills 和插件；
- Windows、Linux 的完整 UI 自动化能力。

这些内容进入后续独立计划，不能在本期实现时顺手扩张。

## 8. 实施顺序与交接

推荐严格按照以下依赖推进：

```text
应用身份稳定
→ Provider 类型与校验
→ 安全存储
→ 模型发现与测试
→ IPC
→ 首次配置 UI
→ Grok Runtime 注入
→ 修改/清除/恢复
→ 端到端验收
```

执行时最需要关注的三个问题：

1. 不要因为 Renderer 已验证就跳过主进程校验；
2. 不要为了让 Grok 读取 Key 而把它暴露给 Bash/Terminal；
3. 不要把“接口能回答一次”宣传为“模型完整支持 Agent 工具调用”。
