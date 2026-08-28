# GACP-03 能过的自动过，不要一个个点

> **致执行者：** 产品已确认：用户不要对着每个工具点一次允许。**能自动通过的必须自动通过**；只有真正危险、证据不够、或第一次需要建立本任务授权的，才打断一次。
>
> **状态：** 待开始（前置：P0-11；GACP-01 已关闭，本轮只冻结到一次 `execute` + 唯一 `allow_once` / `reject_once`）
>
> **插入点：** P0-11 之后
>
> **产品来源：** 2026-08-18 用户确认。初版只强调「审批卡可读」不够，本计划的主目标改成「少打断 + 自动过」。

**优先级：** P0-A / 权重 4（工作台能不能用，很大程度看会不会被权限弹窗打死）

**目标：**

1. 项目内只读：**零点击**，Broker 直接 `auto-allowed`。
2. 同一 Task 里已经允许过的同类写/命令：**零点击**，走 `grant-reused`。
3. 本 Task 第一次写文件或跑命令：最多弹 **一次**，默认动作是「本任务允许」，不要拆成每个文件点一次。
4. 项目内删除也是通用 Agent 的正常工作：第一次本任务授权后同类可自动过。真正危险的是**越出项目、不可逆、控整台电脑、证据不够**，见下文「危险操作」定义。
5. 审批卡如果出现，必须看得出目标；但本计划成功的标志是 **大多数 Turn 根本不弹卡**。

**核心数据流：**

```text
ACP request_permission
  → 稳定字段投影（不含 rawInput）
  → evaluatePermissionPolicy
        L0 / 已有 Task grant → 直接回 ACP allow_once，不 Push UI
        本 Task 首次 L1/L2 → 一张卡，主按钮 allow-task
        L3 / 未知 / invalid → 一张卡，只能本次或拒绝
  → 同类后续请求命中 grant，静默通过
  → 事后 P0-11 仍记 Command Evidence（自动过也要留审计）
```

权限阶段和证据阶段仍然分开：

| 阶段 | 可以用来源 | 不可以用来源 |
| --- | --- | --- |
| 批准前（能不能自动过） | `kind`、root 内 `locations`、diff path、已有 Task grant、policy 风险 | `rawInput`、聊天文本、「看起来是读文件」的 title 猜测 |
| 执行后（P0-11） | 已验证 runtime-tool 字段 | 不能倒过来证明「刚才其实自动批准过一条未知命令」 |

**约束与边界：**

- 自动过 **不是** 向 Grok 回 `allow_always`。ACP 侧永远只回本次 `allow_once`。跨 Turn 的「不用再点」靠 **Agent Studio 自己的 Task grant**，不靠 Grok 的 always。
- invalid 快照、没有唯一 `allow_once` option、终态后迟到的请求：仍然只能给 ACP `cancelled`，不能为了少弹窗而放行。
- Broker 仍不是进程沙箱。Grok 没上报就自己改盘，产品不得写成「已经自动批准」。
- 不把越出项目、不可逆 Git、未知外网、屏幕/剪贴板/Computer Use 做成自动过。项目内普通删除按写文件同级处理，不是「每次必弹」。

**主要风险：**

- grant 指纹太细（每个 path 一把钥匙）→ 用户还是每个文件点一次，产品失败。
- grant 指纹太粗（整个 Task 一张写通行证含删除）→ 危险操作被捎带通过。
- 为了少点击去读 `rawInput` → 密钥和谎言进入授权。
- Grok 只给 `allow_always`、没有 `allow_once` → 现在 `executionSupported = false`。自动过也必须有可回的 option；没有就只能取消并告诉用户 Runtime 不支持一次性允许。

**技术栈：** Electron 39、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**

- GACP-01：真实 Grok 的 `kind`、locations、option.kind 集合。
- P0-07 PermissionBroker / `permission-policy.ts`（已有 L0 自动过、`once`/`task` grant）。
- P0-11：自动过的命令也要能落 evidence。

**文件范围：**

- 修改：`src/main/security/permission-policy.ts`（哪些自动过、grant 粒度）
- 修改：`src/main/security/permission-broker.ts`（静默放行、本任务授权默认）
- 修改：`src/main/runtime/grok/grok-acp-mappers.ts`（可信目标、fingerprint 不要每个文件都不同到无法复用）
- 修改：`src/renderer/src/components/PermissionPrompt.vue`（主按钮改成「本任务允许」；能自动过的路径根本不渲染）
- 对接 P0-11 mapper：自动过也写 Audit `reason: auto-allowed | grant-reused`
- 测试：policy / broker / adapter 权限用例，补「连发 20 个项目内 read 零弹窗」

