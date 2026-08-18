# P0-09 真实 Grok 真机测试计划

> **致测试执行者：** 本计划用于补齐真实 Grok Build Runtime 的黑盒验收，不替代受控 ACP fixture 的自动化测试。每个场景完成后都必须填写实际结果、脱敏证据和结论；未执行的项目保持未勾选，不得以代码已合并或受控 E2E 通过代替真机结论。

**关联实施计划：** [P0-09 执行时间线与结果审阅](../plans/p0-09-execution-timeline-review.md)  
**目标：** 验证真实 Grok Runtime 中，实时 Timeline、TaskResultReview、Task/Project 切换、Renderer reload、窗口重建和历史回放能基于相同的公开事实正确表达执行过程与最终状态。  
**非目标：** 本计划不验证 Git Diff 引擎、Command Evidence、Artifact 读取、Terminal 模拟器或 OS 级进程沙箱；这些能力尚未实现时，界面显示“未提供/未验证”是正确的降级行为。  
**建议平台：** 先完成 macOS；Windows/Linux 分别单独记录，不能用 macOS 结果代替。  
**预计时长：** 首次完整走查约 90–150 分钟；每个退出分支都必须使用独立的可丢弃 Task。

---

## 1. 通过标准与证据边界

P0-09 只有在下列条件均满足时，才能在实施计划和 roadmap 中标记为真机验收完成：

- [ ] 所有标记为“必测”的场景都有 `通过`、`失败` 或 `受限通过` 结论；不能留下未说明的空项。
- [ ] 每项“通过”都有脱敏截图或录屏时间戳，以及可复现的操作记录。
- [ ] 实时执行与重新打开历史后的 Turn 顺序、终态、权限审计、错误和结果审阅事实一致。
- [ ] 缺少 Diff、Validation、Artifact 或 Terminal 能力时，UI 明确说明未提供或未验证，而不是暗示成功。
- [ ] 未发生 Task/Turn 跨流、自动审批、自动重放 Prompt、凭据泄露或对真实项目的意外写入。
- [ ] 最终工作区的自动化门禁已重新执行并记录结果。

### 1.1 自动化与真机证据的区别

已通过的受控 Electron E2E 只能证明固定、本地、隔离的 ACP fixture 路径，包含持久化 Tool、权限审计、终态与历史 Timeline 回放；它**不能**证明真实 Grok 的黑盒行为、真实权限触发、网络环境或 OS 子进程树完全相同。

真实测试也不能证明强制退出一定停止所有尚未上报的外部副作用。强制退出后只能依据持久化 Task/Turn 状态记录为 `interrupted` 或其他可信终态，不能根据窗口消失推断 Runtime 或外部进程已停止。

---

## 2. 测试环境、隔离与安全边界

### 2.1 环境记录（每次测试填写）

| 字段 | 实际值 |
| --- | --- |
| 日期与本地时区 | `待填写` |
| 执行者 | `待填写` |
| OS 与版本 | `待填写` |
| Agent Studio commit / 构建版本 | `待填写` |
| Node / pnpm | `待填写` |
| Grok Build 版本 | `待填写` |
| Provider endpoint 协议（HTTP/HTTPS） | `待填写` |
| 使用的 modelId（仅 modelId） | `待填写` |
| 测试结果汇总 | `待填写` |

### 2.2 创建隔离 fixture

- [ ] 使用新的、可丢弃的本地 Git 仓库；禁止使用生产仓库、客户代码、包含凭据的目录或个人主目录。
- [ ] 在 fixture 中仅放入假数据，例如 `README.md`、`notes.txt` 和一个小型无敏感内容的源文件。
- [ ] 记录初始 `git rev-parse HEAD` 与 `git status --short`；初始状态必须干净。
- [ ] 准备两个不同的 fixture Project：**Project A** 和 **Project B**；Project B 用于验证查看身份切换，不需要执行任务。
- [ ] 在 Agent Studio 中注册两个 Project，确认完整路径只在本地 UI 内使用；文档、截图和录屏只出现项目显示名或相对路径。
- [ ] 确认 Grok Build 已在其自身安全登录流程内可用。不得截图、复制或记录 API Key、Authorization、Cookie、环境变量、Header、原始 Runtime payload、完整 stderr 或堆栈。
- [ ] 若 Provider 使用 HTTP，确认页面持续显示传输未加密风险；验收记录只写“HTTP 风险提示已见”，绝不写入认证信息。

