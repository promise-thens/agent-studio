# Computer Use 开发文档：按 Codex 方式做本机 GUI 操作

> 日期：2026-09-17（按通用型 Agent 改写：默认开放，不为安全剧场上锁）
> 状态：**已提为下一开发项**。最终体验对标 Codex / ChatGPT Browser Use，产品哲学是 **自由、开放、通用**：总开关打开后 Agent 自己开标签、用登录态、点内置页、连用户 Chrome、点 Mac 任意 App。设置页用来给你关，不是用来一路拦它。开工顺序：阶段 0 → 0b（P3-06：设置页 + 扩展同步/连接）→ 1–4（P3-07）。
> 相关：[p3-06-chrome-native-bridge.md](../plans/p3-06-chrome-native-bridge.md)、[p3-07-macos-computer-use-helper.md](../plans/p3-07-macos-computer-use-helper.md)、[2026-09-16-host-browser-pointer-overlay-design.md](2026-09-16-host-browser-pointer-overlay-design.md)、[p0-21a-host-browser-pointer-and-snapshot.md](../plans/p0-21a-host-browser-pointer-and-snapshot.md)、[p0-21-host-managed-browser.md](../plans/p0-21-host-managed-browser.md)、[product-vision.md](../../product-vision.md) §7.2–7.3

**一句话：** 通用型 Agent。打开「让 Grok 控制内置浏览器」就全权用内置页；装上配套扩展就把用户 Chrome 的可同步状态带进来，并且能操作 Chrome 窗口。不要每站批一次、不要下载还要批准、不要把连接模式藏进开发者开关。任意 App 走 Helper。模型只报编号。OCR 不是主路径。

---

## 0. 读本文的人要先知道

### 0.1 证据边界

本文依据：

1. 用户提供的 Codex Computer Use 技能原文（`@oai/sky`、`get_app_state`、`element_index`、确认策略）。
2. 本仓库已落地的内置浏览器：CDP AX snapshot、`x/y/width/height` bbox、`browser_click(ref)`、overlay DIP 映射。
3. 2026-09-17 真机会话：snapshot 带框、模型仍夹杂 `click_xy` 与 Python/PIL 算坐标；工具本身 0.1s，空档合计约 525s。

本文 **不是** OpenAI 内部实现泄密，不复制、不打包 Codex 私有 Helper。对标的是同类能力与开放 API：Accessibility、ScreenCaptureKit、MCP、技能合同。

### 0.2 已经验证的失败路径（禁止再走）

| 做法 | 为什么失败 |
| --- | --- |
| OCR 认字再点 | 字框 ≠ 可点控件；下拉一关字还在图上；重名「查询」无法消歧 |
| 截图估 `click_xy` | VLM 差一行（40–56px）是常态；Element UI portal 更飘 |
| 0–1000 归一化 | 右栏视口常 <1000，合法 CSS 会被误折 |
| 终端 Python/PIL 算坐标 | 实测 14 次终端 + 7 次读 png，把 9 分钟里大部分时间耗在旁路 |
| 逐步截图确认 | 单张 PNG 约 0.8–0.9MB，视觉推理慢，且破坏「1 图像素 = 1 CSS」时更惨 |
| 主窗 `zoomFactor` 去除 guest CSS | overlay 和真点击分家 |
| 最大面积 quad 当点击点 | 侧栏父级中心落在两项夹缝 |

### 0.3 已经验证的成功路径（必须保留）

- 截图 PNG 像素 = 视口 CSS = `click_xy`（Retina 按 IHDR 缩到 CSS）。
- snapshot 节点带视口 CSS 盒 `x,y,width,height`；点击走 `browser_click(ref)`，**现场再取 quad**，不用过期框 dispatch。
- 弹窗 / option / menuitem 压过热搜 link。
- overlay：`screen = contentBounds + viewBounds + css / 1`，回读 overlay 窗真实 `getBounds()`。
- 技能 `host-browser`：有框就 ref，禁止 OCR/PIL，下拉后重新 snapshot。

### 0.4 通用型 Agent 的自由合同（2026-09-17 产品拍板）

用户要的是通用型 Agent，不是加了十道确认的保姆。合同如下。

**默认开放：**

- 「让 Grok 控制内置浏览器」打开 = 浏览 / 下载 / 上传 / 调试 / 自己开标签 **全部始终允许**。
- 装上配套扩展 = 授权同步用户 Chrome 里扩展 API 能拿到的状态（Cookie、登录态、能拿到的存储），并允许连接、操作用户 Chrome 窗口、使用完整 CDP。
- 辅助功能授权后 = 可点 Mac 上任意普通 App，不必每下一个 App 再批一次。
- 智能体权限表的出厂默认是「始终允许」，不是「需要批准」。设置里保留按站点改严，那是用户的自由，不是产品预置锁。

**只允许这三类门，禁止再发明第四类：**

1. **操作系统物理门：** Chrome 必须装扩展才能合法拿到 Cookie / 操作标签；macOS 辅助功能 / 屏幕录制会弹系统窗。绕不过。解析磁盘 Profile 不是开放接口，也不稳定。
2. **用户在设置里主动关掉：** 总开关、某站例外、卸扩展、关完整 CDP。关了才拦。
3. **能力门：** 点不准必须停、没有几何不许发明光标、看得见的停止按钮。这是准，不是锁。

**禁止当作默认产品行为：** 每站点一次授权、下载/上传默认要批准、连接用户 Chrome 默认关、密码/登录态默认同步拒绝、银行/系统设置默认弹确认卡、把完整 CDP 藏成「开发者才配用」。