**安全策略：**

- 自动过之前仍要跑 `resolveOperationIntentTargets()`。路径出 root 直接拒绝，不自动过。
- 审计一条都不能少。少点击 ≠ 少记录。
- 文案可以说「已按本任务授权自动允许」，不能说「安全扫描已通过」。

## 危险操作具体指什么

仓库里现在的默认表（`permission-policy.ts`）把 `delete-path` 一律标成 L3，而且 L3 只能「本次」。这对**通用 Agent** 过严：清构建产物、删错文件、收拾临时目录都是日常工作，Codex 也不会每删一个文件弹一次。

本计划把「危险」收成下面这张表。**危险 = 不能默默过，不是 = Agent 不准做。**

### 日常工作（少打断，本任务一次授权）

这些是通用 Agent 的正餐，包括删除：

| 操作 | 风险 | 第一次 | 同一 Task 后续 |
| --- | --- | --- | --- |
| 读 / 搜项目内文件 | L0 | 自动过 | 自动过 |
| 写项目内文件 | L1 | 一张卡，默认本任务允许 | 自动过 |
| **删项目内普通文件 / 空目录** | L1 | 一张卡，默认本任务允许删项目内文件 | 自动过 |
| 项目内执行可信命令 | L2 | 一张卡，默认本任务允许同类命令 | 指纹命中则自动过 |
| 项目内 git 普通变更（commit 以外的安全变更另说） | L2 | 一张卡 | 同类可复用 |

### 仍然危险（要强确认，或根本不能自动过）

| 操作 | 为什么危险 | 怎么拦 |
| --- | --- | --- |
| 路径跑出当前 Project / Worktree | 能删到用户家目录、系统目录 | 直接拒绝，不存在自动过 |
| 递归清空、删 `.git`、删整个 execution root | 不可逆，整仓没了 | 每次确认，只能本次 |
| `git hard-reset` / `force-push` / `force-clean` / 改写历史 | 现有 `DANGEROUS_GIT_TARGETS` | 升 L3，每次确认 |
| 命令证据不够（不知道要跑什么） | 可能是 `rm -rf /` 或外泄 Key | 不能自动过 |
| 外网目标不明 | 可能把代码/密钥送走 | 每次确认或不可执行 |
| 浏览器登录态、屏幕、剪贴板 | 产品愿景里的高敏感数据 | 能力没接入前拒绝；接入后每次/可见停止 |
| Computer Use / 控鼠标键盘（后续插件） | 等于把整台电脑交给 Agent | 单独授权 + 始终可见停止，不走「本任务写文件」那张通行证 |
| 证据 invalid / 未知操作 | 不知道在干什么 | 不能为了少点击而放行 |

后续「像 Codex 那样的电脑插件」走 P3 Capability Pack，**必须进同一个 PermissionBroker**，不能插件自己弹一套窗。日常删项目文件，和「帮我点系统设置、读屏幕」不是同一档。

「同类」grant key：

```text
# 备注：项目内读/写/普通删按操作类型复用，避免每个文件一把钥匙。
# 危险删除、出网、未知必须带更具体目标，避免被「允许删项目文件」捎带成 rm 家目录。
read-project          → taskId + environmentId + operationType
write-file            → taskId + environmentId + operationType
delete-path（普通）   → taskId + environmentId + operationType + 'in-root-normal'
delete-path（危险）   → 精确 path，禁止宽 grant
execute               → taskId + environmentId + operationType + commandFingerprint
fetch/unknown/computer-use → 精确目标，不允许宽 grant
```

对抗测试必须包括：

- 写文件 grant **不能**让越界删除自动过
- 「允许删项目内普通文件」**不能**让删 `.git` 或 root 外路径自动过
- Computer Use 授权 **不能**被写文件/普通删除 grant 继承

### 审批卡（只在不能自动过时出现）

- 主按钮：L1/L2 用「本任务允许」，不要把「仅本次」做成默认。
- 次按钮：仅本次、拒绝。
- L3：没有「本任务允许」。
- 一张卡可以列出这一次请求里的多个 path，不要拆成 N 张。
- Broker 已有 FIFO：同一 Turn 多个必须人工看的请求，仍按到达顺序，但能合并展示的同类 L1 应尽量合成一次授权。

