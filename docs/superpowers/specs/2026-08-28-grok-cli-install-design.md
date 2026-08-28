# Grok Build CLI 探测与一键安装 设计

> 状态：待用户确认
> 日期：2026-08-28
> 计划：确认后由 writing-plans 拆独立实施计划；不插入正在走查的 P0-13 时间线

## 1. 目标

打开已配置供应商的项目时，若本机没有可执行的 Grok Build CLI，用户能看懂缺什么，并能在设置里完成官方安装，然后自动重试连接。

桌面仍然是 ACP Client，不自己当 Agent，也不把 CLI 打进 DMG / EXE。

## 2. 非目标

- 不把 `grok` 二进制打进安装包，也不在 CI 里预置。
- 不执行官方 `install.sh` / `install.ps1`（会改 shell rc、写用户 `~/.grok/config.toml`、装 completions）。
- 不修改用户 `~/.zshrc` / `~/.bashrc` / PATH、不写 `~/.grok/config.toml`、不读 `~/.grok/auth.json`。
- 不把 App `GROK_HOME` 指到 `~/.grok`。二进制在 `~/.grok/bin`，Runtime 配置仍在 `userData/grok-home`。
- 不通过 npm 全局安装 `@xai-official/grok`。
- 不让 Renderer 指定下载 URL、版本、渠道或目标目录。
- 不在打开设置或打开项目时静默下载。
- 不把「基础接口可调用」写成「已内置 Grok」。
- 本期不做 CLI 自动更新、alpha/enterprise 渠道、部署密钥、卸载入口。
- 本期不给插件页做独立安装向导；插件 spawn 共用同一套二进制解析。缺 CLI 时插件失败文案可指向设置，不复制第二套下载器。

## 3. 产品决策（已锁定）

- 不内置 CLI。
- 缺 CLI 时两个动作都要：**安装说明**（复制官方命令）和 **一键安装**（主进程从 x.ai 拉官方稳定版二进制）。
- 完整安装卡放在 **设置 → Grok 配置**，不要摊在对话流里。
- 对话区只留短提示 +「去设置安装」+「我已安装，重试」。
- 一键安装必须先确认。下载要有 **百分比**，不能只转圈。
- 安装位置固定为用户目录 `~/.grok/bin`（Windows 为 `%USERPROFILE%\.grok\bin\grok.exe`），与官方安装器默认目录一致。
- 现有 `resolveBinary` 只认无后缀 `grok`，Windows 打包后即使装了官方 CLI 也会 ENOENT；本期必须同时认 `grok.exe`。

## 4. 用户流程

```text
打开 Project（供应商已配置）
  → 主进程探测 CLI
  → 有 CLI：走现有 agent.connect
  → 无 CLI：不 spawn 假连接
        对话区短提示
        「去设置安装」→ 打开设置 Grok 配置
        「我已安装，重试」→ 再探测再连接
```

设置 → Grok 配置顶部的 CLI 卡片：

| 状态 | 展示 |
|---|---|
| 已安装 | 「Grok Build CLI 已安装」+ 版本号。不提供重新安装。 |
| 未安装 | 说明一句：桌面需要本机 `grok` 才能执行任务。按钮：**安装说明**、**一键安装**。 |
| 安装中 | 阶段文案 + 进度条百分比（下载阶段必须有数字）。禁止再点一键安装。 |
| 失败 | 脱敏错误 + 可再点一键安装或展开安装说明。 |
| 成功 | 更新为已安装；若当前 Project 可连接，自动 `agent.connect`。 |

**安装说明**展开当前平台官方命令，可一键复制，不执行：

- macOS / Linux：`curl -fsSL https://x.ai/cli/install.sh | bash`
- Windows：`irm https://x.ai/cli/install.ps1 | iex`

**一键安装确认**在卡片内完成：先点「一键安装」，卡片改成确认句 +「确认下载」「取消」。不用系统 `window.confirm`。确认句必须写明：将从 x.ai 下载官方 Grok Build CLI 到用户目录的 `.grok/bin`；不会改 shell 配置，也不会写用户 `~/.grok/config.toml`。

关闭设置时若 CLI 已变为已安装且当前 Project 尚未连接，同样自动重试连接。不得打断正在跑的 Task。

## 5. 数据流

唯一路径：

```text
Renderer
  → window.app.getGrokCliStatus() / installGrokCli({ confirm: true })
  → Preload 静态 channel
  → 主进程 IPC（校验主窗口）
  → GrokCliProbe / GrokCliInstaller
  → HTTPS + ~/.grok/bin
```