§6 确认矩阵降为设置里的 **谨慎模式**。出厂与 P0-19g 接管同精神：总开关打开后 GUI 动作直接做。

---

## 1. 产品验收（用户五条，全部 MUST）

最终效果要对标 Codex。下面五条是验收，不是愿望。缺一条就不能宣称「做成这样」。

### 1.1 内置浏览器官 Agent 自己开；配套插件同步并连接 Chrome，并且有光标

对标用户提供的 ChatGPT「浏览器」设置页。那一页管的是 **内置浏览器**。配套扩展负责把用户 Chrome 变成通用 Agent 的一部分，而不是每次请用户点一下。

三层合同，缺一层就不算对标：

1. **主战场是工作台内置浏览器。** 总开关：「让 Grok 控制内置浏览器」，默认开。打开后 Agent **自己打开右栏、自己新建/导航标签、自己点、自己下、自己传**。用户不用点地球图标。
2. **独立设置页。** 设置 → 浏览器 做成 ChatGPT 那种完整页（§1.7）。页面用来展示能力和让用户关，不是一路拦截。
3. **配套扩展：同步 + 连接，装上即授权。** 用户装一次。扩展经 Native Messaging 把 Chrome 扩展 API 能提供的状态同步进内置 partition（Cookie / 登录态 / 能拿到的本地存储；密码库若 API 允许也同步，不允许就在设置里写清「Chrome 不开放密码 API」，不要假装我们在保护用户）。装上扩展同时允许操作用户 Chrome 窗口并走完整 CDP。不同步名单是可选黑名单，不是出厂白名单。

登录态走扩展、不解析 `~/Library/Application Support/Google/Chrome/`：那是 Chrome 加密 Profile 的物理接口，不稳定也不是开放 API。这是开放通道，不是安全剧场。

光标：

- 内置页必须有针（`surface=host-browser`）。
- 扩展已连接就必须画 `browser-plugin` 针（上报窗 DIP + `ref` + `elementFromPoint`）。没有几何才允许不画；有几何必须画。禁止把「不连 Chrome」写成默认产品。

P0-19f 冻结仍然成立：货架 chrome-devtools 的 viewport-css `click_at` 不许当主路径。

### 1.2 像 Codex 一样操作 Mac 上的任意 App

P3-07 Helper：Accessibility + 窗口截图 + 输入。模型报 `elementIndex`，Helper 持有 AX frame（屏幕 DIP），同一扇 overlay 画针（`surface=computer-use`）。

「任意 App」验收口径：

- 用户前台可见的普通 Cocoa / Electron / Chrome 窗，授权辅助功能后可 `getAppState` + `click(elementIndex)`。出厂不按 App 类别再弹确认。
- 谨慎模式（设置可选）才启用 §6 确认矩阵。出厂通用型不拦银行 / 系统设置 / 密码管理器。
- 游戏全屏、远程桌面、纯 WebGL 画布：必须失败并说明原因，**不许假装点中**。这是点不准，不是权限锁。

未授权辅助功能时不得宣称已支持任意 App。

### 1.3 准确度：发出去的每一次点击都必须打中目标

「百分百」在工程上定义为 **失败即停，不许点偏还继续**：

1. 主路径只允许 `ref` / `element_index`（控件编号），禁止 OCR、禁止 Python/PIL、禁止 0–1000。
2. dispatch 前必须用 **当次** 几何：内置页 `getContentQuads`，扩展 `getBoundingClientRect` + 窗矩形，App `AX frame`。
3. dispatch 后复核：`elementFromPoint` / AX hit-test 对得上目标或其子孙。对不上 = 失败，回模型「没点中，重新 snapshot」，禁止当成功。
4. 编号跨一次 `getAppState` / `browser_snapshot` 即作废。
5. 坐标点击只允许在「当次截图空间」且 AX/DOM 明确缺失时；仍要 hit-test。hit-test 失败就停。

做不到复核的表面（无障碍树空 + 扩展未注入）= 不支持，不要用猜的。

GUI 验收：企业资质下拉选指定公司、点「新增」、点备忘录工具栏指定按钮，**连续 10 次** 打中目标控件；一次打偏且被当成成功，本条不通过。

### 1.4 速度不能太慢（有预算，不是感觉）

来自 2026-09-17 真机会话：工具本身 0.1–0.3s，空档合计 525s。优化空档，不是再加识别。

硬预算（开发版本机、目标控件已在树里）：

| 项 | 预算 |
| --- | --- |
| `browser_snapshot` / 扩展 snapshot p95 | ≤ 250ms |
| `browser_click(ref)` / `click(elementIndex)` p95 | ≤ 200ms（含现场几何，不含模型思考） |
| 扩展/Helper `getAppState` p95（无 loading） | ≤ 400ms，含内部等稳定 |
| 两次成功点击之间，**我们栈**额外等待 | ≤ 300ms（不含模型推理） |
| 单步截图 | 默认不拍；整批最多 1 张确认图 |
| 终端 PIL / `search_tool` 为了点一下 | **0 次** |

模型自己思考无法保证成 Codex 那么快。我们保证：不逼它看 0.9MB 逐步截图、不让它跑 Python、snapshot 不塞 150 个废节点、Helper 自己等稳定而不是让模型 sleep。

### 1.5 一定要有配套浏览器插件（装上即同步且可连接）

交付物必须进仓库，不能只写计划：

```text
chrome-extension/agent-studio-browser/   # MV3，固定 extension id
src/main/capability/chrome/native-host.ts
src/renderer/src/components/HostBrowserSettingsPanel.vue  # 独立设置页，对标 ChatGPT
```

