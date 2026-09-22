# 工作区布局与详情联动实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**目标：** 修复浏览器挤掉发送入口，支持浏览器专注布局和悬浮输入形态，并打通对话与 Inspector 定位。

**核心数据流：** 工作区尺寸与拖动意图形成单一布局状态；Renderer 测量实际网页矩形，通过已有类型化 bounds API 更新原生 WebContentsView。Task/Turn/节点选择经统一导航状态投影到对话和 Inspector。

**约束与边界：** 对应问题 2.4、2.5、2.7 的工作区部分。保留单个 Task 状态与草稿，不创建第二个 Agent。WebContentsView 为原生层，不能用 CSS z-index 假称可覆盖。

**主要风险：** 侧栏宽度漏算；缓存宽度或缩窗破坏布局；原生网页遮挡输入和弹窗；Inspector CSS 浮动与组件 docked 状态相反。

**技术栈：** Electron WebContentsView、Vue 3、ResizeObserver、TypeScript、Vitest、Electron GUI 测试。

**状态：** 用户已批准 P0-23D，明确选择真正覆盖网页的原生输入浮层，不接受底部避让。布局、浏览器与 Inspector 修复已在工作区，保留未提交改动。真实 GUI 证据为 **3 过 1 失败**，不得标记整体验收完成：浮层 Proxy 无法跨 IPC 克隆的根因已修；系统焦点导致浮层隐藏、停止后状态 failed 仍未收口，需要后续真机复测。

**2026-09-20 验证：** 最新 typecheck 与 build:unpack 通过（本机无 Developer ID，打包跳过签名），diff-check 通过；全量 Vitest 196 文件 / 1926 测试通过，但错误收集 `autoTest/workbench-repair/workbench-repair.spec.ts`，因 Playwright beforeEach 报错导致命令失败。不能将单测或构建成功替代真实 GUI 验收。本轮只修 Plan 退出权限同步，未覆盖现有浏览器/Inspector 改动。

---

## 任务 1：宽度计算止损

**文件：** 新增 `src/renderer/src/workspace-layout.ts` 及测试；修改 `App.vue`、`HostBrowserPane.vue`、`assets/main.css`、`host-browser-pane.test.ts`。

- [ ] 按实际工作区内容宽度扣除可见侧栏、分隔条和 Inspector 占位，计算聊天列与浏览器预算，不用 `window.innerWidth - 380`。
- [ ] 默认、拖动、窗口变化、侧栏切换、缓存恢复全部走同一夹紧函数；处理 NaN、负值及过大缓存。
- [ ] 预算不足时收起次级面板，不把聊天列压到发送按钮不可见；任务 2 获批并完成后才可改为专注布局。
- [ ] 拖动使用 pointer capture 并处理 pointercancel、失焦和卸载；恢复 cursor/userSelect，不残留拖动状态。
- [ ] 增加几何单测与开发版按钮可见/可点击断言，不能只测源码包含某个 class。

**完成标志：** 任意支持窗口尺寸和恢复状态下，输入框、模型、发送/停止入口均可达。

## 任务 2：浏览器专注模式

**已批准方案（true overlay）：** 浏览器占满工作区横向区域，网页底部不为输入条让位。独立、可聚焦、非模态、父子关系绑定主窗口的 Electron `BrowserWindow` 位于 `WebContentsView` 之上，窗口仅覆盖输入条矩形，不使用 CSS z-index 假遮挡，也不复用鼠标指针浮层。

**文件：** `workspace-layout*`、`HostBrowserPane.vue`、`main/browser/browser-focus-overlay*`、`shared/browser-focus-overlay.ts`、独立窄 preload 和 renderer 页面。`App.vue`、`main/index.ts`、`preload/desktop-api.ts`、`main.css` 由主 agent 整合，本子任务不编辑。