进度：

```text
主进程下载回调
  → app:grok-cli-install-progress
  → Preload 订阅
  → 设置页进度条
```

返回 Renderer 的数据不得包含绝对路径、家目录、完整 URL query、Header 或原始异常堆栈。

```ts
interface GrokCliStatus {
  installed: boolean
  version: string | null
  platform: 'macos' | 'windows' | 'linux'
}

type GrokCliInstallPhase =
  | 'fetching-version'
  | 'downloading'
  | 'verifying'
  | 'installing'

interface GrokCliInstallProgress {
  phase: GrokCliInstallPhase
  /** 仅 downloading 且服务端有 Content-Length 时为 0–100；其它阶段为 null。 */
  percent: number | null
  /** 给进度条旁的短句，例如「正在下载 42%」。 */
  message: string
}
```

IPC（沿用现有 `app:` 中性前缀，与 `app:get-grok-config` 同类）：

- `app:get-grok-cli-status`
- `app:install-grok-cli`（请求体只能是 `{ confirm: true }`，缺 confirm 拒绝）
- push：`app:grok-cli-install-progress`

Renderer 不得传 URL、version、channel、dest。

## 6. 二进制探测

抽公共函数，供 Adapter、plugin CLI、探测 IPC 共用，禁止再复制一份 `~/.grok/bin/grok`。

查找顺序：

1. `~/.grok/bin/grok`（POSIX）
2. `~/.grok/bin/grok.exe`（Windows，或 POSIX 路径不存在时）
3. 构造环境 `PATH = ~/.grok/bin + 原 PATH`，解析 `grok` / `grok.exe`

「已安装」判定：候选路径存在、是普通文件、对当前用户可执行。版本用受控 `spawn(binary, ['--version'])`：超时短、环境白名单、不注入模型 Key、stdout 截断脱敏。`--version` 失败仍可把 `installed: true` 且 `version: null`，但一键安装校验失败必须视为未装完并回滚。

打开 Project 时 **先探测再 connect**。缺二进制不要落到「无法启动 Grok Build：spawn ENOENT」这种通用句。connect 若仍 ENOENT，归类为缺 CLI，走同一套对话短提示。

## 7. 一键安装（主进程）

模块：`src/main/runtime/grok/grok-cli-installer.ts`。`index.ts` 只注册 IPC。

单飞：已有安装在进行则拒绝第二次。

步骤：

1. 确认 `{ confirm: true }`。
2. 解析平台以 Electron 的 `process.platform` / `process.arch` 为准（不做官方脚本里的 Rosetta `sysctl` 探测）：
   - `darwin` + `arm64` → `macos-aarch64`
   - `darwin` + `x64` → `macos-x86_64`
   - `win32` + `x64` → `windows-x86_64`
   - `linux` + `x64` → `linux-x86_64`
   - `linux` + `arm64` → `linux-aarch64`
   - 其它组合失败关闭：「当前系统没有官方 Grok Build 构建。」
3. HTTPS GET `https://x.ai/cli/stable`，响应必须是 `X.Y.Z` 或 `X.Y.Z-suffix`，体积上限 64 字节。版本指针失败再 GET GCS 的 `.../cli/stable`。
4. 产物 URL 只允许下面两个 host，先 x.ai 后 GCS：
   - `https://x.ai/cli/grok-{version}-{platform}[.exe]`
   - `https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-{version}-{platform}[.exe]`
5. 下载到 `~/.grok/downloads/` 临时文件，原子 rename。体积上限 512 MiB。用 `Content-Length` 推百分比；没有长度则 `percent: null`，`message` 仍为「正在下载」。
6. POSIX：`chmod 755`，`spawn --version` 成功后再把 `~/.grok/bin/grok`（及 `agent`）链到该文件。Windows：写入 `grok.exe`，并复制一份 `agent.exe`（官方安装器同款）。
7. 目录尽量 `0700`，二进制 `0755`（Windows 忽略 mode）。
8. 校验失败删除临时文件，保留旧二进制。

禁止：

- HTTP、重定向到 HTTP、URL 内嵌用户名密码、query/hash 带 secret。
- 跟随到白名单外的 host。
- 把 `AGENT_STUDIO_MODEL_API_KEY` 或其它模型 Key 注入下载/校验环境。
- 改全局 `process.env`。
- 写用户 `config.toml`、shell rc、completions。

