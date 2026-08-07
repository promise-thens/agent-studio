# Grok Build Desktop

一个基于 Electron、Vue 3 和 Agent Client Protocol 的 Grok Build 社区桌面客户端。

> 本项目不是 xAI 官方产品，也不代表 xAI。使用前需要先安装并登录 Grok Build CLI。

## 当前能力

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
pnpm typecheck
pnpm build
pnpm build:mac
```

## 技术结构

```text
src/main/grok-agent.ts   Grok Build 子进程与 ACP 会话
src/main/index.ts        Electron 窗口与 IPC 注册
src/preload/index.ts     安全的渲染层桥接
src/renderer             Vue 3 桌面界面
src/shared               主进程与渲染层共享类型
```

## 安全说明

- 渲染进程不直接获得 Node.js、Shell 或文件系统权限。
- Grok Build 的敏感操作通过 ACP 权限请求交给用户确认。
- 本项目仍处于早期阶段，请在重要仓库中先检查 Grok Build 的权限和沙箱配置。

## License

[MIT License](LICENSE)
