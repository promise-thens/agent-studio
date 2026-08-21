# Agent Studio 分阶段功能路线索引

> 状态：P0-01 至 P0-07 已完成代码、自动验证与 Electron 验收；P0-08 核心实现、完整自动门禁和首批受控 lifecycle Electron E2E 已完成，真机与跨平台验收待补；P0-09 真机验收已受限关闭；GACP-01 已于 2026-08-19 受限关闭；GACP-02 核心已落地；P0-10B 代码已落地。P0-10C 代码已落地、自动验证已过（GUI 未跑）；库存扫描已补上 `installed-plugins`。P0-10D 代码已落地、相关自动测试已过（开发版 GUI / TUI 对读未跑）。P0-10E 代码已落地、自动验证已过（开发版 GUI / 安装走查未跑）。下一步见 P0-11。Grok ACP 加深计划见 [grokACP计划](grokACP计划/README.md)
>
> 本索引只负责开发顺序、权重、依赖和进度导航；每一个实际功能只在对应独立 Markdown 中定义任务。产品愿景仍以 [product-vision.md](../../product-vision.md) 为唯一愿景来源。
>
> **2026-08-20 产品确认：** 桌面是 Grok Build 的 ACP Client，不自己当 Agent。MCP / Skills / 记忆 / 插件由 Grok 执行，工作台负责可视化与配置。P2 Codex 与 P4 多大脑暂缓，计划文件保留。

## 使用规则

- **顺序优先于按钮数量：** 前置依赖未完成，不开始后续功能主体。
- **权重 5：** 阻塞性基础能力或安全边界；权重 4：核心闭环；权重 3：增强能力；权重 2：有足够真实数据后再做的优化。
- **三个验收层：** P0-A 是本地可用闭环；P0-B 是隔离交付闭环；P0+ 是不阻塞第一可用版本的增强能力。后续计划应依赖明确验收层或具体计划，不再使用含义模糊的“依赖整个 P0”。
- **安全不是过度安全：** 只读项目元信息允许任务范围授权；写文件/执行命令展示影响；删除、外发数据、登录态、屏幕和剪贴板始终明确确认。不会做自研加密、逐文件弹窗、默认全盘扫描或未有生态就先做插件市场。
- **状态说明：** P0-01 至 P0-07 已完成代码、自动验证和 Electron 验收；P0-06 已通过真实 Provider 调用、多轮、重启恢复成功/失败、不可用 Project、异常中断、取消、损坏隔离和物理删除走查。P0-07 已通过完整自动门禁、主要真实 Grok 权限路径与受控 ACP Runtime Electron E2E；后者使用固定本地 fixture 验证完整 Electron/stdio ACP 管线，不等价于真实 Grok 黑盒触发，也不把 Broker 描述为 Runtime 进程沙箱。P0-08 已完成核心实现、Permission E2E 和首批 lifecycle E2E，Windows/Linux 生命周期平台差异仍待验收；真实 Grok 活动退出与重启 interrupted 已由 2026-08-18 Windows 夜间补测在 Grok 路径上收口。P0-09 真机验收已受限关闭：同一 Task 两轮实时/历史一致，权限允许/拒绝、终态、退出三分支已有结论；Windows 窗口销毁/重建与历史截断保持限制。GACP-01 已于 2026-08-19 受限关闭（握手、`set_model`、A→B→A `resume`、一次 `execute` 权限已冻结；load/close/子 Agent/退出协议路径保持 `not-observed`，不挡后续开工）。GACP-02 核心已落地。P0-10 Task 1–4 与 P0-10B 已有代码。P0-10C 代码已落地、自动验证已过（GUI 未跑）；库存已按真机 `installed-plugins` 修正。P0-10D 代码已落地（相关自动测试已过，GUI / TUI 对读未跑）。P0-10E 代码已落地、自动验证已过（开发版 GUI / 安装走查未跑）。下一步 P0-11。P1 前五项已有实现提交 `fe2a81a`，但仍列为“实现待复核”。
- **产品主线：** 先把 Grok Build 打磨成可日常使用的单 Runtime 工作台（宿主可视化：斜杠命令、记忆、MCP、插件），再扩展 Provider 宽度。Codex Runtime 与多大脑协作暂缓。HTML 预览是 Artifact 的隔离扩展，不是产品本体。

