# GACP-04 Grok ACP 方言兼容契约

> **致执行者：** 把当前 Adapter 依赖的 Grok 私有约定收成版本化契约。本计划在 P0-10 之后、第二个 Runtime（P2）之前完成，可与 P0-12 并行。P1-05 继续拥有密钥与 `GROK_HOME` 隔离复核，本计划拥有 ACP 启动方言。
>
> **状态：** 待开始（前置：P0-10；建议同时有 GACP-01 观察记录）
>
> **插入点：** P0-10 之后、P2 之前；不阻塞 P0-12

**优先级：** P0-A 收口 / 权重 4（避免 Grok 小版本把整条工作台打成“连接失败”却说不清原因）

**目标：** 明确 Agent Studio 支持的 Grok ACP 方言：启动参数、握手字段、`session/set_model`、独立 `GROK_HOME`、环境白名单和失败关闭策略。方言漂移时必须失败关闭并给出可诊断、已脱敏的产品错误，而不是猜测兼容。

**核心数据流：**

```text
ProviderRuntimeConfig（主进程已校验）
  → writeGrokProviderConfig(userData/grok-home/config.toml)
  → buildGrokRuntimeEnvironment()
  → spawn grok agent stdio
  → initialize + session/set_model
  → 方言检查器（本计划新增，只读广告/响应形状）
  → 通过才允许 createSession / startTurn
```

**约束与边界：**

- 不把 Grok 扩展方法提升为中性 `AgentRuntimeAdapter` 方法。`session/set_model` 继续只存在于 `runtime/grok`。
- 不修改用户 `~/.grok`。
- 不改全局 `process.env`。
- 不实现 ACP `authenticate` / `providers` 作为产品登录。账号登录和模型配置仍然分开（见产品愿景 6.1）。
- 不为“兼容下一版 Grok”预先解析 `_meta`。
- P1-05 的密钥事务、origin 变更必须重新输入 Key 等规则继续有效；本计划只引用，不重写 Provider 存储。

**主要风险：**

- `bindAgentStudioModel()` 要求响应是非 null object。Grok 若改成空响应或只回 `{ _meta }`，现有代码会拆连接。这是正确的 fail-closed，但用户需要能看懂。
- `PATH` 仍拼接 `~/.grok/bin` 以找到二进制，同时 `GROK_HOME` 指向 App 目录。二进制来源和配置来源分离，必须在契约里写清楚，避免以后有人把两者合成一个路径。
- `clientInfo.version` 目前写死 `'0.1.0'`，与 `package.json` 可能不一致。

**技术栈：** Electron 39、TypeScript、pnpm 10、Node.js 20+、Vitest；Grok CLI 以 GACP-01 记录的版本为基线。

---

## 实施范围

**前置依赖：**

- P0-05 Adapter、P1-01 至 P1-03 实现基线、P0-10 工作台已能展示 Runtime 状态。
- 强烈依赖 GACP-01 观察文档中的握手和 set_model 记录。

**文件范围：**

- 复核并小幅整理：`src/main/runtime/grok/grok-acp-adapter.ts`、`src/main/provider/grok-provider-config.ts`
- 新增：`src/main/runtime/grok/grok-acp-dialect.ts` 及测试（启动参数、握手允许集、set_model 响应守卫）
- 新增：`docs/superpowers/plans/grokACP计划/observations/grok-acp-dialect-matrix.md`
- 复核：`src/main/index.ts` 中 Provider 保存后的 disconnect/connect 事务
- 不把方言检查泄漏到 `src/shared` 的通用 Agent 类型里

**安全策略：**

- 方言检查只能读取已经过 Adapter 投影的字段，或本进程内尚未出站的配置。
- 失败信息走 `redactSensitiveError`。
- 配置文件继续 `0700` / `0600`，TOML 不含明文 Key，Key 只在环境变量 `AGENT_STUDIO_MODEL_API_KEY`。

## 已锁定的方言清单

这些是当前代码已经依赖、本计划必须写成断言的事实。

### 1. 进程启动

```ts
// 备注：生产默认启动参数必须保持原样，不能经由通用 command/args 抽象。
['--no-auto-update', 'agent', '--no-leader', '-m', AGENT_STUDIO_MODEL_ALIAS, 'stdio']
```

- cwd = Task / Project 的 canonical root（connect 时的 workspace）
- stdio 全 pipe；stderr 只在主进程排空并脱敏，不升为产品事件
- 受控 E2E 不得走这条生产 spawn，继续走 `controlledFixture`

### 2. 配置与家目录

| 项 | 当前实现 | 契约 |
| --- | --- | --- |
| 配置根 | `userData/grok-home` | App 私有，禁止写 `~/.grok` |
| 配置文件 | `config.toml` 原子写入 | 无明文 Key |
| 模型别名 | `agent-studio-default` | session/set_model 只绑这个别名 |
| 协议后端 | `api_backend = "chat_completions"` | 未验证前不得改成 responses/anthropic 并宣称兼容 |
| Key 环境名 | `AGENT_STUDIO_MODEL_API_KEY` | 同时写入 shell exclude |
| 排除的工具环境 | 自身 + `XAI_API_KEY` + `GROK_CODE_XAI_API_KEY` | 保持 |

### 3. Runtime 环境

`buildGrokRuntimeEnvironment()` 只复制白名单系统变量，另设：

- `GROK_HOME` = App grok-home
- `PATH` = `~/.grok/bin` + 原 PATH（只为解析二进制）
- bearer 时的模型 Key

禁止再放进：`npm` token、用户 shell 里的其它云厂商 Key、Electron 调试变量（受控 E2E 除外）。

