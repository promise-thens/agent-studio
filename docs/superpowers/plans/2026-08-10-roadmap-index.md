# Agent Studio 分阶段功能路线索引

> 状态：规划基线（2026-08-10）
>
> 本索引只负责开发顺序、权重、依赖和进度导航；每一个实际功能只在对应独立 Markdown 中定义任务。产品愿景仍以 [product-vision.md](../../product-vision.md) 为唯一愿景来源。

## 使用规则

- **顺序优先于按钮数量：** 前置依赖未完成，不开始后续功能主体。
- **权重 5：** 阻塞性基础能力或安全边界；权重 4：核心闭环；权重 3：增强能力；权重 2：有足够真实数据后再做的优化。
- **安全不是过度安全：** 只读项目元信息允许任务范围授权；写文件/执行命令展示影响；删除、外发数据、登录态、屏幕和剪贴板始终明确确认。不会做自研加密、逐文件弹窗、默认全盘扫描或未有生态就先做插件市场。
- **状态说明：** 本轮只建立计划。P1 前五项已有实现提交 `fe2a81a`，但仍列为“实现待复核”，不得把它们当作完全验收。

## P0：统一核心骨架

| 顺序 | 权重 | 功能 | 状态 | 前置依赖 |
|---|---:|---|---|---|
| 01 | 5 | [统一 Agent 领域契约](2026-08-10-p0-01-agent-domain-contract.md) | 已完成 | — |
| 02 | 5 | [Agent 事件归一化](2026-08-10-p0-02-agent-event-normalization.md) | 已完成 | P0-01 |
| 03 | 4 | [Runtime 能力矩阵](2026-08-10-p0-03-runtime-capability-matrix.md) | 待开始 | P0-01、P0-02 |
| 04 | 5 | [中性 Agent IPC 边界](2026-08-10-p0-04-agent-ipc-boundary.md) | 待开始 | P0-01 |
| 05 | 5 | [Grok ACP Adapter 迁移](2026-08-10-p0-05-grok-acp-adapter-migration.md) | 待开始 | P0-01 至 P0-04 |
| 06 | 4 | [任务与会话历史](2026-08-10-p0-06-task-session-history.md) | 待开始 | P0-01、P0-02、P0-05 |
| 07 | 4 | [执行时间线与结果审阅](2026-08-10-p0-07-execution-timeline-review.md) | 待开始 | P0-02、P0-03、P0-06 |
| 08 | 5 | [统一权限 Broker](2026-08-10-p0-08-core-permission-broker.md) | 待开始 | P0-01、P0-02、P0-04 |

## P1：开放模型配置

| 顺序 | 权重 | 功能 | 状态 | 前置依赖 |
|---|---:|---|---|---|
| 01 | 5 | [Provider 输入与 URL 校验](2026-08-10-p1-01-provider-input-validation.md) | 实现待复核 | 当前基线 |
| 02 | 5 | [Provider 凭据安全存储](2026-08-10-p1-02-provider-credential-storage.md) | 实现待复核 | P1-01 |
| 03 | 4 | [Provider 模型发现与连通验证](2026-08-10-p1-03-provider-model-discovery.md) | 实现待复核 | P1-01、P1-02 |
| 04 | 4 | [Provider 首次引导与设置](2026-08-10-p1-04-provider-onboarding-and-settings.md) | 实现待复核 | P1-01 至 P1-03 |
| 05 | 5 | [Grok Provider Runtime 绑定](2026-08-10-p1-05-grok-provider-runtime-binding.md) | 实现待复核 | P0-05、P1-01 至 P1-03 |
| 06 | 4 | [多 Provider Profile 管理](2026-08-10-p1-06-provider-profile-management.md) | 待开始 | P1-01 至 P1-05 |
| 07 | 4 | [Provider 协议 Profile](2026-08-10-p1-07-provider-protocol-profiles.md) | 待开始 | P1-06 |
| 08 | 4 | [模型兼容性体检](2026-08-10-p1-08-model-compatibility-health-check.md) | 待开始 | P1-03、P1-07 |

## P2：接入 Codex app-server

| 顺序 | 权重 | 功能 | 状态 | 前置依赖 |
|---|---:|---|---|---|
| 01 | 5 | [Codex 认证与生命周期](2026-08-10-p2-01-codex-runtime-auth-and-lifecycle.md) | 待开始 | P0、P1-07 |
| 02 | 5 | [Codex Thread 与 Turn 适配](2026-08-10-p2-02-codex-thread-turn-adapter.md) | 待开始 | P2-01、P0 |
| 03 | 5 | [Codex 命令、Diff 与审批](2026-08-10-p2-03-codex-command-diff-approval.md) | 待开始 | P0-08、P2-02 |
| 04 | 4 | [跨 Runtime 任务工作台](2026-08-10-p2-04-cross-runtime-task-workbench.md) | 待开始 | P0、P1、P2-01 至 P2-03 |

## P3：插件能力中心

| 顺序 | 权重 | 功能 | 状态 | 前置依赖 |
|---|---:|---|---|---|
| 01 | 4 | [Capability Pack Manifest](2026-08-10-p3-01-capability-pack-manifest.md) | 待开始 | P0 |
| 02 | 5 | [Capability 权限与本地审计](2026-08-10-p3-02-capability-permission-and-audit.md) | 待开始 | P0-08、P3-01 |
| 03 | 4 | [项目体检与 Git 审阅](2026-08-10-p3-03-project-health-and-git-review.md) | 待开始 | P0-07、P0-08、P3-01 |
| 04 | 4 | [MCP 与 Skills Host](2026-08-10-p3-04-mcp-and-skills-host.md) | 待开始 | P3-01、P3-02 |
| 05 | 3 | [应用内受管浏览器](2026-08-10-p3-05-managed-browser.md) | 待开始 | P3-01、P3-02、P3-04 |
| 06 | 3 | [Chrome Native Bridge](2026-08-10-p3-06-chrome-native-bridge.md) | 待开始 | P3-02、P3-05 |
| 07 | 3 | [macOS Computer Use Helper](2026-08-10-p3-07-macos-computer-use-helper.md) | 待开始 | P3-02、产品确认 macOS 范围 |

## P4：多大脑协作

| 顺序 | 权重 | 功能 | 状态 | 前置依赖 |
|---|---:|---|---|---|
| 01 | 4 | [隔离 Git Worktree](2026-08-10-p4-01-isolated-git-worktree.md) | 待开始 | P3-03、P0-08 |
| 02 | 3 | [双 Runtime 对比](2026-08-10-p4-02-dual-runtime-comparison.md) | 待开始 | P2-04、P4-01 |
| 03 | 3 | [Runtime 接力](2026-08-10-p4-03-runtime-handoff.md) | 待开始 | P2-04、P0-06、P4-01 |
| 04 | 2 | [Runtime 路由与评估](2026-08-10-p4-04-runtime-routing-and-evaluation.md) | 待开始 | P4-02、P4-03 与足够本地历史 |

## 历史文档

- [2026-08-07-model-provider-onboarding.md](2026-08-07-model-provider-onboarding.md) 保留为提交 `fe2a81a` 对应的历史总计划；新的实施、复核和状态更新以本索引下的 P1 独立文档为准。
