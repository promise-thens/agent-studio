# P0-19f 浏览器 / Computer Use 插件表面 实施计划

> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。
>
> **状态：** 待开始。
>
> **插入点：** [P0-19](p0-19-grok-host-capability-polish.md) 本程序最后一项。前置：P0-10E 能安装市场插件；GACP-03 不得把 browser/screen/clipboard 放进「本任务写文件」grant。完成后若仍缺共享页面，才允许启动 [P3-05](p3-05-managed-browser.md)。

**优先级：** P0-A 能力层 / 权重 4（Grok 已经能靠插件上网和点 GUI；桌面缺审批、证据和停止）

**Goal：** 用户在桌面安装并信任 Grok 的浏览器 / Computer Use 类插件后，相关工具走 L3 权限、截图进 Artifacts、进行中有可见停止。桌面不自建 BrowserView、不读用户 Chrome Profile、不实现虚拟光标。

**Architecture：** 执行仍是 Grok 插件（`chrome-devtools-mcp`、browser-use、社区 computer-use 等）。桌面做三件事：

1. **权限：** `browser` / `screen` / `clipboard` 保持 L3；目标尽量投影为 origin 或 app 名；没有可信目标就当 unknown，不能自动过。
2. **证据：** 插件截图 / 页面摘要若已落在 execution root 或 Grok session 图片目录（现有 runtime media 允许名单），注册为 Task Artifact；Timeline 只存 artifact 引用。
3. **HUD：** 任一 screen/browser L3 执行中，主窗口显示不可拖丢的停止条（复用 Task 停止，不另开权限通道）。

**Tech Stack：** 现有插件页、Permission Broker、P0-13 Artifact Registry、P0-11 evidence、runtime media 路径规则。

**Spec：** [P0-19](p0-19-grok-host-capability-polish.md)。对标 Codex 的产品分层：结构化插件优先于点界面；本计划只让 Grok 插件在宿主里可审阅。

## Global Constraints

- 沿用 P0-19。
- Inspector 顶层标签不增加 `browser`。截图走 `artifacts`，动作走 `timeline`。
- 不实现 CDP 转发、Playwright 进程、Native Messaging、Accessibility Helper。
- 不把插件 stderr、cookie、页面全文写入日志或 Timeline。
- 安装源仍只允许 P0-10E 已校验的货架 name，不因「我们需要浏览器」就随便 clone。

---

## 非目标

- 不做共享 DOM 标注、WebMCP、Edge/Chrome 扩展桥（P3-06）。
- 不做 macOS Computer Use Helper（P3-07）。
- 不做「后台虚拟光标」。
- 不为每个网站做桌面内嵌登录浏览器。

## 数据流

```text
用户在插件页安装 chrome-devtools（或同类）并信任
  → 下一 session Grok 加载 MCP
Grok 申请浏览器/屏幕工具
  → mapper 标 operationType browser | screen | clipboard
  → Broker L3：本次或拒绝，绝不 grant-reused 成写文件通行证
  → 允许后 Grok 执行插件
  → 截图文件通过已允许的 media/artifact 路径注册
  → Timeline 工具行 + Artifacts 缩略图
进行中
  → 顶部或 composer 停止条常驻，copy 写明「Grok 正在使用浏览器/屏幕」
用户停止
  → cancelTurn；HUD 消失
```

## 安全边界

- L3 不能被 GACP-03 的 task grant 复用。计划里要补测试：已允许写文件后，browser 仍要再问。
- Artifact 注册沿用 P0-13：opaque id、路径在 execution root 或已冻结的 session 图片目录、类型白名单。
- 恶意 Markdown / SVG 仍按 P0-13 不执行脚本。
- HUD 必须 `no-drag`，有 aria-label，停止失败要有脱敏错误。

## 文件范围

- 修改：`src/main/security/permission-policy.ts` 及 grok mapper（browser 目标 kind 今日是 `unknown`，能解析 origin 再加 `origin`）
- 修改：Artifact 注册从 runtime 图片目录到当前 Task（若尚未接线）
- 修改：执行中 HUD（`App.vue` / Task 头 / Composer，三选一处，不要三处各做一套）
- 测试：L3 不复用写文件 grant；无截图时 Timeline 仍可完成；停止清除 HUD
- 走查清单：安装 chrome-devtools；一次只读浏览；拒绝屏幕权限后不得继续点

### 任务 1: 堵住 grant 捎带

- [ ] **第 1 步: 失败测试**

说明：同一 Task 先 `allow-task` 写文件，再来 `browser` / `screen` / `clipboard`，必须再弹 L3，不能 `grant-reused`。

- [ ] **第 2 步: origin 目标**

说明：若 Grok 已给 URL，校验后投影 `origin`；内嵌用户信息的 URL 拒绝。解析不了就 unknown + L3。

### 任务 2: 截图进 Artifact

- [ ] **第 1 步: 复用 P0-13 注册**

说明：只注册已允许路径上的 png/jpeg/webp。失败不阻断 Turn，Timeline 标记「无可用截图」。

- [ ] **第 2 步: Artifacts 列表**

说明：标题用工具摘要，不把本地绝对路径给 Renderer。

### 任务 3: 可见停止 HUD

- [ ] **第 1 步: 进行中条件**

说明：当前 Task 有未完成的 browser/screen 工具，或有未决 L3 屏幕权限。普通写文件不要出这根条。

- [ ] **第 2 步: 走查**

说明：装插件 → 让 Grok 打开公开页或 localhost → 看到 L3 卡 → 允许后有 HUD → 截图出现在 Artifacts → 停止后面板不再声称正在控制。拒绝权限则无截图、无控制。

## 验收标准

- [ ] 写文件授权不能捎带浏览器/屏幕。
- [ ] 有截图则进 Artifact；无截图有明确降级。
- [ ] 控制期间停止入口始终可见。
- [ ] 没有 BrowserView、没有读用户 Chrome。
- [ ] 自动验证 + 开发版走查。完成后评审是否还需要 P3-05。