## P0：统一核心骨架与 Codex-style 单 Runtime 工作台

### 已完成开发基础

| 计划  | 权重 | 功能                                                   | 状态   | 前置依赖       |
| ----- | ---: | ------------------------------------------------------ | ------ | -------------- |
| P0-01 |    5 | [统一 Agent 领域契约](p0-01-agent-domain-contract.md)  | 已完成 | —              |
| P0-02 |    5 | [Agent 事件归一化](p0-02-agent-event-normalization.md) | 已完成 | P0-01          |
| P0-03 |    4 | [Runtime 能力矩阵](p0-03-runtime-capability-matrix.md) | 已完成 | P0-01、P0-02   |
| P0-04 |    5 | [中性 Agent IPC 边界](p0-04-agent-ipc-boundary.md)     | 已完成 | P0-01 至 P0-03 |

### P0-A：本地可用闭环

推荐严格按下表顺序实施。P0-09 有意放在 P0-07、P0-08 之后，因为真实时间线需要消费权限历史与主进程执行状态，而不是先做一层将来必然返工的 UI 投影。P0-09 测试门与 GACP-01 均已受限关闭。下一步是 GACP-02 恢复契约，再开始 P0-10，避免工作台把“继续任务”建立在未核实的 handshake 声明上。GACP-01 遗留不得再挡住 GACP-02。详细理由见 [grokACP计划/README.md](grokACP计划/README.md)。

| 开发顺序 | 计划    | 权重 | 功能                                                                                         | 状态                               | 前置依赖                                 |
| -------: | ------- | ---: | -------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------- |
|        1 | P0-05   |    5 | [Grok ACP Adapter 与任务编排边界](p0-05-grok-acp-adapter-migration.md)                       | 已完成                             | P0-01 至 P0-04                           |
|        2 | P0-06   |    5 | [Project、Task、Turn 与历史恢复](p0-06-task-session-history.md)                              | 已完成                             | P0-01、P0-02、P0-05                      |
|        3 | P0-07   |    5 | [核心权限 Broker](p0-07-core-permission-broker.md)                                           | 已完成                             | P0-04、P0-05、P0-06                      |
|        4 | P0-08   |    5 | [Task Executor 与后台生命周期](p0-08-task-executor-background-lifecycle.md)                  | 核心与首批 E2E 完成，真机/平台待补 | P0-05、P0-06、P0-07                      |
|        5 | P0-09   |    4 | [执行时间线与结果审阅](p0-09-execution-timeline-review.md)                                   | 真机验收已受限关闭                 | P0-02、P0-03、P0-06、P0-07、P0-08        |
|       5a | GACP-01 |    5 | [真机 Grok ACP 协议观察与能力核实](grokACP计划/gacp-01-real-grok-protocol-verification.md)   | 已完成（2026-08-19 受限关闭）      | P0-09 测试门                             |
|       5b | GACP-02 |    5 | [会话恢复能力产品契约](grokACP计划/gacp-02-session-restore-capability-contract.md)           | 核心已落地，待手工/e2e 收口        | GACP-01                                  |
|       5c | P0-10A  |    5 | [Claude Desktop 风格工作台大修](p0-10a-claude-desktop-workbench-ui.md)                       | 助手 Markdown 已接入；换皮待开始   | P0-09 测试门；与 GACP-02/06 对齐皮肤     |
|       5d | P0-10B  |    3 | [设置弹窗与外观](p0-10b-settings-dialog-and-appearance.md)                                   | 代码已落地；开发版走查待做         | P0-10A 视觉 token；与 P1-04 设置入口衔接 |
|       5e | P0-10C  |    4 | [Grok 宿主工作台表面](p0-10c-grok-host-surfaces.md)                                         | 代码已落地；自动验证已过（GUI 未跑）；库存已补 installed-plugins | P0-10B；P0-10 工作台壳                   |
|       5f | P0-10D  |    4 | [Grok 记忆与 MCP 设置](p0-10d-grok-memory-and-mcp.md)                                       | 代码已落地；自动测试已过（GUI / TUI 对读未跑） | P0-10C                                   |
|       5g | P0-10E  |    4 | [Grok 插件安装与信任](p0-10e-grok-plugin-install-and-trust.md)                               | 代码已落地；自动验证已过（GUI 未跑） | P0-10D（config.toml 必须合并写入）       |
|        6 | P0-10   |    5 | [单 Runtime 任务工作台](p0-10-single-runtime-task-workbench.md)                              | Task 1–4 已合入功能分支；开发版手工与 lifecycle e2e 未在本分支实跑 | P0-06、P0-08、P0-09、P0-10A、GACP-02     |
|        7 | P0-11   |    5 | [Command Runner 与执行证据](p0-11-command-execution-evidence.md)                             | 待开始                             | P0-06、P0-07、P0-08、P0-10               |
|       7a | GACP-03 |    4 | [结构化权限证据](grokACP计划/gacp-03-structured-permission-evidence.md)                     | 待开始                             | P0-11、GACP-01                           |
|        8 | P0-12   |    5 | [项目 Git 基线与变更审阅](p0-12-project-git-change-review.md)                                | 待开始                             | P0-06、P0-07、P0-08、P0-10、P0-11        |
|       8a | GACP-04 |    4 | [Grok ACP 方言兼容契约](grokACP计划/gacp-04-grok-acp-dialect-compat.md)                     | 待开始                             | P0-10、GACP-01；可与 P0-12 并行，P2 前完成 |