### 2.3 允许的真机动作

优先选择低影响、可逆的任务：读取 fixture 中指定文件、总结内容、生成计划、写入一个新建的测试文本文件、或请求确认后再报告。禁止作为常规验收动作：删除文件、网络外发、登录操作、访问真实账号、读取剪贴板、屏幕捕获、写入真实项目或安装依赖。

---

## 3. 执行前门禁

> 先完成本节，失败时停止真机测试并先修复自动化问题。

- [x] 在最终工作区运行 Node 与 pnpm 版本检查，Node 必须为 20+，pnpm 必须为项目声明的 10.x。
- [x] 运行 `pnpm exec eslint . --no-cache` 并记录结果。
- [x] 运行 `pnpm test` 并记录测试文件数与测试数。
- [x] 运行 `pnpm typecheck`、`pnpm build` 和 `git diff --check` 并记录结果。
- [x] 运行 `pnpm test:permission:e2e`，确认受控 Timeline 历史回放 E2E 仍通过。
- [x] 启动开发版或本次构建的应用；确认产品名称为 Agent Studio，Runtime 身份和模型显示分离，且模型标签为实际 `displayName ?? modelId`。
- [ ] 配置 Provider 后确认页面只显示“已保存”，不会回填明文 Key。

**门禁证据：** 2026-08-18 macOS：Node `v22.22.0`、pnpm `10.33.0`；`pnpm exec eslint . --no-cache` 通过；`pnpm test` 为 45 files / 437 tests 通过；`pnpm typecheck`、`pnpm build`、`git diff --check` 通过；`pnpm test:permission:e2e` 5/5 通过；`pnpm test:lifecycle:e2e` 5/5 通过。开发版 UI 显示 Agent Studio、Grok Build 已连接和独立的 `grok-4.6` modelId。未进入设置页，Key 不回填项未验证。2026-08-18 Windows 复测：Node `v24.11.0`、pnpm `10.33.0`；相关 Vitest `task-timeline-reducer` + `useTaskTimeline` 共 13 项通过；开发版基于 `2a786f7` 加上 `startTurn` 后 `acceptAdmission` 修复。
**门禁结论：** `自动化基线仍以 2026-08-18 macOS 全量门禁为准。2026-08-18 夜间 Windows 补测后，P0-09 真机验收按受限关闭：同一 Task 第二轮、权限允许一次、reload、终态、退出三分支已有结论；Windows 窗口销毁/重建与安全历史截断保持平台/安全限制。`

---

## 4. 场景记录模板

每个下列场景都复制并填写本模板；“实际结果”不得仅写“正常”。

| 字段 | 内容 |
| --- | --- |
| 场景 ID / 名称 | `RG-09-xx` |
| 是否必测 | 是 / 否 |
| Project / Task | 仅记录显示名或安全 DTO 的局部标识 |
| 前置状态 | Task/Turn 数、当前执行状态、Git 初始状态 |
| 操作步骤 | 实际执行的点击、输入、切换、确认或退出选择 |
| 预期结果 | 引用本计划的对应断言 |
| 实际结果 | 状态序列、用户可见文本、是否自动连接/审批/重放 |
| 证据 | 脱敏截图文件名、录屏时间戳、有限状态摘要、`git diff --stat` |
| 结论 | 通过 / 失败 / 受限通过 / 未验证 |
| 异常与限制 | 任何差异、平台限制或未验证项目 |
| 清理 | fixture 是否恢复 clean、是否遗留测试文件 |

---

## 5. RG-09-01：同一 Task 的多轮 Timeline 与结果审阅（必测）