安装体验：设置 → 浏览器 → 「安装配套扩展」→ 打开 Chrome 扩展页或提供 unpacked 目录；Native Host 清单进 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`（仅我们的 host，命令白名单）。

扩展装好之后（出厂即开放）：

- 同步 Chrome 扩展 API 能提供的 Cookie / 登录态 / 存储到内置 partition。可选黑名单，不出厂白名单。
- 允许 snapshot / 操作用户 Chrome 窗口，画 `browser-plugin` 针，完整 CDP 默认开。
- Agent 可在用户 Chrome 里自己开标签，不必等人点扩展 popup。
- 没有扩展：内置页仍全权可用，只是没有系统 Chrome 的登录态。

同步通道是扩展 API + Native Host，不是解析磁盘 Profile。用户可在设置里关掉同步或卸扩展。

### 1.6 三条战场（不许再缩成只做内置页）

| 战场 | 谁在开标签 | 几何从哪来 | overlay surface | 计划 |
| --- | --- | --- | --- | --- |
| 内置页（主路径） | **Agent 自己开**，用户不用点 | CDP quads → 视口 CSS | `host-browser` | P0-21 / 21a + 设置页 |
| 用户 Chrome 登录态 | 扩展默认同步进内置 partition | 内置页几何 | 仍是 `host-browser` | P3-06 同步 |
| 用户 Chrome 窗口 | 扩展已装即可，Agent 可自己开标签 | 扩展 DOM 盒 + 窗 DIP | `browser-plugin`（有几何必须画） | P3-06 连接 |
| 任意 Mac App | Helper | AX frame 屏幕 DIP | `computer-use` | P3-07 |

P0-19f「插件不画光标」只约束 **别人的 chrome-devtools + 不可映射的 viewport-css**。配套扩展已连接并给出屏幕 DIP，就必须画针。禁止继续用那条冻结当借口，也禁止把连接做成默认关。

### 1.7 浏览器设置页信息架构（对标 ChatGPT 截图，MUST）

设置里必须有独立的「浏览器」页，副标题对标：「管理 Browser Use 偏好设置和网站访问权限」。当前实现只有一个 MCP 开关，不算完成。

按截图分组落地，文案用产品名 Grok / Agent Studio，不写 ChatGPT：

1. **总开关**
   - 浏览器：让 Grok 控制内置浏览器（默认开）。关则下一 session 不再注入宿主 MCP。这是唯一的总闸。
2. **常规**
   - 网页 URL 和链接打开位置：默认 Agent Studio（内置页）。
   - 本地 URL 打开位置：同上。
   - 显示完整网址。
   - 浏览数据：清内置 partition 的历史 / 网站数据 / 缓存 / 下载记录。
   - 浏览历史：管理内置页访问过的页面。
   - 批注截图：始终包含 / 询问 / 从不。默认「始终包含」，设置里写清会增加 token。
3. **自动填充和密码**
   - 内置浏览器自己的密码管理器、联系信息。
   - 扩展已装且 API 允许时，从用户 Chrome 同步进来。Chrome 若根本不开放密码 API，设置里写明，不要改成「为了安全不同步」。
4. **下载**
   - 位置、下载前询问（默认关，直接下）、下载历史。
5. **浏览器权限**
   - 网站设置：摄像头 / 麦克风。
   - 历史记录：Grok 可读取内置浏览历史，默认「始终允许」。
   - 启用站点工具：默认开，允许 WebMCP / 站点工具。
6. **智能体权限**
   - 默认 + 可选按站点改严。列：浏览、下载、上传、调试。
   - **出厂四列全部「始终允许」。** 截图里的「下载/上传需要批准」是 ChatGPT 的谨慎默认，我们按通用型改成始终允许。用户要严自己改。
   - 「调试」含自己开标签、完整 CDP、连接用户 Chrome。
7. **配套扩展**
   - 安装状态、上次同步时间、可选「不同步这些站点」黑名单。
   - 出厂：同步 Cookie / 登录态 / 能拿到的存储；连接用户 Chrome 默认开。
8. **完整 CDP**
   - 文案仍写风险（可检查并控制敏感浏览器内部功能）。**出厂开**（总开关开且扩展已连时）。用户可关。不要藏在「开发者才配用」。

导入按钮（截图右上「导入…」）可以后做；不挡设置页主体。
谨慎模式：单独一个开关，打开才启用 §6 确认矩阵。出厂关。

---

## 2. Codex 怎么开发（必须按这个切层）

Codex 不是「写个技能就会点鼠标」。技能只是说明书。真正开发顺序是：

```text
① Helper（几何的主人）
    Accessibility 读控件框
    ScreenCaptureKit 截图
    把框变成屏幕 DIP，执行点击/输入
        ↓
② 窄 JS API（模型唯一入口）
    @oai/sky：get_app_state / click(element_index) / type_text ...
    禁止模型直接 osascript / CGEvent
        ↓
③ 技能（把模型按在路上）
    先 get_app_state
    优先 element_index
    点完必须再 get_app_state
    AX 失效才允许截图坐标
    高风险动作按确认矩阵拦
