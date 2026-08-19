# GACP-02 点进历史即可接着对话

> **致执行者：** 产品已确认：点进一条历史就是进入这个对话，可以直接打字发送，**不要二次确认、不要单独的「继续任务」按钮**。本计划把这条体验落到主进程恢复契约上。
>
> **状态：** 待开始（前置：GACP-01 已于 2026-08-19 受限关闭，本计划可以开工）
>
> **插入点：** GACP-01 之后、P0-10 之前
>
> **产品来源：** 2026-08-18 用户确认，纠正初版「打开历史 ≠ 继续」的双动作设计。

**优先级：** P0-A / 权重 5（历史 Task 必须摸起来像一条还能聊的对话）

**目标：** 用户点侧栏里的一条历史 Task 后：

1. 立刻看到这条对话的本地历史（消息、时间线）。
2. 输入框就是这条对话的输入框，没有「先点继续」的第二步。
3. 主进程在后台自动尝试接回这条 Task 绑定的 Grok session（`resume`，失败且连接仍可信再 `load`）。
4. 用户按下发送时，如果后台已经接好就直接 `startTurn`；还在接就等这一次自动恢复；接不上再在**同一 Task** 上降级开新 session，并在状态条说明「上下文可能不完整」，仍然不要再弹确认框。

**核心数据流：**

```text
用户点选历史 Task
  → 立刻水合本地历史（现有 selectTask / task.get / listEvents）
  → 后台自动 AgentService.resumeTask(taskId)   // 无第二下确认
  → 成功：Composer 处于 live，下一条走同一 runtimeSessionId
  → 失败：Composer 仍可发送；首次发送在同一 taskId 上重建 session
  → 状态条只提示降级原因，不阻挡输入
```

**约束与边界：**

- 用户可见动作只有「点进这条对话」和「发送」。禁止再做「打开只读 / 继续」两个按钮。
- `runtimeSessionId` 仍不得进入 Renderer。
- 后台自动恢复失败 **不能** 再要用户确认一次。降级必须自动发生。
- 仍禁止把别人的 Task、别的 Project、已删除目录假装接活。这些情况输入框禁用，原因写在状态条。
- 单槽执行：Task A 正在跑时点进 Task B，B 可以看历史、可以打草稿；发送要么排队失败并说「先停掉当前任务」，要么等 A 结束。**不得静默取消 A 去接 B。**
- 不实现 session/list、fork、delete。
- 不把握手 `declared` 写成「已核实」。状态条可以用轻提示，不能用成功绿勾。

**主要风险：**

- 点每条历史都立刻 `resume`，会把 Grok 进程打得很忙，也会和单槽冲突。必须规定：先展示历史，恢复放进可取消的后台单飞；快速连点只保留最后一条 Task 的恢复。
- `activateTaskSession()` 用 `selectedTaskId` 短路，进程已死后会假成功。必须改成比较 `RuntimeSessionRef`。
- 自动降级成新 session 会丢 Grok 原生上下文。产品允许，但必须可见，且 **taskId 不变**，用户仍觉得在同一条对话里。
- load 若回放旧 `session/update`，不得写进当前空 Turn。沿用 Adapter generation。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**

- [GACP-01](gacp-01-real-grok-protocol-verification.md) 已受限关闭。真机切回 A 走了 `resume`；`session/load` 为 `not-observed`。本计划按 **resume-first** 做，load 只作未核实降级，**不得**把 load 或 handshake `declared` 写成已验证。不要等 GACP-01 补测 load / 退出三分支再开工。
- P0-06 TaskStore、P0-03 能力矩阵、P0-09 公开事件边界。

**文件范围：**

- 修改：`src/main/agent/agent-service.ts`（`resumeTask`、`activateTaskSession`、必要时「同一 Task 重建 session 但保留 taskId」）
- 修改：`src/shared/task-history.ts`、`src/main/agent/task-store.ts`
- 修改：`src/main/agent/task-ipc.ts`、`src/preload/desktop-api.ts`
- 修改：`src/renderer/src/composables/useTaskHistory.ts`、`App.vue` 的 `selectTask()`（去掉必须再点继续的门禁）
- 测试：上述 `*.test.ts`
- P0-10 只负责把侧栏/Composer 做漂亮；**不得再加回「继续任务」确认按钮**。