**具体数据流与边界：**
- 主窗口保留唯一 Task、草稿、附件和执行状态；通过静态 `app:browser-focus-publish` 发布有界公开投影（投影身份、Task、版本、草稿确认序号、真实执行身份、网页 CSS 矩形、主题和按钮状态）。主进程先验证当前主窗口主 frame，再解析字段。
- 原生控制器将网页 CSS 坐标乘主窗口 zoom factor，再加 content bounds 转为屏幕 DIP；只定位输入子窗，绝不缩短网页 bounds。子窗 `contextIsolation/sandbox` 均开启，`nodeIntegration` 关闭，独立 preload 不暴露 Agent、Provider 或通用 invoke。
- 浮层通过固定 `app:browser-focus-intent` 回传 draft/send/stop/expand；主进程验证已知子窗主 frame 和精确页面 URL，检查投影身份、版本与单调编辑序号后，沿固定事件推回主窗口。只有主窗口更新真实草稿，调用既有发送/停止/展开流程，并回发确认后的投影；浮层不创建 Task、不保存附件、不直接调用 Runtime。
- 输入期间只保留 DOM/IME 临时编辑缓冲，确认前禁止发送；切 Task 或主窗口外部替换草稿时更换投影身份，旧事件拒绝。停止必须校验真实执行的 executionId/taskId/turnId，而不是历史选中 Task。
- 主窗口 move/resize/zoom 重新定位；minimize/hide 隐藏，restore/show 恢复；主窗与子窗互相切焦不隐藏，切到其他应用隐藏且恢复时不抢焦；close 销毁子窗并清理 IPC/监听器。设置、菜单或模态 UI 打开时由主窗口发布 `visible: false`。

- [ ] 状态统一为对话、分栏、浏览器专注三种；拖动使聊天预算低于最小宽度时显示吸附预览，松开进入专注模式，提供显式退出按钮。
- [ ] 保留唯一 Composer 实例或统一受控草稿，切换不清空文字、附件、输入法状态及待发送状态。
- [ ] 网页矩形仅避让顶部入口，不避让底部输入条；弹出菜单、设置和执行详情时同步隐藏浮层及必要的原生视图，关闭后恢复。
- [ ] 顶部入口显示当前 Task 和活动步骤，点击打开现有执行详情；停止始终作用于真实运行 Task，不误停选中的历史 Task。
- [ ] 主进程重新校验 bounds 和视图归属；保留原生页面 session、登录态、光标 overlay 几何映射。
- [ ] 验证浏览器输入、长草稿高度变化、菜单、设置、缩放、多屏、最小化恢复和执行中模式切换。

**完成标志：** 浏览器专注模式没有被挤成细条的聊天列，悬浮形态可发送/停止/看执行详情，网页不截获这些操作。

## 任务 3：Inspector 与对话双向定位

**文件：** `App.vue`、`TaskInspector.vue`、`InspectorPaneGrid.vue`、`InspectorPane.vue`、`InspectorTimelinePane.vue`、`TaskConversation.vue`、`task-inspector.ts` 及测试。

- [ ] 复用现有选择状态，统一 taskId、turnId、工具/文件/产物引用；点击对话详情选中 Inspector 对应项，点击 Inspector 回到所属对话轮次。
- [ ] 左侧项目/对话导航统一选中态、运行态、展开折叠、长名称提示和紧凑布局；增加托管聊天分组时对接 P0-23A，不复制历史列表状态。此项负责问题 2.7 的左侧导航范围。
- [ ] Timeline 展示逐轮执行及工具状态，权限审计作为按需详情，不独占整个列表。
- [ ] docked/floating 状态从布局控制器派生，删除 CSS 视觉浮动但逻辑仍 docked 的双重规则。
- [ ] 自动跟随只在用户选择“跟随当前执行”时生效，后台事件不抢历史选择或滚动位置。
- [ ] 处理切 Task、历史分页目标尚未载入、节点不可用、双栏审阅关闭和浏览器同时打开。

**完成标志：** 对话、计划、工具、Changes、Artifacts 可以定位到同一事实；布局和选中状态一致。

## 验证与验收

- [ ] 编辑符号前 GitNexus impact；高影响的 App 编排与浏览器服务改动分批整合。
- [ ] 目标与完整 Vitest、ESLint、typecheck、build、`git diff --check`；主入口改变时运行 `build:unpack`。
- [ ] 真 Electron 开发版覆盖 980/1180/1440px、深浅主题、极限拖宽、缓存恢复、Inspector 三种布局、Native View 点击遮挡。
- [ ] 自动化产物放 `autoTest/workspace-layout/`；普通浏览器 Mock 不替代原生层验收。
- [x] 用户已批准真正原生覆盖输入窗；按上述父子窗口、焦点与窄 IPC 数据流实现，不再请求方案选择。