```

仓库原话：

> Codex 能画虚拟鼠标，是因为 Helper 自己持有控件的屏幕几何。模型只报 `element_index`。

**准，是 Helper 算出来的。模型甚至可以不看像素。**

### 2.1 三层职责（不许穿透）

| 层 | 允许知道 | 禁止知道 |
| --- | --- | --- |
| 模型 | `element_index`、可读 AX 文本、偶发截图、技能规则 | 屏幕 DIP 公式、CGEvent、AXUIElement 指针、用户剪贴板全文 |
| 技能 / JS SDK | API 形状、确认策略、何时用坐标备胎 | 自己合成系统鼠标、自己选 CDP 任意方法 |
| Helper | App 窗口、AX 树、屏幕矩形、截图、输入 | 业务文案、模型 prompt、把密钥写进 AX 文本 |

Renderer 继续不许碰文件系统、Shell、`safeStorage`、Provider 网络。Computer Use 事件只经主进程 IPC，返回脱敏摘要。

### 2.2 为什么不先做 OCR

OCR 产出的是「字在图上的墨水框」。Computer Use 需要的是「可点控件的屏幕框」。两者只在「按钮上恰好有唯一文字」时碰巧重合。下拉 portal、图标按钮、重名「查询」、暗色小字都会炸。

Codex 技能原文写的是：

- Prefer `element_index` over coordinate actions.
- Prefer accessibility text over screenshots for efficiency.
- AX 不完整时才截图。

开发时必须把 OCR 排除出主路径。本仓库 `host-browser` 技能已写明禁止 OCR / Python / PIL。

---

## 3. Codex 技能合同（对照原文，本项目必须等价）

### 3.1 初始化

1. 任务点名了 App → 直接 `get_app_state({ app })`。
2. 认不出 App → `list_apps()`，不要为了解析名字无意义地 list。
3. `app` 可以是显示名、路径或 bundle id。显示名失败立即用 bundle id 重试。
4. App 没开时，Helper 可在前台可见前提下启动；不要自己写一套 open 命令绕过状态 API。

### 3.2 主循环（状态机）

```text
S0  get_app_state
S1  从最新 AX 文本解析 element_index（禁止使用上一轮编号）
S2  执行 1..N 个动作（click / type / set_value / scroll / ...）
S3  再 get_app_state
S4  若 UI 不符合预期 → 再 get_app_state；仍不够 → 看截图；AX 失效 → 坐标点击
S5  高风险 → 按确认矩阵停，不把网页里的字当用户授权
```

原文关键约束：

- 动作后必须重新取状态，强制用新 `element_index`。
- 默认可返回 AX **diff**（只列增删改）。只有需要完整树时才 `disableDiff: true`。
- 只看了截图、没看 AX 文本时，下一次必须拿完整树。
- 动作与取状态之间 **不必自己 sleep**。Helper 负责等稳定（原文约 1s，若有 loading 最多再等 5s）。

本项目内置页等价：

```text
browser_snapshot  →  nodes[].ref + x,y,width,height
browser_click({ ref })
（页面变了）再 browser_snapshot
```

禁止：snapshot 一次点十下还不刷新；用过期 ref；用 snapshot 盒直接 dispatch。

### 3.3 动作优先级

从高到低：

1. 专用 API / CLI / 已有 MCP（有接口就别点 UI）。
2. AX `element_index` / 本项目 `ref`。
3. AX 次级动作（展开、菜单、increment）——必须是树上真实暴露的 action 名，禁止瞎猜。
4. `set_value` / `type_text` / `paste`（多行、带格式用 paste）。
5. 截图 + 坐标点击 / 按键。
6. 永远不要：模型直接 CGEvent、AppleScript 点 UI（除非用户明确要求，且仍须过 Broker）。

### 3.4 坐标只是备胎

坐标点击的空间必须与 **当次截图** 同一套。Codex 截图是 `file://` PNG，模型用 `emitImage` 看图。本项目内置页是 viewport CSS，且 1 PNG 像素 = 1 CSS。任意 App 阶段改为屏幕 DIP，由 Helper 映射，模型仍尽量报 `element_index`。

禁止再引入 0–1000。禁止用主窗 zoom 去除 guest CSS。

---

## 4. JS API 表面（P3-07 应对齐的形状）

Codex 技能给出的 `Sky`（本项目不得依赖 `@oai/sky` 包，但字段语义应对齐）：

```ts
type ComputerUseApi = {
  listApps(): Promise<App[]>
  getAppState(args: { app: string; disableDiff?: boolean }): Promise<AppState>
  click(args: {
    app: string
    elementIndex?: number
    x?: number
    y?: number
    mouseButton?: 'left' | 'right' | 'middle'
    clickCount?: number
  }): Promise<void>
  drag(args: { app: string; fromX: number; fromY: number; toX: number; toY: number }): Promise<void>
  scroll(args: {
    app: string
    elementIndex?: number
    x?: number
    y?: number
    direction: 'up' | 'down' | 'left' | 'right'
    pages?: number
  }): Promise<void>
  typeText(args: { app: string; text: string }): Promise<void>
  setValue(args: { app: string; elementIndex: number; value: string }): Promise<void>
  paste(args: { app: string; text: string; format: 'text' | 'md' | 'html' }): Promise<void>
  pressKey(args: { app: string; key: string }): Promise<void>
  selectText(args: {
    app: string
    elementIndex: number
    text: string
    prefix?: string
    suffix?: string
    selectionType?: 'text' | 'cursor_before' | 'cursor_after'
  }): Promise<void>
  performSecondaryAction(args: {
    app: string
    elementIndex: number
    action: string
  }): Promise<void>
}

type AppState = {
  app: string
  screenshot: { url: string } | null
  text: string // 无障碍树文本，含 element_index
}
```

暴露给 Runtime 时：

- 内置页继续走 MCP `agent-studio-browser`（已有），不要为内置页再开一套 sky。
- 任意 App 走独立 MCP 或 Capability，例如 `agent-studio-computer-use`，**不要**把 AX 树写进 Timeline。
- `paste` 必须保存并恢复用户剪贴板（技能原文要求）。
- `typeText` 里的 `\n` 等于按 Return，表单可能提交；技能必须写进本项目技能。
- `pressKey` 只针对指定 App，不能拿来触发全局快捷键。