#### P0-A 验收门

必须使用 **真实 Grok Runtime**（不是受控 ACP fixture）完成：注册 Local Project → Task A 第一轮 → 新建 Task B → 切回 Task A 继续原生上下文 → 执行中切换页面但任务不中断 → 审阅实时/历史一致的 Timeline、Permission、Command Evidence、Diff 与 Validation → 停止、失败、应用重启后状态均准确。其中“继续原生上下文”以 GACP-01 观察和 GACP-02 契约为准，不得把 handshake `declared` 写成已验证恢复。P0-05 完成后还必须在新 AgentService/Adapter 边界上复核 P1-01 至 P1-05，确认 Provider origin、凭据、Runtime 配置和工具子进程 Secret 隔离没有回归；GACP-04 的方言契约应在 P0-A 收口或最迟 P2 前完成。不要求 P1-06 至 P1-08、也不要求 GACP-05 才能通过本门。

### P0-B：隔离交付闭环

| 开发顺序 | 计划  | 权重 | 功能                                                                            | 状态   | 前置依赖    |
| -------: | ----- | ---: | ------------------------------------------------------------------------------- | ------ | ----------- |
|        1 | P0-13 |    4 | [基础 Task Artifact Registry 与 Viewer](p0-13-task-artifact-registry-viewer.md) | 待开始 | P0-A        |
|        2 | P0-14 |    5 | [隔离 Task Worktree 与结果交付](p0-14-isolated-task-worktree.md)                | 待开始 | P0-A、P0-13 |

#### P0-B 验收门

必须验证同一真实任务可以选择 Local 或受管 Worktree；Worktree 中的 Runtime、Git Review 和 Artifact 都只使用绑定的 execution root，原工作区保持不变。任务结束后用户可以审阅基础 Artifact，导出包含 tracked/untracked 修改和 base commit manifest 的结果包，或在 Finder/终端打开受管 Worktree；系统不得自动应用回原项目、合并、提交或推送。P0-B 通过后，才将首个 Codex-style 单 Runtime 桌面交付闭环标为完成；终端与并行调度继续由 P0+ 独立验收。

### P0+：非首版阻塞增强

这些计划不共同阻塞 P0-A/P0-B；只有明确需要相应能力的后续计划才依赖它们。

| 推荐顺序 | 计划  | 权重 | 功能                                                       | 状态   | 前置依赖                   |
| -------: | ----- | ---: | ---------------------------------------------------------- | ------ | -------------------------- |
|        1 | P0-15 |    3 | [Task 用户交互终端](p0-15-integrated-task-terminal.md)     | 待开始 | P0-11、P0-14               |
|        2 | P0-16 |    4 | [隔离 HTML Preview](p0-16-isolated-html-preview.md)        | 待开始 | P0-13、P0-14               |
|        3 | P0-17 |    4 | [多任务队列与有界并行调度](p0-17-multi-task-scheduling.md) | 待开始 | P0-08、P0-10、P0-11、P0-14 |
|        4 | GACP-05 |    3 | [Client 能力广告](grokACP计划/gacp-05-client-capability-advertisement.md) | 待开始 | P0-15 且产品确认；默认不进 P0-A |

