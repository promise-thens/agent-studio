# P0-19b Grok Sandbox 档位 实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
>
> **状态：** 任务 1–3 代码已落地；开发版 GUI 未走查（2026-09-04）。不得把设置页四档或自动 argv 测试标成 GUI 已过。
>
> **插入点：** [P0-19](p0-19-grok-host-capability-polish.md) 在 Plan mode 与 GACP-06 之后。依赖空闲时才能重启 Runtime 的既有模型切换纪律。

**优先级：** P0-A / 权重 4（Grok 已有内核沙箱，桌面现按档位传 `--sandbox`）

**Goal：** 用户能为当前工作台选择 Grok Sandbox 档位（off / workspace / read-only / strict），空闲重启 Runtime 后生效；未真正带上参数时不得显示「已沙箱」。

**Architecture：** 档位存在 App `GROK_HOME/config.toml` 或独立受控设置（由 `GrokHomeConfigController` 合并写入，禁止整文件覆盖）。`GrokAcpAdapter` 仅在档位不是 `off` 时于 **grok 二进制全局参数**加入 `--sandbox <profile>`，保持 `--no-leader`。Electron `webPreferences.sandbox` 与此无关，UI 必须写「Grok 沙箱」。

**Tech Stack：** 现有 grok-home 配置合并、`grok-acp-adapter.ts` spawn、设置页 Grok 配置栏。

**Spec：** [P0-19](p0-19-grok-host-capability-polish.md)；Grok 文档 `18-sandbox.md`。

## Global Constraints

- 沿用 P0-19。
- 首期只允许内置档：`off` | `workspace` | `read-only` | `strict`。不做 `devbox`、自定义 `sandbox.toml`、项目级 `.grok/sandbox.toml` 编辑器。
- 执行中禁止改档；改档请求必须等 Task 空闲，主进程重启连接成功后再更新 UI。
- 不修改用户 `~/.grok/sandbox.toml`。
- 失败时降级为明确错误，不得静默改回 off 还显示成功。

---

## 非目标

- 不把 Sandbox 说成 Permission Broker 的替代。Broker 仍审批意图；Sandbox 是 Grok 进程的内核限制。
- 不在桌面实现第二套 OS sandbox。
- 不因为 Sandbox 就放宽 L3。

## 数据流

```text
设置 → sandboxProfile
  → GrokHomeConfigController 合并写入（不得冲掉 [memory]/[mcp_servers]/[plugins]）
  → 若 Runtime 已连接且空闲：disconnect + connect，spawn 带 --sandbox
  → Renderer 只收到 { profile, applied: true } 或失败原因
执行中请求改档
  → 拒绝，提示先停任务
```

## 安全边界

- profile 枚举在主进程重校验，Renderer 字符串不可直接拼进 argv。
- spawn argv 仍静态构造，禁止把用户 toml 任意键变成 CLI 旗标。
- Grok 文档写明非 `off` 时 leader 会被拒绝：继续 `--no-leader`，不要为此打开 leader。
- 只读档位下用户仍可能通过记忆 junction 写 `~/.grok/memory`；产品文案写清「按 Grok 档位」，不要承诺挡掉记忆写入。

## 文件范围

- 修改：`src/main/runtime/grok/grok-acp-adapter.ts` spawn 参数
- 修改：`src/main/runtime/grok/grok-home-config-controller.ts`、`src/shared/grok-config-hints.ts`
- 修改：设置页 Grok 配置 UI（现有 Settings 分段，不新开窗口）
- 测试：adapter spawn 参数、配置合并、执行中拒绝改档
- 文档：hints 必须区分 Electron sandbox 与 Grok sandbox

### 任务 1: 冻结 CLI 位置与档位枚举

- [x] **第 1 步: 本机确认旗标位置**

说明：对照 `grok --help` / 文档，确认 `--sandbox` 在 `agent` 子命令之前。用假 GROK_HOME 试 `workspace` 能否起来。失败则停止本计划，改记录阻塞，不要改用环境变量猜测。

- [x] **第 2 步: 共享枚举**

说明：在 `src/shared` 增加可序列化 `GrokSandboxProfile` 联合类型与 type guard。非法值拒绝保存。

### 任务 2: 写入与 spawn

- [x] **第 1 步: 合并写入测试**

说明：保存 sandbox 不得丢掉 `[mcp_servers.*]`、`[memory]`、`[plugins] enabled`。

- [x] **第 2 步: Adapter argv**

说明：`off` 不加旗标（保持今日默认）。其它档位插入已验证位置。测试断言完整 argv 数组，不要 substring 匹配。

- [x] **第 3 步: 空闲重启**

说明：复用模型切换那套「等主进程确认」。执行中返回明确错误码。UI 在确认前不得显示新档位为已应用。

### 任务 3: 设置文案与走查

- [x] **第 1 步: 四档说明**

说明：workspace = 日常（可写 CWD）；read-only = 以读为主；strict = 更窄读；off = 无 Grok 内核限制。每档注明 Broker 仍然在。

- [x] **第 2 步: 开发版走查**

说明：off 启动无 `--sandbox`；切 workspace 空闲重启后新进程带旗标；执行中切换失败；故意填非法 profile 被拒。

自动证据（2026-09-04；未启动 Electron 开发版）：

- `off` → argv 全等 `GROK_PRODUCTION_AGENT_ARGV`：`src/main/runtime/grok/grok-acp-dialect.test.ts`「off 与 GROK_PRODUCTION_AGENT_ARGV 数组全等」
- `workspace` / `read-only` / `strict` → 完整 argv 含 `--sandbox` `<profile>` 在 `agent` 之前：同文件 `it.each`
- 执行中 set 失败、不写盘：`src/main/index.test.ts`「Agent status 为 busy|connecting 时拒绝改 sandbox，不写文件」
- 非法 profile 被拒、不进 argv：`grok-acp-dialect.test.ts`「非法 profile 抛错且不得产出 argv」；`grok-home-config-controller.test.ts` / `grok-config-merge.test.ts` 拒绝 `devbox`
- UI 未 applied 不得把 pending 档当成已应用：`src/renderer/src/grok-sandbox-settings.test.ts`、`src/renderer/src/composables/useGrokSandboxSettings.test.ts`
- 设置页文案与 hints：`src/renderer/src/grok-config-editor.test.ts`、`src/shared/grok-config-hints.test.ts`

开发版 GUI：未走查。本环境没有可用的 Chrome DevTools MCP，也未安全完成 off / workspace 空闲重启 / 执行中切换 / 非法档 四条手工路径。不得宣称「开发版 GUI 已过」。

## 验收标准

- [x] 只有空闲重启成功后 UI 才显示已应用档位。（代码 + 聚焦测试；GUI 未走查）
- [x] 非法 profile 不能进 argv。
- [x] 配置合并不破坏 MCP/记忆/插件表。
- [x] 自动验证已过；开发版 GUI 未走查（已记录）。
