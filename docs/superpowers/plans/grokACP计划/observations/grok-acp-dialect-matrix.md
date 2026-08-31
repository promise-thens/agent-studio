# Grok ACP 方言矩阵

> GACP-04 产出。记录 Agent Studio Grok Adapter **已绑定** 的 ACP 方言版本。  
> 新 Grok CLI 版本必须 **新增一行观察**，禁止默默改代码兼容。

## 已支持基线（GACP-01）

| 项 | 值 |
| --- | --- |
| 状态 | **已支持** |
| Grok CLI | `grok 1.0.5 (5115b46bc909)` |
| `acp.PROTOCOL_VERSION` | `1` |
| Agent Studio 观察 commit | `92025a3` |
| 观察记录 | [grok-acp-observation.md](./grok-acp-observation.md) |
| 记录日期 | 2026-08-19 |

后续若升级 Grok CLI，先补观察行，再改 `src/main/runtime/grok/grok-acp-dialect.ts` 与 Adapter。

## 启动参数

生产 spawn（`GROK_PRODUCTION_AGENT_ARGV`）：

```text
grok --no-auto-update agent --no-leader -m agent-studio-default stdio
```

| 项 | 契约 |
| --- | --- |
| cwd | Task / Project 的 canonical root |
| stdio | 全 pipe；stderr 主进程排空并脱敏，不升为产品事件 |
| 受控 E2E | **不得**复用生产 argv；使用 `process.execPath` + fixture flags |

## 握手字段

请求（Client → Agent）：

| 字段 | 值 / 规则 |
| --- | --- |
| `protocolVersion` | `acp.PROTOCOL_VERSION`（当前 1） |
| `clientCapabilities` | `{}`（GACP-05 前禁止广告 fs/terminal） |
| `clientInfo.name` | `agent-studio` |
| `clientInfo.version` | Main 注入：打包 `app.getVersion()`；开发 `${app.getVersion()}-dev` |

允许进入产品逻辑的响应字段（`GROK_INITIALIZE_RESPONSE_ALLOWED_FIELDS`）：

- `protocolVersion`
- `agentInfo.version`
- `loadSession`
- `sessionCapabilities.resume`
- `sessionCapabilities.close`

其它字段（`auth`、`providers`、`_meta`、promptCapabilities 等）只进观察文档，不驱动业务分支。版本不等 → fail-closed。

## session/set_model

| 项 | 契约 |
| --- | --- |
| 方法 | `session/set_model` |
| 参数 | `{ sessionId, modelId: 'agent-studio-default' }` |
| 成功 | 非 null 普通对象；不读 `_meta` 业务字段 |
| 失败 | `disconnectInternal(false)` + 产品文案含「绑定 Agent Studio 模型失败」 |

## GROK_HOME 与二进制路径（必须分开）

| 路径 | 用途 |
| --- | --- |
| `userData/grok-home`（`GROK_HOME`） | App 私有配置根；写 `config.toml`，**禁止**写用户 `~/.grok` |
| `PATH` 上的 `~/.grok/bin` | **仅**解析 `grok` 二进制；配置与二进制来源分离 |

不得把两者合成同一路径，也不得因找二进制而修改用户 `~/.grok` 配置树。

## 已知失败模式（产品文案必须可区分）

| kind（方言内部） | 通用错误码 | 产品文案要点 |
| --- | --- | --- |
| `cli-missing` | `runtime-unavailable` | 「还没有安装 Grok Build CLI。」（无路径 / 无 ENOENT 原文） |
| `protocol-incompatible` | `operation-failed` | 保留「ACP 协议版本不兼容…」，不包成笼统「连接失败」 |
| `provider-config-missing` | `runtime-unavailable` | 「模型服务配置不可用，请重新配置 URL、Key 和模型。」 |
| `set-model-failed` | `operation-failed` | 「绑定 Agent Studio 模型失败」语义 |
| `config-write-failed` | `operation-failed` | 「无法生成 Grok 配置：…」（已脱敏） |
| `process-exited` | `operation-failed` | 「Grok Build 已退出，代码 N」 |
| `generic` | `operation-failed` | 「连接失败：…」或「无法启动 Grok Build：…」 |

失败信息继续走主进程脱敏；不得把 stderr 原文、家目录、假 Key、Header 丢给 UI。

## 观察追加规则

1. 升级或换装 Grok CLI 后，先用正式产品路径补 [grok-acp-observation.md](./grok-acp-observation.md)（或本矩阵新行）。
2. 对照本表：启动 argv、握手允许字段、`set_model`、`GROK_HOME` 是否仍成立。
3. **禁止**在没有新观察行的情况下，为“兼容下一版”偷偷放宽守卫或改 argv。
4. 若新版本破坏契约：fail-closed，并让用户能从产品文案判断是方言变了还是本机配置/CLI 缺失。

## 版本观察表（追加用）

| 日期 | Grok CLI | PROTOCOL_VERSION | 观察 commit | 结论 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 2026-08-19 | `grok 1.0.5 (5115b46bc909)` | 1 | `92025a3` | **已支持** | GACP-01 冻结观察 |
| | | | | | ← 新版本在此追加，勿改上一行 |