### 和现有代码的关系

`evaluatePermissionPolicy()` 已经是：

- L0 → `allow`
- L3 → 只允许 `once`
- 其余 → `once` + `task`

GACP-03 不是另写一套风险哲学，而是：

1. 让 L0 在真 Grok 读文件路径上真的打到（现在如果 kind 映射成 unknown 就会误弹）。
2. 让 Task grant 的指纹宽到「不用每个文件点」，窄到「删除捎带不过」。
3. 让 UI 默认点「本任务允许」，并且自动过的请求根本不 Push。

---

## 任务 1: 让自动过在真 Grok 读/写上生效

- [x] **第 1 步: 对照 GACP-01 修正 kind 映射**
      说明：真实 `read`/`search` + root 内 path 必须进 `read-project` L0。不要再落到 unknown L3。
      预期：一次「读 15 个文件」的 Turn，PermissionPrompt 出现 0 次，Audit 有 15 条 `auto-allowed`。

- [x] **第 2 步: 放宽写/读的 grant 粒度**
      说明：按上表改 `createOperationGrantKey`。补测试：write grant 之后 delete 仍要弹；execute grant 不能覆盖另一条不同指纹的命令。
      预期：同一 Task 第二次写项目文件不再弹窗。

- [x] **第 3 步: 没有 allow_once 时不能假装自动过**
      说明：Grok 若只给 `allow_always`，保持现在的 cancelled / 不可执行，并在状态里说「Runtime 没提供一次性允许」。不要为了少点击去回 always。
      预期：安全门与少打断同时成立。

## 任务 2: 第一次打断要「一下管住后面」

- [ ] **第 1 步: 默认 allow-task**
      说明：L1/L2 审批卡主按钮绑定 `allow-task`。键盘 Enter 也走主按钮。
      预期：用户点一次后，本 Task 同类操作静默通过。

- [ ] **第 2 步: 同批 path 合成一张卡**
      说明：同一 toolCall 或多个连续 write 在短窗口内，尽量一次授权。不要每个 path 一张 FIFO 卡。
      预期：一次「改 8 个文件」最多 1 张卡。

- [ ] **第 3 步: 审批卡仍要可读**
      说明：有可信命令/origin 就展示；没有就写明「证据不够，不能自动过」。这是少打断的配套，不是本计划唯一目标。
      预期：用户知道自己允的是「本任务写项目文件」，不是一张空白安全通行证。

## 任务 3: 自动过也要可审计、可回看

- [ ] **第 1 步: Audit 必记**
      说明：`auto-allowed` / `grant-reused` 必须进 PermissionAuditStore。Timeline 可用折叠摘要「已自动允许 12 次读取」，不要 12 张大红牌。
      预期：少点击的同时，事后能说清过了什么。

- [ ] **第 2 步: 与 P0-11 对齐**
      说明：自动过的 execute 仍写 Command Evidence。未上报审批的 Runtime 私自动作，继续标明 Broker 没拦。
      预期：自动过 ≠ 伪造沙箱。

- [ ] **第 3 步: 回归 fail-closed**
      说明：保留 invalid、熔断、跨 Turn 不继承、终态后取消。再加「宽 grant 不覆盖删除/出网」。
      预期：P0-07 强度不降。

---

## 验收标准

- [ ] 项目内连续读取不出现审批卡。
- [ ] 本 Task 第一次写文件最多一张卡，默认「本任务允许」；之后同类写零点击。
- [ ] 项目内普通删除与写文件同级：本任务一次授权后自动过。
- [ ] 越界删除、删 `.git` / 整个 root、危险 Git、未知出网、Computer Use 不会被普通写/删授权捎带通过。
- [ ] 从不向 ACP 发送 `allow_always`。
- [ ] 自动过的操作都有 Audit。
- [ ] `rawInput` 仍不能让风险降级或自动过。
- [ ] 相关 Vitest + 既有权限 E2E 全绿；真实 Grok 至少走通「读一堆 + 写几次只点一次」。

## 非目标

- 不要「全部工具永久自动过」。
- 不要项目级、跨 Task 的长期授权（以后要做另开计划）。
- 不要用关闭 Broker 来少点击。
- 切换模型、上下文用量不是本计划。