**目的：** 验证实时事件和历史回放以 Turn 为边界归并；结果审阅只显示实际观察到的事实。

### 操作步骤

1. [x] 选中 Project A，创建 **Task A**。记录 Task 初始无 Turn 的状态截图。
2. [x] 发送第一轮低风险 Prompt，例如：`阅读 README.md，列出三条要点。先给出计划，再给出结论；不要修改文件。`
3. [x] 在执行期间记录 Timeline：用户 Prompt、当前状态、Runtime 实际提供的 Plan/Tool/消息/Reasoning/完成节点。没有提供的节点不作为失败。
4. [x] 等待可信终态；记录是 `completed`、`failed`、`cancelled` 还是 `interrupted`，不要根据聊天文案推断成功。
5. [x] 记录 TaskResultReview：状态、Usage（若提供）、修改路径数（若提供）、验证/Artifact 的“未提供/未接入”说明，以及任何 warnings。
6. [x] 在同一 Task 发送第二轮 Prompt，例如：`基于刚才的结论，用两句话说明下一步建议；不要修改文件。`
7. [x] 确认第二轮创建新的 Turn，而第一轮的节点和终态不被覆盖或串入第二轮。
8. [x] 从侧栏切到其他 Task 后再打开 Task A，进入只读历史；逐轮核对 Prompt、节点顺序、终态、错误和结果审阅与实时状态一致。
9. [x] 记录最终 `git status --short`；只读任务不应产生未预期变更。

### 通过判定

- [x] 两轮分别显示，顺序正确，没有交叉节点。
- [x] 终态来自真实执行事实；不把运行中的 UI 文案作为完成证据。
- [x] 历史回放与实时展示一致。
- [x] Usage/Diff/Validation/Artifact 缺失时明确降级，不展示空白成功状态。

---

## 6. RG-09-02：权限等待、允许与拒绝/取消（必测，分两次独立运行）

**目的：** 验证 `waiting-permission`、权限绑定、审计事实和终态不会被错误描述。

### A. 允许一次

1. [x] 新建 **Task Permission-Allow**，发送只会作用于 fixture 的可逆 Prompt，例如请求在 `scratch/allowed.txt` 写入固定文本，并明确要求在操作前请求确认。
2. [x] 权限弹窗出现后，记录操作摘要、关联 Task/Turn、风险级别、当前 Timeline 状态和执行快照状态。
3. [x] 确认等待期间，操作尚未在 fixture 中发生；不得提前把它记为成功。
4. [x] 点击“仅允许这一次”。
5. [x] 等待可信终态；检查 Timeline 与历史审计中出现对应的 `user-allowed` 事实。
6. [x] 仅检查预期写入路径，记录内容摘要与 `git status --short`；不要读取无关文件。

### B. 拒绝或停止

1. [ ] 新建 **Task Permission-Deny**，发送相同风险等级、但目标为另一个专用 fixture 路径的 Prompt。
2. [ ] 等待权限弹窗与 `waiting-permission`。
3. [ ] 点击“拒绝”或“停止”，记录实际选择。
4. [ ] 等待终态。拒绝审批不等于 Turn 必然 `cancelled`：必须记录 Runtime 实际返回的终态。
5. [ ] 在历史回放中检查 `user-denied` 或 `cancelled` 审计事实，以及结果审阅警告。
6. [ ] 确认被拒绝目标路径没有写入；若存在写入，立即记录阻塞失败。

### 通过判定

- [x] 等待状态、弹窗与审计都绑定正确 Task/Turn。
- [x] 允许和拒绝都不自动发生；操作结果与审计原因一致。
- [x] 不把“拒绝”误写为“成功”或“已取消”。

---

## 7. RG-09-03：Task 与 Project 切换（必测）

**目的：** 验证查看身份与执行身份分离，后台 A 不污染 B。