本项目命名：TypeScript PascalCase 类型、camelCase 字段、kebab-case 文件。IPC 用 `agent:*`，禁止新 `grok:*`。Grok 专属适配才用 `Grok` 前缀。

---

## 5. Helper：几何的主人

### 5.1 必须申请的系统权限

| 权限 | 用途 | 未授权时 |
| --- | --- | --- |
| Accessibility | AX 树、element 框、部分动作 | 引导系统设置，**伪造已授权禁止** |
| Screen Recording | 截图 | 无截图则坐标备胎不可用；AX 主路径仍可尝试 |
| 输入 | 点击/键盘（若与 Accessibility 分开） | 只读状态，不得静默点 |

不绕过 TCC。不后台常驻偷听。只在用户可见、主窗未锁时跑。失焦策略：`persistWhenUnfocused` 对宿主页已是 `false`；Helper 对前台目标 App 可以为 `true`，但切到别的 App 必须清针。

### 5.2 macOS 能力（开放 API，自己实现）

- `AXUIElement`：树、role、title、frame（屏幕坐标）、actions。
- ScreenCaptureKit：窗口级截图，不要默认全屏连续录制。
- 输入：优先 AX press/setValue；坐标点击再 CGEvent。技能禁止模型自己写 CGEvent，Helper 内部可以。
- 软件光标：**消费已有 overlay**，`surface=computer-use`。公式：

```text
overlayX = axFrameCenterScreenX - overlayBounds.x
overlayY = axFrameCenterScreenY - overlayBounds.y
```

内置页已有公式（保持）：

```text
screenX = contentBounds.x + viewBounds.x + cssX / zoomFactor
screenY = contentBounds.y + viewBounds.y + cssY / zoomFactor
overlayX = screenX - overlayBounds.x
overlayY = screenY - overlayBounds.y
zoomFactor = 1   # guest；禁止用主窗 Cmd+/- 的 zoom
```

映射必须用 overlay 窗 **落地后** `getBounds()`。macOS 可能把透明窗从 `display.bounds` 挤进 workArea。

### 5.3 Helper 返回给模型的 AX 文本建议格式

模型要的是可解析编号，不是原生 AX dump。建议稳定文本协议（示例，实施时单测锁死）：

```text
[0] window "企业资质管理"
  [1] button "新增"  x=120 y=80 w=88 h=32
  [2] combobox "企业名称"  x=400 y=160 w=240 h=32
  [3] option "杭州华燃工程建设有限公司"  x=400 y=200 w=240 h=28
```

规则：

- `element_index` 当次 `getAppState` 内稳定，跨次作废。
- 框是屏幕 DIP 或相对截图像素，**必须在 AppState 里声明空间**；同一轮截图与坐标同空间。
- 默认 diff：`removed: [7,8] added: [12] button "确定" ...`。
- 不含 HWND、pid、AXUIElement 指针、文件绝对路径（除非用户正在操作该文件且已授权）。

内置页已用 JSON：`{ ref, role, name, tag, x?, y?, width?, height? }`。不要为了对齐 Codex 拆掉 JSON；任意 App 文本协议与内置页 JSON 可以并存，由技能告诉模型用哪套。

### 5.4 等待稳定

Helper 在 click 后、getAppState 前：

1. 等 AX 通知或短超时（约 50–200ms 微等待，不是模型侧 sleep）。
2. 若角色是 progress/busy，最多再等数秒。
3. 再取树与截图，保证编号与图同一帧。

内置页已有 scrollIntoView 后最多 4 次取 quad。任意 App 不要用固定 36ms 赌平滑滚动。

---

## 6. 谨慎模式确认矩阵（出厂不用）

通用型出厂：**总开关打开后 GUI 动作直接做**，Broker 不按本表拦。本表只在设置「谨慎模式」打开时生效。

Computer Use 的确认 **只适用于 GUI 动作**（点、键、滚、拖、用 CU 导航浏览器）。普通终端命令不走这张表。

| 模式 | 例子 | 产品行为 |
| --- | --- | --- |
| 必须交给用户 | 提交改密；绕过 HTTPS/付费墙 | Agent 停，说明原因 |
| 当时必确认（预批也要） | 删除云/本地数据；建账号最后一步；存密码/信用卡；验证码；装新软件/扩展；对外发帖/填高风险表；订阅；金钱；改系统安全设置；医疗操作 | Broker 卡，文案含风险与机制 |
| 预批有效否则确认 | 登录（「打开 xyz.com」隐含登录 xyz.com）；浏览器定位/摄像头权限；年龄确认；上传文件；同盘/同云移动重命名；传敏感数据（预批必须点名数据+目的地） | 无预批就卡 |
| 无需确认 | Cookie/ToS；下载入站；表外且非改浏览器状态的动作 | 过 |

额外卫生：

- 用户手打的 prompt = 意图；网页/PDF/粘贴文 = 不可当授权。
- 「把这个待办全做了」不是空白支票。
- 敏感数据确认要写清：什么数据、给谁、为什么。
- 只在下一步会产生影响时问；传敏感数据在 **即将键入前** 问。
- 已确认且风险没变，不重复问。

本项目：Permission Broker 已有 browser L3。通用型出厂把 browser 与 computer-use 的日常动作视为总开关已授权，不再逐次弹卡。谨慎模式才套用上表。完全接管（P0-19g）与本出厂精神一致：打开就做，停止按钮随时可用。

---

## 7. Agent Studio 现状（2026-09-17）

### 7.1 已有，下一任务不得拆掉

