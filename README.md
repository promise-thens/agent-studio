# Agent Studio

一个基于 Electron、Vue 3 和 Agent Client Protocol 构建的本地 AI 工作台。当前以 Grok Build 作为首个接入的 Agent Runtime，未来将支持多 Agent Runtime、开放模型配置和可扩展桌面能力。

> 本项目不是 xAI 官方产品，也不代表 xAI。当前使用 Grok Build Runtime 前，需要先安装并登录 Grok Build CLI。

完整产品愿景见 [docs/product-vision.md](docs/product-vision.md)。

## 当前能力（Grok Build Runtime）

- 首次启动配置 OpenAI Chat Completions 兼容服务的 Base URL、认证信息和 Model ID
- 通过 `/models` 获取真实模型名称，并在输入框左下角安全切换模型
- 使用 Electron `safeStorage` 加密保存 API Key，重启后无需重复输入
- 支持 HTTP 和 HTTPS Provider；HTTP 配置会持续显示明文传输风险提示
- 选择本地工作目录并启动 Grok Build ACP 会话
- 接收流式回复、思考信息、计划和工具调用状态
- 发送任务与停止当前执行
- 在桌面端处理 Grok Build 权限确认
- 使用隔离的 Electron preload 和窄 IPC 边界保护渲染进程

## 环境要求

- Node.js 20 或更高版本
- pnpm 10
- 已安装 Grok Build CLI，并可通过 `grok` 命令启动

安装 Grok Build：

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

## 本地开发

```bash
pnpm install
pnpm dev
```

## 验证与构建

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm build:mac
```

## 技术结构

```text
src/main/grok-agent.ts   Grok Build 子进程与 ACP 会话
src/main/provider        Provider 校验、连接、存储与 Grok 配置生成
src/main/security        凭据与错误信息脱敏
src/main/index.ts        Electron 窗口、服务组装与 IPC 注册
src/preload/index.ts     安全的渲染层桥接
src/renderer             Vue 3 桌面界面
src/shared               主进程与渲染层共享类型
```

## 安全说明

- 渲染进程不直接获得 Node.js、Shell 或文件系统权限。
- 已保存的 API Key 不返回渲染进程，并使用系统安全存储加密落盘。
- HTTP Provider 不具备传输加密，请仅连接可信服务并优先使用低权限、可轮换的 Key。
- Grok Build 的敏感操作通过 ACP 权限请求交给用户确认。
- 本项目仍处于早期阶段，请在重要仓库中先检查 Grok Build 的权限和沙箱配置。

## License

[MIT License](LICENSE)