1. [ ] 创建 **Task A**，发起一个足够持续但低风险的任务；优先让其在请求权限前先分步报告，或在 `waiting-permission` 停留。
2. [ ] 在 A 处于 `running` 或 `waiting-permission` 时，记录当前 Task/Turn/状态与 Stop 入口标题。
3. [ ] 创建或打开 **Task B**，仅查看历史，不发送新 Prompt。
4. [ ] 确认页面显示只读历史或 B 的实际状态；A 的 Stop 入口仍明确指向 A，A 的事件、权限和结果不显示为 B 的内容。
5. [ ] 切换到 Project B，确认 A 仍显示为后台执行，且没有因为浏览 B 自动取消、重连或创建第二个执行槽。
6. [ ] 回到 Project A 与 Task A，确认仍是原执行身份，且没有重复 Prompt、重复 Turn 或重新创建 Runtime session 的用户可见迹象。
7. [ ] 让 A 按安全方式终态收束，记录最终状态。

### 通过判定

- [ ] A/B Timeline、权限、错误和结果审阅不串流。
- [ ] Task 切换与 Project 切换不改变 A 的执行身份。
- [ ] 执行期间不能违规发起第二个执行、切模型或执行破坏性 Provider mutation。

---

## 8. RG-09-04：Renderer reload 与窗口销毁/重建（必测）

**目的：** 验证 Renderer 重建后依赖 Main execution snapshot 和持久化历史恢复，而不是自动重放用户输入。

### A. Running 状态 reload

1. [ ] 使用新的 Task 发起低风险长任务，等待 `running`。
2. [ ] 记录 Task/Turn、状态和 Stop 入口。
3. [ ] 刷新 Renderer。
4. [ ] 确认刷新后：执行没有因页面刷新而停止；状态恢复；Stop 仍指向原执行；没有自动再次发送 Prompt。
5. [ ] 完成后打开历史，核对 Timeline 与结果审阅。

### B. Waiting-permission 状态 reload

1. [ ] 使用新的 Task 触发低影响权限请求，等待 `waiting-permission`。
2. [ ] 在不作允许/拒绝的情况下刷新 Renderer。
3. [ ] 记录弹窗是否恢复、状态是否恢复、是否存在安全的待处理说明。
4. [ ] 当前没有 pending approval 查询协议；若弹窗没有恢复，必须标记为限制或失败，绝不可通过自行允许来掩盖问题。
5. [ ] 使用明确、安全的方式收束该任务，并记录审计和终态。

### C. BrowserWindow 销毁/重建

1. [ ] 使用独立长任务，在 `running` 或 `waiting-permission` 时关闭窗口。
2. [ ] 通过 macOS Dock 或正常应用激活路径重新打开窗口。
3. [ ] 核对后台执行身份、Timeline/状态、Stop 入口与历史回放。
4. [ ] 如果应用退出而非仅销毁窗口，按 RG-09-08 记录，不能把两种行为混写。

---

## 9. RG-09-05：成功、失败、取消与 Runtime 断开（必测）

**目的：** 验证终态在 Timeline 与结果审阅中的语义正确且可回放。

### 正常成功

- [ ] 使用只读任务获得真实 `completed`，检查 completion 节点、状态徽标、结果审阅与历史一致。

### 用户取消

1. [ ] 创建独立长任务，确认已进入执行。
2. [ ] 点击 Stop 一次；不要重复点击制造竞态。
3. [ ] 记录是否出现 `cancelling`，再等待可信终态。
4. [ ] 终态可能是 `cancelled`、`completed`、`failed` 或超时 `interrupted`；必须按实际记录。
5. [ ] 打开历史确认没有将取消前未完成的操作显示为已验证结果。

### Runtime 失败/断开

1. [ ] 仅在可控测试环境中模拟或触发 Runtime 断开；不得通过破坏用户全局 Grok 配置实现。
2. [ ] 记录错误节点、状态、是否可恢复以及结果审阅 warning。
3. [ ] 重新打开历史，确认状态不倒退为运行中，也不自动重放 Prompt。

### 通过判定

- [ ] `completed`、`failed`、`cancelled`、`interrupted` 的用户可见表现明确区分。
- [ ] 终态后晚到内容不被伪装为新的成功事实。
- [ ] 历史与实时的最终结论相同。