网络/写盘错误返回有限码：`cli-missing`、`cli-unsupported-platform`、`cli-download-failed`、`cli-verify-failed`、`cli-install-busy`。文案脱敏，不带回家目录路径。

## 8. UI

保持现有深色工作台变量，不另起一套颜色。所有图标按钮要有 `title` / `aria-label`。进度条尊重 `prefers-reduced-motion`（减少闪烁，百分比数字仍要在）。

**对话区**（扩展现有 connect-failure，不新增页眉主按钮）：

- 缺 CLI：`还没有安装 Grok Build CLI。` 按钮「去设置安装」「我已安装，重试」。
- 其它连接失败：维持现在的短错误 +「重试」，不要冒充缺 CLI。

「去设置安装」复用已有 `openSettingsSection('grok-config')`。

**设置 → Grok 配置**：在 `config.toml` 编辑器 **上方** 增加 CLI 卡片，不和 TOML 混写。已安装时卡片收成一行状态，不挡编辑。安装中 TOML 仍可看，一键安装按钮禁用。

小窗口也必须能看到安装按钮和进度；快捷键提示可藏，安装卡不能藏。

## 9. 文件范围

| 路径 | 职责 |
|---|---|
| `src/main/runtime/grok/grok-cli-binary.ts` | 解析 `~/.grok/bin` 与 PATH 上的 `grok` / `grok.exe` |
| `src/main/runtime/grok/grok-cli-installer.ts` | 版本探测、HTTPS 下载、校验、原子安装、进度回调 |
| `src/main/runtime/grok/grok-acp-adapter.ts` | `resolveBinary()` 改走公共解析 |
| `src/main/index.ts` | 注册 `app:get-grok-cli-status` / `app:install-grok-cli`，组装不写下载细节 |
| `src/main/runtime/grok/grok-plugin-cli.ts` | 共用二进制解析，PATH 前置 `~/.grok/bin` 时包含 `.exe` |
| `src/shared/app-ipc.ts` | channel、Status、Progress、`{ confirm: true }` |
| `src/preload/desktop-api.ts`、`index.d.ts` | 窄 API + 进度订阅清理函数 |
| `src/renderer/src/components/GrokConfigEditor.vue` | 顶部 CLI 卡片、确认、进度、复制命令 |
| `src/renderer/src/components/TaskConversation.vue`、`task-conversation-view.ts`、`App.vue` | 缺 CLI 短提示与跳转设置 |
| `*.test.ts` 就近 | 见第 10 节 |
| `README.md` | 环境要求补一句：可在设置里安装官方 CLI；安装包仍不内置 |

不新增 `grok:*` IPC。不把下载逻辑放进 Renderer 或 `src/shared`。

## 10. 测试

自动化（假二进制 + mock HTTPS，禁止真实 Key / 真实付费通道）：

- 探测：缺文件、POSIX `grok`、Windows `grok.exe`、PATH 回落。
- 安装请求：无 `confirm` 拒绝；Renderer 无法传 URL。
- URL：拒绝 HTTP、userinfo、白名单外 host；允许 x.ai 与官方 GCS。
- 版本串非法 / 超大响应失败关闭。
- 下载 404、超时、超 512 MiB。
- 校验 `--version` 失败时保留旧文件。
- 进度：有 `Content-Length` 时 percent 单调 0–100；无长度时 percent 为 null。
- 错误不含家目录、不含 Header。
- Adapter / plugin CLI 解析到同一 Windows `.exe`。
- Preload 进度订阅卸载时移除监听。

手工（开发版，与自动验证分开写）：

- macOS：卸掉/改名 `~/.grok/bin/grok` 后打开项目 → 对话短提示 → 设置里一键安装出百分比 → 自动连上。
- 复制官方命令，不执行应用内下载，装完点「我已安装，重试」。
- Windows：确认认 `grok.exe`，安装卡命令是 `irm`。
- 安装中切走设置再回来，进度仍在；不得开第二条下载。
- 任务执行中不得因探测失败去抢连接。

## 11. 安全与产品边界复核

- `contextIsolation` / `sandbox` 不变；不把 `ipcRenderer` 或通用 download 交给 Renderer。
- 官方脚本会改用户家目录配置；我们故意只写下二进制，避免桌面变成 Grok 安装器全家桶。
- README 继续写明：本项目不是 xAI 官方产品；CLI 来自 x.ai。
- 用户仍需在应用内配置模型供应商。装 CLI ≠ 配好 Provider。
