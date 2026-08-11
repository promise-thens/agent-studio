# P2-03 Codex 操作与核心服务映射 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P2 / 权重 5（第二 Runtime 的高副作用适配）

**目标：** 把 Codex app-server 的命令、文件变更、Diff、审批、Usage 和 Artifact 映射到已经完成的核心 Permission、Command Evidence、Git Review、Timeline 与 Artifact 服务，不为 Codex 复制第二套工作台能力。

**核心数据流：** Codex Adapter 将 app-server item/approval 转为中性 OperationIntent 和 AgentEvent；Permission Broker 决策后把结果映射回 Codex；已执行命令的真实字段映射为 P0-11 `CommandExecutionEvidence`/`CommandTranscriptRef` 并进入 Timeline，文件变化进入 Git Review，Diff/Usage/Artifact 进入既有 Task 结果入口。

**约束与边界：** 不允许 Codex 已上报的审批请求绕过 Broker 或直接写 Renderer 状态；不复制 Command Evidence、Diff Viewer、Artifact Registry 或 Task 历史。P0-15 用户交互终端不是 Codex 命令执行器，也不是本计划依赖。协议字段仅存在于 `runtime/codex`，能力无法等价映射时明确标记 experimental/unsupported。

**主要风险：** Codex 原生审批范围、命令生命周期和 Diff 语义可能与核心模型不等价；以更严格的本地策略为准，无法安全表达的长期授权降级为单次审批，无法归因的变化标记 unknown。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Codex app-server 当期官方协议。

---

## 实施范围

**前置依赖：**

- 协议映射、审批往返和命令证据可以在 P0-A、P0-11、P2-02 完成后开始。
- Artifact 注册步骤依赖 P0-13；Worktree execution root、结果交付和最终端到端完成门依赖 P0-14。
- P0-13/P0-14 未完成时，只能验收 Local 下的协议映射切片，不得把 P2-03 整体标记完成。

**文件范围：**
- 创建 `src/main/runtime/codex/codex-operation-mapper.ts`、`codex-item-mapper.ts` 及就近测试。
- 修改 Codex Adapter、Permission Broker 调用、CommandEvidenceStore/Timeline 引用、Git Review/Artifact 接入。
- 不新增 Codex 专属 Renderer 审阅组件，除非官方协议存在无法用通用语义表达且用户必须看见的事实。

**安全策略：**
- Codex 原始命令、环境、路径和错误先校验、脱敏、限长，再进入通用服务。
- 删除、强制 Git、敏感网络外发、execution root 外路径、登录态、屏幕和剪贴板遵守 P0-07 高风险逐次确认。
- 无法证明可撤销的 Codex 操作不得标记为可撤销。

### 任务 1: 冻结 Codex 协议与能力映射表

**任务目标：**
- 基于当期官方 schema 和本机受控实测，明确每种 Codex item 的通用落点。

**涉及范围：**
- 协议 fixture、能力矩阵、映射文档和测试。

**前置依赖：**
- P2-02 已建立 Thread/Turn/Item 基础适配。

- [ ] **第 1 步: 枚举真实 item 与审批类型**
说明：覆盖命令开始/输出/结束、文件变更、Diff、plan、reasoning、message、approval、usage、error 和 turn terminal；记录版本和实测证据。
预期：不根据旧截图或名称猜测协议，不存在未分类却默认成功的 item。

- [ ] **第 2 步: 建立通用服务映射矩阵**
说明：逐项标明 AgentEvent、OperationIntent、CommandExecutionEvidence/CommandTranscriptRef、TaskChangeSet、ArtifactDescriptor 或 unsupported；说明字段损失和成熟度。
预期：每项只有一个事实所有者，Codex Adapter 不重复存储或渲染相同结果。

- [ ] **第 3 步: 更新能力矩阵**
说明：将 native/simulated/experimental/unsupported 和最近验证时间写入 Runtime capability snapshot。
预期：Renderer 能诚实展示 Codex 能力差异，不为界面统一伪造支持。

### 任务 2: 接入审批与命令证据

**任务目标：**
- 让 Codex 命令遵守既有 Task、环境、权限和证据边界。

**涉及范围：**
- operation mapper、Permission Broker、CommandEvidenceStore/Timeline 和测试。

**前置依赖：**
- 依赖任务 1 的映射矩阵。

- [ ] **第 1 步: 转换 OperationIntent**
说明：将命令、写文件、删除、网络和 Git 操作映射为具体目标、影响和风险；未知操作按高风险处理。
预期：Codex 无法仅凭原生“已批准”状态绕过 Agent Studio 的 Task/Project/environment 范围。