### 4. 握手

```ts
// 备注：clientCapabilities 为空是诚实广告，GACP-05 之前禁止改成 fs/terminal true。
connection.initialize({
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: {},
  clientInfo: { name: 'agent-studio', version: '0.1.0' }
})
```

本计划要求 `clientInfo.version` 改为读取应用真实版本（`app.getVersion()` 或构建期注入），避免 Grok 侧诊断对不上。

允许读取的响应字段仍只有：`protocolVersion`、`agentInfo.version`、`loadSession`、`sessionCapabilities.resume`、`sessionCapabilities.close`。其它字段进观察文档，不进产品逻辑。

### 5. session/set_model

- 方法名固定 `session/set_model`
- 参数：`{ sessionId, modelId: 'agent-studio-default' }`
- 成功：非 null 普通对象
- 失败或形状不对：`disconnectInternal(false)` + 产品错误“绑定 Agent Studio 模型失败”
- 晚到响应必须被 connectionGeneration 丢弃（已有测试，必须保留）

---

## 任务 1: 抽出方言模块

**任务目标：** 让 Adapter 不再到处散落魔法字符串，测试能直接锁启动参数和响应守卫。

**涉及范围：** `grok-acp-dialect.ts`、Adapter 引用、单测。

- [ ] **第 1 步: 冻结常量**
      说明：集中 `GROK_SET_MODEL_METHOD`、`AGENT_STUDIO_MODEL_ALIAS`、生产 argv、允许读取的 initialize 字段列表、set_model 响应守卫。
      预期：改 argv 会有单测失败；测试里禁止再复制一份魔法数组而不引用模块。

- [ ] **第 2 步: 实现握手兼容性检查**
      说明：输入为 `InitializeResponse` 的已投影子集。版本不等 → 现有拒绝。缺少 session/new 基线能力（规范要求 Agent 必须支持）只记录，不自行发明探测。
      预期：GACP-01 记录的真实握手能通过；故意改 version 的夹具被拒绝。

- [ ] **第 3 步: 实现 set_model 守卫**
      说明：把 Adapter 里“必须是 object”的检查搬进方言模块，并补充：禁止把 `_meta` 当业务字段读。
      预期：null / 数组 / 字符串响应全部失败关闭。

## 任务 2: 对齐版本与诊断

**任务目标：** 出问题时能判断是 Grok 方言变了，还是 App 配置错了。

**涉及范围：** `clientInfo`、能力快照、错误文案、方言矩阵文档。

- [ ] **第 1 步: clientInfo.version 使用真实应用版本**
      说明：从主进程注入，不在 Renderer 拼。开发态可以用 `0.1.0-dev`，打包用 `app.getVersion()`。
      预期：握手里的 Client 版本与关于页/安装包一致。

- [ ] **第 2 步: 写方言矩阵**
      说明：`grok-acp-dialect-matrix.md` 以 GACP-01 的 CLI 版本为“已支持”。列出启动参数、握手字段、set_model、GROK_HOME、已知失败模式。新 Grok 版本必须新增一行观察，不能默默改代码兼容。
      预期：P2 开始前，执行者能一眼看到 Grok Adapter 绑定的是哪一版方言。

- [ ] **第 3 步: 产品错误分类**
      说明：连接失败至少能区分：找不到 `grok` 二进制、协议版本不兼容、Provider 配置缺失、set_model 失败、进程退出。继续脱敏，不把 stderr 原文丢给 UI。
      预期：用户不会把“没装 CLI”和“模型绑定失败”看成同一句话。

## 任务 3: 与 P1-05 联合复核

**任务目标：** 方言契约不破坏密钥隔离，密钥复核不改掉 ACP 启动参数。

**涉及范围：** P1-05 清单、`persistProviderConfig()`、clear 配置。

- [ ] **第 1 步: 对照 P1-05 走隔离**
      说明：保存 Provider、切换 origin、清除配置、工具子进程 env 中无 Key。本计划不重做存储层，只确认 spawn env 仍满足 P1-05。
      预期：`clearGrokProviderConfig()` 只删 App grok-home 的 config.toml。

- [ ] **第 2 步: Provider 变更事务**
      说明：busy/connecting 时不能改模型；ready 时 disconnect + connect 失败要回滚旧配置。现有 `persistProviderConfig()` 必须仍被单测锁住。
      预期：方言模块引入后这条事务不回退。

- [ ] **第 3 步: 受控 E2E 不被生产方言绑死**
      说明：fixture 继续使用独立 argv 与 `ELECTRON_RUN_AS_NODE`。方言常量测试要分开生产/E2E 两条。
      预期：lifecycle / permission E2E 仍全绿。

---

## 验收标准

- [ ] 生产启动参数、GROK_HOME、set_model、initialize 允许字段都有单测锁定。
- [ ] `clientInfo.version` 不再写死成与发布无关的字符串。
- [ ] 方言矩阵文档存在，并指向 GACP-01 观察版本。
- [ ] 失败关闭策略不变：版本不兼容、set_model 形状错误、配置写失败都不会带着半开 session 继续 prompt。
- [ ] P1-05 的密钥隔离没有回退；`~/.grok` 不被修改。
- [ ] `pnpm typecheck`、相关 Vitest、既有 Electron E2E、`pnpm build`、`git diff --check` 通过。

## 非目标

- 不支持用户选择任意 `grok` argv。
- 不实现 HTTP/WebSocket ACP 传输。
- 不把该模块做成多 Runtime 注册中心。
- 不在本计划广告 fs/terminal。