---

## 10. RG-09-06：长任务与高频输出可用性（必测）

**目的：** 验证流式事件批处理、折叠展示和操作入口在真实 Runtime 下可用。

1. [ ] 发送不会写文件、但能生成较多分步文本的 Prompt，例如要求分阶段分析 fixture 中两份短文本并在每阶段简短报告。
2. [ ] 在流式期间检查输入区、Stop 按钮、滚动和状态文本均可见且可操作。
3. [ ] 检查 Reasoning 默认折叠；完成 Tool 详情不应淹没当前状态。
4. [ ] 观察 Timeline 是否持续更新且终态、权限、错误没有因批处理而丢失。
5. [ ] 记录实际事件规模的可见描述，例如“约 N 个消息片段”；不得记录原始敏感内容。
6. [ ] 完成后重新打开历史，确认正文、终态和结果审阅没有明显重复或缺失。

**通过判定：** 不以主观“很流畅”代替事实；必须同时证明 Stop、状态和最终历史回放仍可用。

---

## 11. RG-09-07：历史截断与能力降级（必测降级；截断可受限）

### A. 未实现能力降级

1. [ ] 完成至少一轮真实任务后检查结果审阅。
2. [ ] 若 Runtime 没有提供 Usage、Diff、Validation、Artifact 或 Terminal 引用，逐项确认 UI 显示“本轮未提供”“能力尚未接入”或等价明确原因。
3. [ ] 确认 Timeline 不提供任意文件读取、patch 正文、终端输出或 Artifact 内容入口。
4. [ ] 任何绿色成功、空白成功块或从聊天文字推断“验证已通过”的表现都记录为阻塞失败。

### B. 历史截断（仅在可安全、可控触发时执行）

1. [ ] 不要通过真实无限输出或资源耗尽来触发截断。
2. [ ] 若已有安全的受控真机方式产生达到历史上限的 Turn，执行并检查 Timeline 显示“部分执行历史因容量限制不可用”。
3. [ ] 重开历史确认不会把无法回放的正文伪装为完整。
4. [ ] 若本版本没有安全触发手段，将本小节标记为 `未验证`，而不是通过。

---

## 12. RG-09-08：退出三分支与重启回放（必测）

> 每个分支使用新的独立长任务，避免一个分支的终态影响另一个分支。

### A. 继续等待

1. [ ] 活动任务运行时发起应用退出。
2. [ ] 选择“继续等待”。
3. [ ] 验证应用没有退出，任务继续，未发生不可逆 shutdown。
4. [ ] 记录最终可信终态。

### B. 取消任务并退出

1. [ ] 活动任务运行时发起退出，选择“取消任务并退出”。
2. [ ] 记录 `cancelling` 是否出现；等待 Runtime 事实收束，不因点击取消提前宣布取消成功。
3. [ ] 记录 app 是否退出。
4. [ ] 重启后打开该 Task，确认 Task/Turn 已是可信终态，且不自动重放 Prompt。

### C. 强制退出

1. [ ] 使用可丢弃任务发起退出，选择“强制退出”。
2. [ ] 检查 UI 风险提示表达存在无法确认的外部副作用。
3. [ ] 重启后打开原 Task；检查未完成 Turn 是否收束为 `interrupted`，没有残留伪运行状态或自动重放。
4. [ ] 用 `git status --short` 和 `git diff --stat` 检查 fixture 预期路径。即使没有改动，也不能把它当成 Runtime/外部进程绝对停止的证明。

---

## 13. 汇总、失败处理与清理

### 13.1 场景汇总