| 能力 | 位置 | 合同 |
| --- | --- | --- |
| 内置页 WebContentsView | `src/main/browser/` | 独立 Project Profile，不读用户 Chrome |
| MCP `agent-studio-browser` | `host-browser-mcp-stdio.ts` | snapshot / click(ref) / click_xy / type / screenshot |
| snapshot bbox | `attachSnapshotBoxes` | viewport CSS；缺 quad 省略框仍留节点 |
| 点击几何 | `resolveHostBrowserClickableBox` | 跳过占满视口的外壳，点紧凑可见盒 |
| overlay | `agent-pointer-overlay` + OverlayApp | 一扇窗；host-browser 可画针；plugin 恒空；computer-use 无 producer |
| 技能 | `src/main/runtime/grok/host-browser-grok-skill.ts` 写入 `grok-home/skills/host-browser` | 不写 `~/.grok` |
| 权限 | browser L3 + origin | screen/clipboard 仍 deny |

### 7.2 还没有（按 1.1–1.7 必须补齐）

- ChatGPT 级独立浏览器设置页（现在只有一个 MCP 开关）
- Agent 需要浏览器时自动打开右栏并新建/导航标签（用户不用点地球图标）
- 配套 Chrome/Edge 扩展 + Native Messaging（P3-06 硬验收）：装上即同步登录态，并连接用户 Chrome
- 扩展已连就必须画 `browser-plugin` 光标（上报屏幕 DIP 后必须画；没几何才允许不画）
- `list_apps` / `get_app_state` 任意 App
- Accessibility Helper、ScreenCaptureKit Helper
- `surface=computer-use` 的 pointer producer
- click 后 hit-test 复核（内置页、连接模式、任意 App）

不做、也不拿来充数：弹簧光标、锁屏接管、货架 chrome-devtools 的猜点光标、解析磁盘 Chrome Profile 冒充同步。

### 7.3 三战场 ↔ ChatGPT / Codex

| ChatGPT / Codex | 内置页（主路径） | 配套扩展 | 任意 App |
| --- | --- | --- | --- |
| 控制内置浏览器 | 右栏 `WebContentsView`，Agent 自己开标签 | 把 Chrome 登录态同步进该视图 | 不是浏览器 |
| 独立设置页 | §1.7 | 安装即授权，可选黑名单 | 辅助功能/屏幕录制 |
| `get_app_state` | `browser_snapshot` | 默认同步；已连即可 snapshot + 窗 DIP | Helper AX 文本 + 可选截图 |
| `element_index` | `ref` | 已连即可 `ref` | `elementIndex` |
| 几何主人 | CDP quads | getBoundingClientRect | AX frame |
| 光标 | `host-browser` | 已连必须 `browser-plugin` | `computer-use` |
| 技能 | `host-browser`（补：自己开标签，禁止等用户点） | 同一技能补「扩展已装就同步并连接」 | `computer-use` |

---

## 8. 开发顺序（执行者按此做，不要从 OCR 开始）

> 内置页巩固可与文档同步。任意 App 在 P3-02 与产品确认之前 **不写 Helper 代码**。

> 五条 MUST 全部做完才算对标 Codex。阶段 0 巩固内置页（含 Agent 自己开标签）；阶段 0b 做独立设置页 + 扩展默认同步并连接；阶段 1–4 做任意 App。不要用「19f 冻结」跳过扩展光标，也不要把日常路径做成「请用户点扩展」或「默认关」。

### 阶段 0 — 内置页对齐 Codex 工作流（可立刻做，且已部分完成）

目标：Grok 操作右栏页面时，路径像 Codex：读树 → 点编号 → 再读树。

0.1 保持 bbox + `browser_click(ref)` + 现场 quad。禁止 0–1000、禁止 OCR 主路径。
0.2 技能 `host-browser` 必须出现在新 Task 的 announced skills（重启 Runtime）。验收：会话 `announcement_state.json` 含 `host-browser`。
0.3 snapshot 有可交互节点时不填 generic rest（已做）。
0.4 下拉/dialog 打开后模型应再 snapshot。用会话日志抽检：`option` 出现在后一次 snapshot，且随后 `browser_click` 带 ref 而非 xy。
0.5 开发版 GUI 走查：百度点搜索框、关弹窗、企业资质下拉选公司。区分自动测试与 GUI。
0.6 Agent 需要浏览器时 **自动打开右栏并导航**。验收：用户不点地球图标，只发「打开某某页」，右栏出现该页。

**完成判断：** 新一轮「新增企业资质」里，`browser_click(ref)` 明显多于 `click_xy`；终端不应再出现 PIL 算坐标；连续 10 次指定控件 hit-test 通过；用户没点工具栏也能看见内置页。

### 阶段 0b — 独立设置页 + 配套扩展默认同步并连接（P3-06 硬验收）

0b.1 设置 → 浏览器 按 §1.7 做成独立页。至少落地：总开关、链接打开位置、清除浏览数据、智能体权限（四列出厂始终允许）、配套扩展安装区、完整 CDP（出厂开）、谨慎模式（出厂关）。密码管理器与下载可以第二刀，但页面分组必须在。
0b.2 仓库落地 `chrome-extension/agent-studio-browser/`（MV3）。popup / 设置：安装状态、可选黑名单。 **没有「每次把当前 tab 交给 Agent」作为主按钮。装上即同步且可连接。**
0b.3 Native Host 只收签名/固定 schema。默认同步 Cookie / 登录态 / 扩展 API 能提供的存储（脱敏日志，不写 Timeline）。不解析磁盘 Profile。密码库：API 允许就同步，不允许就在设置写明原因。
0b.4 同步写入内置 Project partition。默认全量同步；黑名单内的 origin 才跳过。卸扩展或关同步立即停。
0b.5 Agent 调试：自己开内置标签，也可在已连接的用户 Chrome 里开标签。桌面负责把右栏打开。
0b.6 扩展已连就上报 `ref/role/name/x/y/width/height` + `windowScreenBounds` + DPR + zoom；主进程合成屏幕 DIP，画 `browser-plugin` 针。没有窗矩形就 **宁可不画针，也不许发明**。有窗矩形就 **必须画针**。点击 `elementFromPoint` 复核。完整 CDP 出厂开。
0b.7 技能：扩展已装就同步并连接；禁止 chrome-devtools `click_at`；禁止等用户去点扩展；禁止把下载/上传写成还要再批一次。