## Grok ACP 加深

本系列补的是现有 `GrokAcpAdapter` 的真机核实、恢复语义、审批可读性和方言契约，不是第二条 Runtime，也不替代 P0-10 / P0-11 / P0-15 / P3-04。完整评估与切分见 [grokACP计划/README.md](grokACP计划/README.md)。

| 计划 | 权重 | 功能 | 状态 | 插入点 |
| --- | ---: | --- | --- | --- |
| [GACP-01](grokACP计划/gacp-01-real-grok-protocol-verification.md) | 5 | 真机协议观察与能力核实 | 已完成（受限关闭） | 2026-08-19 冻结观察；遗留不挡 GACP-02 |
| [GACP-02](grokACP计划/gacp-02-session-restore-capability-contract.md) | 5 | 点进历史即可接着聊 | 核心已落地，待手工/e2e 收口 | GACP-01 已关闭；P0-10 前 |
| [GACP-03](grokACP计划/gacp-03-structured-permission-evidence.md) | 4 | 能过的自动过，不要一个个点 | 待开始 | P0-11 后 |
| [GACP-04](grokACP计划/gacp-04-grok-acp-dialect-compat.md) | 4 | Grok ACP 方言兼容契约 | 待开始 | P0-10 后、P2 前 |
| [GACP-05](grokACP计划/gacp-05-client-capability-advertisement.md) | 3 | Client 能力广告 | 待开始 | P0-15 后；未实现不得广告 |
| [GACP-06](grokACP计划/gacp-06-subagent-timeline.md) | 3 | 子 Agent 嵌套时间线 | 待开始 | P0-10A 换皮之后接分组；GACP-01 未见父子字段，禁止猜树 |

当前 `clientCapabilities: {}` 是诚实状态。GACP-05 之前禁止打开 `fs` / `terminal`。P0-08 尚未完成的 Windows/Linux 生命周期仍留在 P0-08；GACP-01 不再回填这些平台项。

## P1：开放模型配置

P1-01 至 P1-05 是现有单 Provider 基线的复核和补强，应在 P0-05 后穿插完成并最迟纳入 P0-A 验收；P1-06 至 P1-08 的 Provider 宽度扩展不得阻塞 P0-A/P0-B。

| 顺序 | 权重 | 功能                                                                    | 状态       | 前置依赖              |
| ---- | ---: | ----------------------------------------------------------------------- | ---------- | --------------------- |
| 01   |    5 | [Provider 输入与 URL 校验](p1-01-provider-input-validation.md)          | 实现待复核 | 当前基线              |
| 02   |    5 | [Provider 凭据安全存储](p1-02-provider-credential-storage.md)           | 实现待复核 | P1-01                 |
| 03   |    4 | [Provider 模型发现与连通验证](p1-03-provider-model-discovery.md)        | 实现待复核 | P1-01、P1-02          |
| 04   |    4 | [Provider 首次引导与设置](p1-04-provider-onboarding-and-settings.md)    | 实现待复核 | P1-01 至 P1-03        |
| 05   |    5 | [Grok Provider Runtime 绑定](p1-05-grok-provider-runtime-binding.md)    | 实现待复核 | P0-05、P1-01 至 P1-03 |
| 06   |    4 | [多 Provider Profile 管理](p1-06-provider-profile-management.md)        | 待开始     | P1-01 至 P1-05        |
| 07   |    4 | [Provider 协议 Profile 与兼容契约](p1-07-provider-protocol-profiles.md) | 待开始     | P1-06                 |
| 08   |    4 | [模型兼容性体检](p1-08-model-compatibility-health-check.md)             | 待开始     | P1-03、P1-07          |

## P2：接入 Codex app-server（暂缓）

> 2026-08-20：先打磨 Grok 宿主。本系列计划文件保留，不删，不作为下一阶段开工项。Grok 日用闭环（P0-10C/D/E、P0-11、GACP-03、P0-12）完成前不要开始 P2-01。

P2-01、P2-02 先完成 account-backed Codex 的独立状态、账号、Thread/Turn 和恢复边界，不依赖 P1-07；P2-03 可在 P0-A 后先做协议/审批/命令映射，但以 P0-13/P0-14 作为 Artifact/Worktree 最终完成门。P2-04A 先交付单执行槽的 Runtime 选择，P2-04B 再接 P0-17 队列与并行。