| 场景 | 必测 | 结论 | 证据位置 | 关联验收标准 | 备注 |
| --- | --- | --- | --- | --- | --- |
| RG-09-01 多轮 Timeline | 是 | **通过** | 2026-08-18 Windows 开发版 + 夜间补测：隔离 fixture `pA`；实时/历史对照截图；持久化 Task `dc35087a` 两轮均为 `completed` | 实时/历史一致 | 同一 Task 第一轮只读 README，第二轮基于结论给建议。两轮 Prompt、节点和终态分开，历史回放 Prompt 与实时一致。结果审阅 Usage/Diff/Validation/Artifact 均为“本轮未提供”。只读任务 fixture `git status` 干净。 |
| RG-09-02 权限 | 是 | **通过** | 拒绝：2026-08-18 真实 Grok L1 写入；允许：同日夜间 `execute-command` L3 | 等待/审计正确 | 拒绝分支仍成立。允许一次：弹窗为 `waiting-permission`，操作 `execute-command`、风险 L3，用户点“仅允许这一次”后审计 `user-allowed`/`once`，Turn `completed`，fixture 新增 `scratch/p009-allow.txt`（内容为约定标记）。真实 Grok 未走 `write-file` L1，而是命令执行。 |
| RG-09-03 Task/Project 切换 | 是 | 受限通过 | 2026-08-18 白天 + 夜间：A 运行中切空 Task/Project B | 不跨流 | 空 Task/Project B 未显示 A 的结果审阅或权限审计。夜间补测切回 A 时仍是同一 `executionId`。长任务很快结束，未能稳定证明持续后台执行；待决权限仍是强制模态。 |
| RG-09-04 reload/窗口重建 | 是 | 受限通过 | 2026-08-18 夜间 Windows 开发版 | 恢复一致 | running reload：同一 `executionId` 保留，但 reload 期间任务已完成，Stop 不再可见。waiting-permission reload：execution 仍为 `waiting-permission`，同一 `executionId`；审批弹窗未恢复，符合当前没有 pending approval 查询协议的冻结契约。Windows 关闭最后窗口等于退出，不能当作 macOS Dock 窗口重建。 |
| RG-09-05 终态 | 是 | **通过** | 2026-08-18 夜间真实 Grok | 错误与终态可见 | 已见 `completed`、拒绝/停止后的 `cancelled`（`runtime-cancelled`）、以及杀掉 `grok agent --no-leader` 子进程后的 `failed`/`runtime-error`（状态芯片“连接异常”）。历史未倒退为运行中，也未自动重放 Prompt。 |
| RG-09-06 长任务 | 是 | 受限通过 | 2026-08-18 夜间分步分析 Prompt | 高频可交互 | 真实 Grok 很快完成，未形成长时间高频流。状态芯片与 Stop 在执行中可见；截获到的交互窗口偏短，不按“很流畅”记通过。 |
| RG-09-07 能力降级 | 是 | **通过**（截断未验证） | 2026-08-18 夜间只读两轮 Task 的结果审阅 | 不伪造成功 | Usage/Diff/Validation/Artifact 均明确“本轮未提供”或“尚未接入”，无空白成功。未使用不安全方式触发历史截断，截断小节保持未验证。 |
| RG-09-08 退出/重启 | 是 | **通过** | 2026-08-18 夜间独立长任务三分支 | interrupted 回放 | 继续等待：进程未退出，execution 仍 `running`。取消并退出后重启：Task/Turn 为 `cancelled`，不自动重放。强制退出后重启：Task/Turn 为 `interrupted`，没有变成 `completed`。原生 MessageBox 由测试夹具按按钮序号选择，已核对标题为“任务仍在执行”。 |

### 13.2 阻塞失败条件

出现以下任一情况，立刻停止该场景、保存脱敏证据并标记阻塞失败：

- Task A 的事件、审计、错误或结果出现在 Task B。
- 系统自动允许/拒绝用户未决权限，或刷新后无明确说明地改变权限结果。
- 同一 Prompt 被自动重放，或恢复过程创建了用户未触发的新 Turn。
- 未实现能力显示为成功，或 Timeline 读取任意文件、终端全文、Artifact 内容、patch 正文。
- 任一截图、日志或文档包含 Key、Authorization、Cookie、环境变量、Header、客户内容或未脱敏绝对路径。
- fixture 之外发生未预期写入、删除或网络外发。

### 13.3 清理