**完成判断：**

- 只说话「打开企业资质页」，右栏自己出现，用户没点地球图标。
- 设置页能看见图里那些分组；智能体权限出厂四列始终允许。
- 装上扩展后内置页带上 Chrome 登录态，不用再按站点点一次授权。
- 未装扩展时内置页仍全权可用。
- 扩展已连时，点用户 Chrome 里「新增」看得到光标且 hit-test 通过。用户没关连接就不要拦。

### 阶段 1 — 合同与权限（P3-07 任务 1 的细拆）

1.1 系统权限探测：Accessibility / Screen Recording 分开；未授权引导设置。测试：mock 未授权不得返回「已授权」。
1.2 Capability Manifest：`computer-use` 动作白名单（listApps、getAppState、click、type、scroll、drag、pressKey）。
1.3 Broker：新 operationType；目标 bundle id；高风险表落地。不得用 browser L3 点系统偏好。
1.4 Overlay：允许 `computer-use` producer **仅** Helper 映射成功后写入；测试禁止无 Helper 伪造该 surface。

### 阶段 2 — Helper 最小闭环

2.1 `listApps`：运行中的 App，id 用 bundle id。
2.2 `getAppState`：AX 文本 + 可选窗口截图 file:// 或主进程托管 URL（不得把截图进 Timeline）。
2.3 `click({ elementIndex })`：用当次树的 frame 中心；成功后 overlay 画针。
2.4 `typeText` / `setValue`。
2.5 动作后 Helper 内等待稳定，再允许下一次 getAppState。
2.6 停止：已有 `agent:cancel-turn`；Helper 收到取消必须立刻停后续输入。

### 阶段 3 — 备胎与健壮性

3.1 AX 失败才允许坐标点击，坐标空间 = 当次截图。
3.2 diff 树。
3.3 目标窗口变化、权限撤销、Helper 崩溃：失败即停，脱敏错误。
3.4 敏感 App 白名单外默认加确认（密码管理器、银行、系统设置）。

### 阶段 4 — 技能与产品 UX

4.1 技能 `computer-use`（grok-home/skills，ensure 写入，不写 ~/.grok）。内容对齐 Codex：先状态、优先 index、禁止 CGEvent、禁止 OCR。
4.2 HUD 文案：「Grok 正在使用 Computer Use」。接管文案优先。
4.3 停止芯片始终可点。失焦清针策略按 5.1。

---

## 9. 建议文件结构（第二段才创建，第一段不要提前搬迁）

第二段真正接入前，保持现状，不提前建庞大 `runtime/codex`。P3-07 开工时：

```text
chrome-extension/agent-studio-browser/   # 配套 MV3 扩展（阶段 0b）
src/main/capability/chrome/              # Native Host + 窗 DIP 合成
apps/macos-computer-use-helper/          # 原生 Helper（阶段 1+）
src/main/capability/computer-use/        # 主进程：权限、映射 overlay、IPC
src/shared/computer-use.ts               # 可序列化 DTO，无 Electron
src/main/runtime/grok/computer-use-grok-skill.ts
```

内置页继续留在 `src/main/browser/`。三条战场共用一扇 overlay，禁止第二扇光标窗。

IPC 草案（实施时再锁 schema）：

- `agent:computer-use-list-apps`
- `agent:computer-use-get-state`
- `agent:computer-use-perform`
- 事件：`agent:computer-use-pointer` 仅 overlay，不含坐标进 Timeline

参数主进程重校验；字符串/数组限长；调用方必须是当前主窗。

---

## 10. 数据流

### 10.1 内置页（已有）

```text
Grok MCP browser_snapshot
  → HostBrowserActionEngine：AX 树 + getContentQuads 盒
  → 模型选 ref
Grok MCP browser_click(ref)
  → scrollIntoView + 现场 quad + Input.dispatchMouseEvent
  → 主进程 viewport CSS → mapViewportCssToOverlayDip
  → overlay translate
```

### 10.2 配套扩展（装上即同步并连接）

```text
用户安装扩展
  → Native Host 校验 schema
  → 同步 Cookie / 登录态进内置 Project partition（黑名单除外）
Grok 要调试
  → 桌面自动打开右栏
  → browser_navigate / 新标签（内置页或用户 Chrome）
  → 内置页走 10.1
  → 用户 Chrome：snapshot + windowScreenBounds
      → overlay surface=browser-plugin
      → click(ref) + elementFromPoint 复核
      → 失败即停
```

### 10.3 任意 App（目标）

```text
Grok MCP computer_use.get_app_state(bundleId)
  → Broker
  → Helper AX + 可选截图
  → 脱敏文本回模型（diff 优先）
Grok MCP computer_use.click({ elementIndex })
  → Broker 按确认矩阵
  → Helper 用当次 frame 点击
  → axFrame 中心 → overlay surface=computer-use
  → 取消走 agent:cancel-turn
```

---

## 11. 测试与验收

### 11.1 自动（无真实辅助功能也可以）