| 顺序 | 权重 | 功能                                                                             | 状态   | 前置依赖                                                         |
| ---- | ---: | -------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| 01   |    5 | [Codex 认证、状态隔离与生命周期](p2-01-codex-runtime-auth-and-lifecycle.md)      | 待开始 | P0-A                                                             |
| 02   |    5 | [Codex Thread、Turn 与原生恢复适配](p2-02-codex-thread-turn-adapter.md)          | 待开始 | P0-A、P2-01                                                      |
| 03   |    5 | [Codex 操作与核心服务映射](p2-03-codex-command-diff-approval.md)                 | 待开始 | 启动：P0-A、P0-11、P2-02；完成门：P0-13、P0-14                   |
| 04A  |    4 | [单执行槽跨 Runtime 选择与任务启动](p2-04a-cross-runtime-task-workbench.md)      | 待开始 | P0-B、P2-01 至 P2-03；Codex `app-provider` 另依赖 P1-06 至 P1-08 |
| 04B  |    4 | [跨 Runtime Scheduler 与并行整合](p2-04b-cross-runtime-scheduler-integration.md) | 待开始 | P0-17、P2-04A                                                    |

## P3：插件能力中心

P3 统一沿用 `Manifest / ActionDescriptor → Registry → Executor → Permission Broker → 核心事实服务`，Capability 不直接调用 Runtime，也不复制 Timeline、Command Evidence、Changes、Validation 或 Artifact。P3-03 只提供项目体检这一首个内置 Capability，不重新定义通用 Action 契约。

| 顺序 | 权重 | 功能                                                                             | 状态   | 前置依赖                   |
| ---- | ---: | -------------------------------------------------------------------------------- | ------ | -------------------------- |
| 01   |    4 | [Capability Manifest、Action 契约与 Registry](p3-01-capability-pack-manifest.md) | 待开始 | P0-A                       |
| 02   |    5 | [Capability 执行、权限与审计扩展](p3-02-capability-permission-and-audit.md)      | 待开始 | P0-A、P3-01                |
| 03   |    3 | [高级项目体检与自动化入口](p3-03-project-health-and-git-review.md)               | 待开始 | P0-A、P3-01、P3-02         |
| 04   |    4 | [MCP 与 Skills Host](p3-04-mcp-and-skills-host.md)                               | 待开始 | P3-01、P3-02；Grok 的 `mcpServers` 注入已由 P0-10D 负责，本计划不抢 |
| 05   |    3 | [应用内受管浏览器](p3-05-managed-browser.md)                                     | 待开始 | P3-01、P3-02、P3-04        |
| 06   |    3 | [Chrome Native Bridge](p3-06-chrome-native-bridge.md)                            | 待开始 | P3-02、P3-05               |
| 07   |    3 | [macOS Computer Use Helper](p3-07-macos-computer-use-helper.md)                  | 待开始 | P3-02、产品确认 macOS 范围 |

## P4：多大脑协作（暂缓，依赖 P2）

| 顺序 | 权重 | 功能                                                               | 状态   | 前置依赖                    |
| ---- | ---: | ------------------------------------------------------------------ | ------ | --------------------------- |
| 01   |    4 | [多 Runtime Worktree 与子任务编排](p4-01-isolated-git-worktree.md) | 待开始 | P0-B、P2-04B                |
| 02   |    3 | [双 Runtime 公平对比](p4-02-dual-runtime-comparison.md)            | 待开始 | P4-01                       |
| 03   |    3 | [Runtime 有界接力](p4-03-runtime-handoff.md)                       | 待开始 | P0-B、P2-04A、P4-01         |
| 04   |    2 | [Runtime 路由与评估](p4-04-runtime-routing-and-evaluation.md)      | 待开始 | P4-02、P4-03 与足够本地历史 |

## 历史文档

- [provider-onboarding-history.md](provider-onboarding-history.md) 保留为提交 `fe2a81a` 对应的历史总计划；新的实施、复核和状态更新以本索引下的 P1 独立文档为准。
- [grokACP计划/README.md](grokACP计划/README.md) 是 Grok ACP 加深系列的评估与插入顺序；实施以 GACP-01 至 GACP-05 为准。