- [x] 对 Project A/B 分别执行 `git status --short` 与 `git diff --stat`，只保留计划中允许的 fixture 测试文件。
- [x] 删除或还原测试过程中创建的 `scratch/` 等专用路径；本次未创建写入路径。
- [x] 关闭已知开发版应用与测试 Runtime；`pnpm dev` 会话以退出码 130 结束，已确认其 Electron 进程退出。
- [ ] 将脱敏证据放入团队约定的受限位置；文档只记录链接/文件名，不嵌入 Secret。
- [x] 根据场景汇总更新 P0-09 实施计划、roadmap 和进度快照；有任何未验证或失败项时必须原样保留。

---

## 14. 本次执行记录

> 由实际真机执行者填写。未验证项保持未验证，不以受控 E2E 或局部真机结果替代。

- 自动化基线：2026-08-18，Node `v22.22.0`、pnpm `10.33.0`；ESLint、45 files / 437 Vitest tests、typecheck、build、diff check、受控 Permission E2E 5/5、受控 lifecycle E2E 5/5 全部通过。
- 真机执行日期：2026-08-18（延续同日复测）+0800。
- 平台：macOS 26.5.1；Grok Build `1.0.5 (5115b46bc909)`；开发版 Electron。
- 真机结果：Project A/B 均使用干净、可丢弃的本地 Git fixture。真实 Grok 已完成只读、权限拒绝和 Task/Project 隔离复测；两份 fixture 在结束时 `git status --short` 与 `git diff --stat` 均为空。未访问设置页，未记录 Key、Cookie、Header、环境变量、绝对路径或原始协议负载。
- 已确认失败（同日较早）：全新只读 Task 在不切换 Task/Project 的情况下，实时 Timeline 显示“用户指令不可用”，重新打开同一 Task 的历史 Timeline 则正确显示 Prompt。
- Windows 复测（同日稍后，开发版 `2a786f7` + `acceptAdmission` 修复；Node `v24.11.0`、pnpm `10.33.0`；界面 modelId 为 `grok-4.5`）：Project 显示名 `pA` / `pB`。实时执行中 Timeline 与权限弹窗 Task 字段均显示完整 Prompt；终态 `completed` 后切到其他 Task 再打开只读历史，Prompt 与已观察节点一致。RG-09-01 改为**受限通过**。同一 Task 第二轮未做；并排两个同名 Task 不能代替多轮验收。其中一个 Task 额外出现 `execute-command` 权限并被用户允许一次，历史审计为 `user-allowed`；这不是 RG-09-02 允许分支的完整验收。
- 白天已知限制（夜间补测前）：真实写入请求可被宿主在执行前以 L1 权限弹窗拦截；拒绝后的审计与终态正确。弹窗是强制模态层，未决时无法切换 Task/Project。当时允许一次、同一 Task 第二轮、RG-09-04 至 RG-09-08 尚未关闭。
- Windows 夜间补测（同日稍后，开发版 `f19cb2e`；Node `v24.11.0`、pnpm `10.33.0`；Grok CLI `1.0.0 (3cd0d0cbce)`；界面 modelId 为 `grok-4.5`）：使用可丢弃 Temp fixture `pA`/`pB`，经正式桌面路径 `打开项目 → 连接 Grok → 新对话 → startTurn`。HTTP Provider 设置页可见“HTTP 连接未加密”提示。相关 Vitest `task-timeline-reducer` + `useTaskTimeline` 13 项通过。未重跑全仓 ESLint/typecheck/build/E2E。
- 夜间补测结论：RG-09-01 同一 Task 两轮 + 历史回放改为**通过**。RG-09-02 允许一次改为**通过**（真实 Grok 申请的是 `execute-command` L3，不是 `write-file` L1；允许后写入 `scratch/p009-allow.txt`）。RG-09-05、RG-09-07、RG-09-08 改为**通过**。RG-09-03、RG-09-04、RG-09-06 保持或改为**受限通过**。Windows 窗口销毁/重建与安全历史截断仍记限制。P0-09 真机测试门按受限关闭；可以开始 GACP-01，不可开始 GACP-02 或 P0-10 主体。