**安全策略：**

- 自动恢复只接受用户点选产生的 `taskId`。主进程自己解析 project、root、sessionRef。
- Project 目录不可用时：只看历史，发送禁用。
- 错误脱敏；不回传 `runtimeSessionId`。

## 已锁定的产品语义

### 1. 点进 = 进入这条对话

废止初版「查看历史 ≠ 恢复 Runtime、必须再点继续」。

| 用户动作 | 界面立刻怎样 | 主进程同时怎样 |
| --- | --- | --- |
| 点历史 Task | 打开该 Task 历史，输入框可用 | 后台单飞 `resumeTask` |
| 连续点另一条 | 立刻切到新 Task 历史 | 取消上一条未完成的自动恢复，改恢复新 Task |
| 在已接活的 Task 里发送 | 直接新 Turn | 复用绑定 session |
| 自动恢复还在进行时发送 | 发送按钮进入 pending，不弹框 | 等当前这条自动恢复结束再 `startTurn` |
| 自动恢复失败后发送 | 仍发送，状态条提示上下文可能不完整 | 同一 `taskId` 重建 session 再 `startTurn` |
| Project 不可用 | 只读历史，输入框禁用 | 不 connect、不 resume |
| 另一条 Task 正在执行 | 可看 B，A 继续跑 | 不切换 execution；B 发送被拒绝并说明原因 |

现有 `selectTask()`「绝不连接或恢复」的注释作废，改为：「点选即进入对话；本地历史先画出来，Runtime 恢复在后台自动发生。」

`window.task.get` 仍然只读。自动恢复走 `resumeTask` 或新的 `agent:enter-task`，由 Renderer 在 `selectTask` 里调用，**不要**让只读历史查询产生副作用。

### 2. 没有第二下确认

禁止这些 UI：

- 「继续任务」主按钮
- 「是否恢复 Runtime？」对话框
- 先只读、再点解锁输入框

允许的提示只有状态条/页眉弱文案，例如「正在接回上次上下文…」「已用新上下文接着聊」。

### 3. 后台怎么接 session

继续用现有顺序，只是改成自动触发：

```ts
// 备注：点进对话后自动走这条链，不要再等用户确认。
// 优先 resume；失败且连接仍 ready 才 load；两者都失败则保留历史，发送时同 Task 重建 session。
```

`isUsableRestoreCapability` 仍要区分 declared / verified，但 **不再用来隐藏输入框**。它只影响：

- 先试哪种方法
- 状态条说「接回」还是「可能不完整」

| 能力状态 | 点进后自动做什么 | 用户感知 |
| --- | --- | --- |
| resume verified / declared | 自动 resume | 接上就静默；失败自动降级 |
| 仅 load | 自动 load | 弱提示可能回放旧输出，不弹确认 |
| 都不支持 / 真机失败过 | 不空转 resume | 历史可看，发送时同 Task 新 session |
| 目录不可用 | 什么都不接 | 输入框禁用 |

### 4. 假选中必须修

`activateTaskSession()` 不能只看 `selectedTaskId === task.taskId`。必须比较 Adapter 当前 `RuntimeSessionRef` 与 Task 绑定是否完全一致；不一致就自动 resume/load。disconnect 后点进同一条，也要自动重连再接，不要假成功。

### 5. 单槽与后台恢复

- 自动恢复本身占 session operation，必须走 `OperationGate`。
- 已有活动 execution 时：点其它 Task 只看历史，不抢槽，不取消当前 Turn。
- 快速连点：只保留最后一次 enter-task 的恢复，旧的必须可取消且不得把晚到 resume 写到新选中的 Task 上（用 requestId / selectedTaskId 校验）。

---

## 任务 1: 把「进入对话」收成主进程动作

**任务目标：** Renderer 点选只提交 `taskId`；接不接得上由主进程自动决定。