- [ ] **第 2 步: 完成审批往返**
说明：处理允许、拒绝、取消、超时、重复请求、Turn 已结束和 app-server 退出；结果精确关联原始审批 ID。
预期：任一路径都不会卡住 Task 或把授权复用到其它 Turn/Worktree。

- [ ] **第 3 步: 映射命令执行证据**
说明：只从已验证 app-server schema 提取 command、cwd、started/ended、exitCode、signal、timeout、output/reference 等事实，生成 source=`runtime-tool` 的 CommandExecutionEvidence；未知或缺失字段保持 unknown，输出使用 P0-11 的有界 transcript store。
预期：用户可在统一 Timeline/Command Evidence 查看 Codex 命令，不出现第二套日志面板，也不会把 Runtime 上报命令描述为 AppCommandRunner 沙箱执行。

### 任务 3: 接入文件、Diff、Usage 与 Artifact

**任务目标：**
- 让 Codex 产物进入现有 Changes 和 Artifacts 入口。

**涉及范围：**
- item mapper、Git Review、Artifact Registry、ResultReview 和测试。

**前置依赖：**

- 依赖任务 2 的 Task/Turn 关联。
- 文件变化与 Local Diff 可先接 P0-12；注册 Artifact 必须等待 P0-13，验证 Worktree 路径与交付必须等待 P0-14。

- [ ] **第 1 步: 映射文件变化与 Diff**
说明：Codex 原生 Diff 作为证据输入，但最终归因仍由 P0-12 基线和当前文件状态确认；不一致时显示协议结果与本地结果差异。
预期：已有脏改动不会因为 Codex 声明而被错误归为本 Task 修改。

- [ ] **第 2 步: 映射 Usage 与验证**
说明：Token/费用/耗时进入 Timeline/ResultReview，官方未提供或无法验证的费用字段显示未确认；ValidationResult 只引用 P0-11 已保存的 commandId、真实退出码和超时状态。
预期：结果摘要来自真实协议字段和本地执行事实，不从消息文本推断。

- [ ] **第 3 步: 注册可审阅 Artifact**
说明：Codex 产生的文件引用经过 execution root、类型、大小和 trust 校验后进入 Artifact Registry。
预期：Codex 无法用 item 路径让 Renderer 任意读盘或绕过 HTML 隔离。

### 任务 4: 完成跨服务回归

**任务目标：**
- 证明第二 Runtime 接入没有复制或破坏核心工作台。

**涉及范围：**
- 协议 fixture、单元/集成测试和 Electron 走查。

**前置依赖：**

- 依赖任务 1 至任务 3，并以 P0-13、P0-14 均可用作为本计划最终完成门。

- [ ] **第 1 步: 覆盖主流程与失败路径**
说明：测试命令成功/失败/取消/字段缺失、文件写入、删除拒绝、网络审批、Diff 不一致、Usage 缺失和 app-server 崩溃。
预期：每条路径都进入既有 Task Timeline、Command Evidence、Changes 和 Artifacts。

- [ ] **第 2 步: 验证不可绕过和无重复 UI**
说明：检查所有 Codex 已上报审批均有 Broker 决策，Renderer 无 Codex 专属文件读取、命令 transcript 或权限后门；Runtime 未上报便自行执行的边界准确标注。
预期：通用核心服务仍是唯一事实源，文档不把 Broker 夸大为 Runtime 进程沙箱。

- [ ] **第 3 步: 记录实际兼容结论**
说明：用本地或受控账号完成真实 Codex Task，记录支持、限制和协议版本；不以基础连接成功替代 Agent 工作流验证。
预期：README/能力矩阵只声明实测通过的范围。

## 验收标准

- [ ] Codex 命令、审批、文件变化、Diff、Usage 和 Artifact 全部映射到既有核心服务，没有复制第二套 Task 历史、Command Evidence、Diff 或 Viewer。
- [ ] Codex 已上报审批请求经过 Permission Broker，并绑定正确 Task、Turn 和 Execution Environment；未上报副作用不被伪称已由 Broker 强制拦截。
- [ ] Codex 原生 Diff 与本地 Git 基线不一致时诚实展示差异，不覆盖用户已有修改或伪造可撤销。
- [ ] 协议未知/缺失能力明确标记 experimental/unsupported，基础连接不被描述为完整支持。
- [ ] P0-13/P0-14 完成前只记录 Local 映射进度；Artifact 与 Worktree 端到端走查通过后才将 P2-03 标记完成。
- [ ] 目标 ESLint、相关 Vitest/集成测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成真实 Codex 操作映射走查。