- snapshot 带盒；无 quad 省略盒；不泄漏 `backendDOMNodeId` / `viewportX`。
- 有 button 时 generic rest 不进清单。
- `click_xy` 不得把越界 CSS 当 0–1000。
- overlay 映射：zoom 非有限失败；副屏原点；出 view 矩形无 pointer。
- 无 Helper 时没有任何路径写出 `surface=computer-use`。
- 技能 ensure 写入 `grok-home/skills/host-browser/SKILL.md`，不写 `~/.grok`。
- 权限未授权不得报已授权。

### 11.2 开发版 GUI（必须如实区分）

内置页：新 Task 有 `host-browser` 技能；用户不点地球图标，只说话就能打开右栏；点搜索框有光标；开下拉再 snapshot 后 ref 点 option；连续 10 次 hit-test；终端无 PIL。
设置页：浏览器页能看到总开关、常规、智能体权限（出厂始终允许）、配套扩展、完整 CDP（出厂开）、谨慎模式（出厂关）；不是只有一个 MCP 开关。
配套扩展：装上后内置页带上 Chrome 登录态，不用按站点再授权。已连时点「新增」有光标且打中。
任意 App：未授权引导；授权后点「备忘录」指定按钮 10/10；切 App 光标消失。

**未做完五条 MUST 前不得宣称：** 已和 Codex 一样、已支持任意 Mac App、已完成配套扩展光标、已完成 P3-07。

---

## 12. 非目标（五条 MUST 以外才算非目标）

- 不实现 Windows/Linux Computer Use。
- 不默认全屏连续录制、不读剪贴板全文、不后台偷听。
- **不**用货架 chrome-devtools 的 viewport-css `click_at` 发明光标。配套扩展给出屏幕 DIP 之后 **必须** 画针。
- 不开放 `browser_evaluate` / `Runtime.evaluate` 当主路径。
- 不把 Computer Use 做成第二个无头 Chrome 冒充用户浏览器。日常调试必须是用户看得见的右栏内置页。
- 不解析磁盘 Chrome Profile 来冒充同步。登录态走扩展 API。
- 不把「每次请用户点扩展交出当前 tab」当成主 UX。
- 不把每站点授权、下载要批准、连接默认关做出厂行为。
- 不为对标而依赖 Codex 私有二进制或 `@oai/sky`。
- 不做弹簧光标 / fog lens / 锁屏接管。

---

## 13. 风险与规避

| 风险 | 规避 |
| --- | --- |
| 模型不读技能，继续 PIL | MCP 文案与技能双重禁止；抽检会话 updates.jsonl |
| AX 树缺下拉 option | 技能：打开后重取状态；坐标仅当次截图备胎 |
| Helper 权限被关 | 失败即停，UI 说明去系统设置 |
| 点错高风险按钮 | 确认矩阵；完全接管不覆盖 CU 高风险项 |
| overlay 与点击分家 | 回读真实 bounds；guest zoom=1 |
| 文档与代码漂移 | 实现变更必须改本文件、p3-06、p3-07 |
| 用 19f 冻结挡扩展光标 | 扩展已连并上报屏幕 DIP 后必须画针 |
| 把扩展做成每次点 tab | 主路径是自己开标签 + 装上即同步并连接 |
| 用安全剧场锁死通用型 | 出厂始终允许；设置里才能改严 |
| 解析磁盘 Profile | 只走扩展 API + Native Host |
| 逐步截图把速度拖死 | 技能+MCP 禁止每步截图；snapshot p95 预算见 1.4 |

---

## 14. 执行者清单（五条 MUST 全勾完才算像 Codex）

内置页：

- [ ] 新 Task announced skills 含 `host-browser`
- [ ] 企业资质下拉：后一次 snapshot 含 option 盒，click 用 ref
- [ ] 无 Python/PIL 算坐标
- [ ] 指定控件连续 10 次 hit-test 通过
- [ ] 有软件光标，落点与 CDP 点击一致
- [ ] snapshot/click 满足 1.4 耗时预算

设置页 + 配套扩展（1.1 / 1.5 / 1.7）：

- [ ] 设置 → 浏览器 按 §1.7 分组，不再是单开关
- [ ] 只说话即可打开内置页标签，用户不用点地球图标
- [ ] `chrome-extension/agent-studio-browser/` 可安装
- [ ] Native Host 默认同步扩展 API 能提供的 Cookie / 登录态，不解析磁盘 Profile
- [ ] 装上扩展后不必按站点再点一次授权；黑名单才排除
- [ ] 扩展已连即上报 CSS 盒 + 窗 DIP，overlay 画出 `browser-plugin` 光标
- [ ] `elementFromPoint` 复核失败即停
- [ ] 智能体权限出厂四列始终允许；谨慎模式出厂关

任意 App（1.2）：

- [ ] 权限探测，未授权不假装能点
- [ ] getAppState + click(elementIndex) 闭环
- [ ] overlay `computer-use` 仅 Helper 可写
- [ ] 备忘录指定按钮 10/10 hit-test
- [ ] 确认矩阵接到 Broker
- [ ] 技能 `computer-use` ensure 到 grok-home
- [ ] 满足 1.4 耗时预算

---

## 15. 一句话给执行者

用户要的是通用型 Agent：**独立浏览器设置页、Agent 自己开标签、扩展装上就同步登录态并连接 Chrome、能点 Mac 任意 App、点出去必须打中、栈不能拖成十几秒一步。设置用来关，不用来一路拦。** 几何由内置页 / 扩展 / Helper 当主人，模型只报编号。OCR 和猜像素不是退路。没做完五条 MUST，不准写「已经和 Codex 一样」。