- [ ] **第 1 步: 定义 enterTask / 扩展 resumeTask**
      说明：要么让现有 `resumeTask` 成为点选后的自动调用，要么新增语义相同的 `enterTask`。失败返回可序列化结论，不要抛成必须用户确认的硬错。`resumed: false` 仍算这次点选成功（历史已经打开）。
      预期：点选历史不再出现必须处理的错误弹窗，除非 Project 都读不到。

- [ ] **第 2 步: 同一 Task 重建 session**
      说明：自动 resume/load 都失败后，保留 `taskId`、历史、environment，丢掉失效 `RuntimeSessionRef`，在首次发送时 `createSession` 并写回 TaskStore。这是降级，不是新 Task。
      预期：侧栏还是同一条对话；Grok 侧是新 session；状态条说明上下文可能不完整。

- [ ] **第 3 步: 单飞与取消**
      说明：同一时刻只自动恢复一条 Task。切走就取消未完成的 enter。晚到的 resume 成功不得改掉当前选中 Task 的绑定。
      预期：连点五条历史，只给最后一条接 session。

## 任务 2: 修激活逻辑，让发送不再要第二步

**任务目标：** live Composer 不再依赖用户先点继续。

- [ ] **第 1 步: 用 RuntimeSessionRef 相等性替换 selectedTaskId 短路**
      说明：见上文第 4 节。连续 Turn 且 session 真匹配才跳过 resume。
      预期：杀进程后再点同一条，会自动重连，而不是空成功。

- [ ] **第 2 步: selectTask 去掉只读门禁**
      说明：打开历史后 `mode` 不要长期锁在必须 resume 才能发送。输入框默认可写。自动恢复 pending 时发送等待；Project 不可用或外槽占用时才 disable，并写原因。
      预期：点进就能打字；不再出现「只读历史 + 继续按钮」。

- [ ] **第 3 步: 发送与自动恢复汇合**
      说明：`startTurn` 前如果这场 enter 还在飞，等它。失败则走同 Task 新 session。不要弹出「要不要恢复」。
      预期：用户只按一次发送。

## 任务 3: 状态条而不是确认框

**任务目标：** 把 declared / 降级 / 回放风险变成弱提示。

```ts
// 备注：点进对话后只给状态，不给第二按钮。
interface ConversationEntryState {
  taskId: string
  historyReady: boolean
  restore: 'idle' | 'connecting' | 'ready' | 'degraded' | 'unavailable'
  method?: 'resume' | 'load' | 'new-session'
  verification: 'unverified' | 'declared' | 'verified'
  reason?: string
}
```

- [ ] **第 1 步: Preload 白名单重建该 DTO**
      说明：不得带 `runtimeSessionId`。
      预期：主进程多塞私有字段会被剥掉。

- [ ] **第 2 步: 页眉/Composer 只读 restore 状态**
      说明：`connecting` 显示轻量 spinner；`degraded` 黄色说明；`unavailable` 才禁用输入。不要模态框。
      预期：P0-10 可以直接用，不会再设计「继续」主按钮。

- [ ] **第 3 步: reload 后同样自动进入**
      说明：应用起来若恢复了上次选中 Task，行为与点选相同：先画历史，再自动接。pending 审批只靠已有 snapshot/Push，不伪造按钮。
      预期：重启后点着的那条对话仍能直接打字。

---

## 验收标准

- [ ] 点历史 Task 后无需任何第二下确认就能发送下一条。
- [ ] 界面没有「继续任务」主按钮或「是否恢复」对话框。
- [ ] 自动 resume/load 在后台进行；失败不打断浏览，首次发送在同一 Task 降级新 session。
- [ ] 快速切换只恢复最后一条；晚到 resume 不绑错 Task。
- [ ] 其它 Task 正在执行时，点进来能看，不能把正在跑的那条杀掉。
- [ ] Project 不可用时只能看不能发。
- [ ] Renderer DTO 无 `runtimeSessionId`。
- [ ] 相关 Vitest + `pnpm typecheck` + `pnpm build` + `git diff --check` 通过。

## 非目标

- 不在这里做 P0-10 整页重构。
- 不自动恢复到另一条正在跑的 execution 上去。
- 不把降级新 session 吹成「原生上下文已接回」。
- 切换模型、上下文用量展示见本目录 README「后续增强」，不在本计划做。
