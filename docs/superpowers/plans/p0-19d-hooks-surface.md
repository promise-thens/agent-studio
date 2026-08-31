# P0-19d Grok Hooks 只读表面 实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
>
> **状态：** 待开始。
>
> **插入点：** [P0-19](p0-19-grok-host-capability-polish.md) 在回退之后。扫描范围仅 App `GROK_HOME`，对标 P0-10C 插件库存的 realpath 约束。

**优先级：** P0-A / 权重 3（让用户知道 Grok 会在何时跑钩子；桌面不执行钩子）

**Goal：** 在设置「Grok 配置」或插件页提供 Hooks 列表：事件名、启用与否、目标类型（命令 / HTTP）、有限说明。用户改钩子仍用文件 + Grok，不在桌面提供任意命令编辑器。

**Architecture：** 主进程扫描 `getManagedGrokHome()/hooks` 与 Grok 文档允许的 hooks 注册文件（若 App grok-home 存在）。跟随 symlink 逃出 grok-home 的整项 `invalid`。Renderer 只拿脱敏摘要。不 spawn 钩子，不把 hooks 命令注入 ACP。

**Tech Stack：** 现有 grok-home 扫描模式（`grok-plugin-inventory.ts`）、设置页。

**Spec：** [P0-19](p0-19-grok-host-capability-polish.md)；Grok `10-hooks.md`。

## Global Constraints

- 沿用 P0-19。
- 不读 `~/.grok/hooks`，除非未来另立「junction」产品决定；本计划不做。
- 摘要禁止返回：完整 command 字符串、env、headers、绝对路径原文、文件原文。
- 条数、单文件字节、目录深度设上限，与插件扫描同级保守。

---

## 非目标

- 不做 Hooks 可视化编辑器、市场、远程 URL 安装。
- 不在 Timeline 为每次 Hook 打一条协议事件（Grok 未必上报）；本计划只提供库存。
- 不把 Hook 失败重做成桌面通知中心。

## 数据流

```text
设置打开 Hooks 段
  → app:list-hooks
  → 主进程 realpath 扫描 grok-home/hooks
  → { id, event, enabled, targetKind: 'command' | 'http' | 'invalid', warning? }
  → 空目录显示「尚未在 App Grok 主目录配置 Hooks；TUI 家里的 ~/.grok/hooks 不会自动出现」
```

## 安全边界

- IPC channel 静态；仅当前主窗口。
- HTTP 目标只展示 origin 级 host，不展示 query/hash。
- command 目标只展示「本地命令（已隐藏原文）」，让用户去 grok-home 文件查看。
- invalid 项可见但不可「启用」。

## 文件范围

- 创建：`src/main/runtime/grok/grok-hooks-inventory.ts` 及测试
- 创建：`src/shared` 脱敏 DTO
- 修改：preload 窄 API、设置 Grok 配置栏
- 测试：symlink 逃逸、超大文件、HTTP 含 query 被剥掉、命令原文不进 DTO

### 任务 1: 扫描器

- [ ] **第 1 步: 对照 Grok 文件布局**

说明：在隔离 grok-home 放一个最小 hook JSON（无 Secret），确认路径是 `hooks/*.json` 还是其它。按实物写解析，不按记忆猜 schema。未知字段丢弃。

- [ ] **第 2 步: 脱敏测试**

说明：command 含 `curl ... token=sk-test` 不得出现在 DTO；http URL `https://example.com/hook?key=1` 只留 `https://example.com`。

### 任务 2: UI

- [ ] **第 1 步: 只读列表**

说明：事件名、启用、目标类型、invalid 原因。空态说明隔离边界。所有图标有 title。

- [ ] **第 2 步: 走查**

说明：无 hooks 时空态；放一个 http hook 只见 origin；symlink 到 grok-home 外显示 invalid。

## 验收标准

- [ ] Renderer 与日志都看不到钩子命令原文和 query Secret。
- [ ] 逃逸路径不能被当成已启用。
- [ ] 桌面进程不会因为打开设置页而执行钩子。
- [ ] 自动验证 + 开发版走查。
