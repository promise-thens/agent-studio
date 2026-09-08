# P0-19f 浏览器插件字段观察

> 冻结浏览器工具白名单与虚拟鼠标坐标。观察方法是 `sdk+docs+binary`，**不是**真机 ACP 会话；实现必须服从本表，不得从 title、截图或 `_meta` 猜测 URL / 光标。没见到的字段写 not-observed。

## 0. 观察环境

| 项 | 值 |
| --- | --- |
| 记录日期 | 2026-09-07 |
| method | `sdk+docs+binary` |
| Grok CLI | `grok 1.0.13 (5e9a58528b76)` |
| `@agentclientprotocol/sdk` | `1.3.0`（`schema/schema.json`） |
| 握手 | 产品钉 `protocolVersion: 1`，`clientCapabilities: {}` |
| 真机 ACP 会话 | **未做**（本任务不要求另开真机会话，禁止假装跑过） |

对照材料：

- SDK 1.3 `schema.json` `$defs.ToolCall` / `ToolCallUpdate`（父 checkout `node_modules`；本 worktree 无 node_modules）
- Grok 用户指南 `07-mcp-servers.md`（MCP 合格名 `server__tool`；内置 `search_tool` / `use_tool`）
- Grok 1.0.13 二进制字符串（`strings` `/Users/huyaohang/.grok/downloads/grok-1.0.13-macos-aarch64`，不启动 ACP）
- 官方货架 `xai-org/plugin-marketplace` `.grok-plugin/marketplace.json`（`gh api`，2026-09-07，22 项）
- chrome-devtools 货架 pin `45f187b1e3202c9f32ddba913be5d68751c3caa3`：`docs/tool-reference.md`、`src/tools/input.ts`、`src/tools/pages.ts`、`src/tools/screenshot.ts`、`src/config/mcp-options.ts`、`.claude-plugin/plugin.json`
- Puppeteer `Mouse` 文档：main-frame CSS 像素，相对 viewport 左上
- browser-use 货架 pin `4749bcbfe456e5384b98281a8a66119352197f59` `grok/.mcp.json` + `grok/README.md`
- tinyfish 货架 pin `89457fba3fa44c7b2227807948628011983ab668` `grok/.mcp.json` + `grok/README.md`

未对照：隔离 ACP stdio、开发版 GUI、用户 `~/.grok/config.toml`、开启 `--experimentalVision` 的实例。

## 1. 货架插件

`xai-org/plugin-marketplace` 当前 22 项。与「操作浏览器」对得上的只有下面三行。货架 **没有** `computer-use`。

| 货架 name | 是否官方货架 | MCP 工具是否操作浏览器 | 备注 |
| --- | --- | --- | --- |
| chrome-devtools | 是 | 是（主路径） | 已装 id / plugin.json `name`：`chrome-devtools-mcp`。MCP server 键：`chrome-devtools`。启动 args：`npx chrome-devtools-mcp@1.8.0`，**不含** `--experimentalVision`。控制本机活的 Chrome。 |
| browser-use | 是 | 是 | MCP server 键：`browser-use`。`uvx browser-use@latest --cli-mcp`。用户自己的 Chrome 或 Browser Use Cloud。 |
| tinyfish | 是 | 部分 | MCP server 键：`tinyfish`。托管 HTTP `https://agent.tinyfish.ai/mcp`。只有自动化 / 会话类工具操作浏览器；`search` / `fetch_content` 是检索，不是本表 browser。 |
| computer-use | 否 | 不得当货架项 | 仓库测试夹具 MCP 名。二进制另有 OpenAI Responses 方言 `computer_use_preview` / `computer_call`，那是 API 类型，不是货架插件，不得当本表项。 |

其它 19 个货架项（vercel、sentry、firecrawl、exa、tavily、figma 等）即使会访问网页，也 **不是** 本计划的浏览器操作插件。未出现在上表的货架 name 不得当 browser 插件。

### 1.1 ACP `toolCall.name` 形状（真机未做）

| 层 | 结果 |
| --- | --- |
| SDK 1.3 `ToolCall.name` | 可选、标 **UNSTABLE**。顶层属性只有 `toolCallId`、`title`、`name`、`kind`、`status`、`content`、`locations`、`rawInput`、`rawOutput`、`_meta`。无 `x` / `y`。`additionalProperties` 未开。 |
| Grok 用户指南 | MCP 工具合格名为 `server__tool`（例 `github__create_issue`）。模型侧经内置 `search_tool` → `use_tool` 调用。 |
| Grok 1.0.13 二进制 | `UseToolInput` 两个字段：合格名 + `tool_input`（JSON 参数）。文案：``The `tool_name` must be the qualified `server__tool` name``。ACP dump：`tool_call id= kind= title= content= raw_input=`。JSON 样例另有 xAI 附加键 `toolName`，**不是** SDK `name`。二进制 **不含** `click_at` / `navigate_page` / `take_screenshot` / `chrome-devtools` 字符串。 |
| GACP-01 真机权限 RPC | `execute` 路径 `name` = false。那不是浏览器插件，不能外推。 |
| 本轮 ACP `toolCall.name` 是裸名、`server__tool`、还是 `use_tool` | **not-observed** |

禁止把内置 `use_tool` / `search_tool` 整工具标成 `browser`（否则所有 MCP 都会变成浏览器）。合格名是否出现在 ACP `name` 上，必须等真机再回写本表；实现不得猜前缀。

## 2. 映射为 operationType=browser 的工具名

只抄稳定 MCP tool name。禁止用中文 title。未出现在本表的 name 不得标 `browser`。

比对对象是 `toolCall.name` 的 **精确等于** 下表 `name`。`server__tool`、`use_tool`、title 正则都不算命中，除非真机观察回写。

### chrome-devtools（docs + pin 源码）

默认点击是 `click(uid)`，参数是无障碍树 uid，**没有坐标**。`click_at` 需 `--experimentalVision`；货架默认未开；**产品不得**给插件加上该 flag。

| name | 来源 | 映射 |
| --- | --- | --- |
| navigate_page | chrome-devtools docs / `pages.ts` | browser |
| new_page | chrome-devtools docs / `pages.ts` | browser |
| close_page | chrome-devtools docs / `pages.ts` | browser |
| list_pages | chrome-devtools docs / `pages.ts` | browser |
| select_page | chrome-devtools docs / `pages.ts` | browser |
| wait_for | chrome-devtools docs（Navigation automation） | browser |
| click | chrome-devtools docs / `input.ts` | browser |
| click_at | chrome-devtools docs / `input.ts`（需 experimentalVision） | browser |
| drag | chrome-devtools docs / `input.ts` | browser |
| fill | chrome-devtools docs / `input.ts` | browser |
| fill_form | chrome-devtools docs / `input.ts` | browser |
| hover | chrome-devtools docs / `input.ts` | browser |
| press_key | chrome-devtools docs / `input.ts` | browser |
| type_text | chrome-devtools docs / `input.ts` | browser |
| upload_file | chrome-devtools docs / `input.ts` | browser |
| handle_dialog | chrome-devtools docs / `pages.ts` | browser |
| emulate | chrome-devtools docs | browser |
| resize_page | chrome-devtools docs / `pages.ts` | browser |
| evaluate_script | chrome-devtools docs | browser |
| take_screenshot | chrome-devtools docs / `screenshot.ts` | browser |
| take_snapshot | chrome-devtools docs | browser |

下列 chrome-devtools 工具 **有文档、但不进本表**（默认 flag 关闭，或只是调试只读，标 browser 会误伤）：heap / extensions / WebMCP / PWA / third-party / screencast（需 `--experimentalScreencast`）/ `list_network_requests` / `get_network_request` / `list_console_messages` / `get_console_message` / `lighthouse_audit` / `performance_*`。未进表即不得标 browser。

### browser-use（插件 README）

| name | 来源 | 映射 |
| --- | --- | --- |
| browser_exec | browser-use grok README | browser |
| browser_screenshot | browser-use grok README | browser |

README 只列这两项。没有稳定的 `click` / `x` / `y` MCP 参数。

### tinyfish（插件 README / `.mcp.json` note）

| name | 来源 | 映射 |
| --- | --- | --- |
| run_web_automation | tinyfish grok README | browser |
| run_web_automation_async | tinyfish grok README | browser |
| create_browser_session | tinyfish grok README | browser |
| close_browser_session | tinyfish grok README | browser |

`search` / `fetch_content` / `get_run` / `cancel_run` / `batch_status` / `batch_cancel` **不进本表**（检索或跑次控制，不是桌面要审批的「操作浏览器」）。

### 2.1 URL 键

任务 3 只许从本表拷贝 URL，经 `parseBrowserOrigin`；失败则 unknown。禁止 title 正则。

| 键 | 结果 | 坐标无关说明 |
| --- | --- | --- |
| `rawInput.url` | MCP **documented**（`navigate_page` 可选、`new_page` 必填）。ACP 是否原样出现在 `rawInput`：**not-observed** | 冻结为唯一 URL 键。没有该键或解析失败 → unknown origin，不得发明。 |
| `rawInput.tool_input.url` | Grok `UseToolInput.tool_input` 在二进制/文档存在；ACP 是否套这层：**not-observed** | **不得**当冻结 URL 键。 nested 时本轮只能降 unknown。 |
| `rawInput.filePath` | MCP **documented**（`take_screenshot` 可选）。ACP：**not-observed** | 截图路径，不是 origin。任务 4 仅在已允许路径上注册；本表不把 `filePath` 当 URL。 |

`apiKey`、query/hash、userinfo 一律丢掉。带 userinfo 的 URL 不得投影 origin。

## 3. 指针字段

ACP 层（产品只许读这里）：

| 键 | 结果 | 坐标空间 |
| --- | --- | --- |
| `rawInput.x` / `rawInput.y` | **not-observed**（无真机 ACP；Grok 二进制无 `click_at`；SDK `rawInput` 无结构） | MCP 层见下；ACP 不得当 observed |
| `rawInput.coordinate` | **not-observed** | unknown |
| `rawInput.position` | **not-observed** | unknown。SDK 里的 `position` 是 NES 文稿光标，不是指针。 |
| `rawInput.tool_input.x` / `rawInput.tool_input.y` | **not-observed**（UseToolInput 套层未经 ACP 证实） | 即使将来 nested，空间仍是 viewport-css |
| ToolCall 顶层 `x` / `y` | **not-observed** | SDK `ToolCall` / `ToolCallUpdate` 无此属性 |

`_meta` 一律不读。`_meta.x` / `_meta.y` 不得发明光标。

MCP 层（chrome-devtools `click_at`，**不是** ACP 顶层键）：

| 项 | 结果 |
| --- | --- |
| 参数名 | docs + `input.ts` schema：`x`、`y`（number，必填），另有 `pageId`、`dblClick`、`includeSnapshot` |
| 实现 | `page.pptrPage.mouse.click(x, y)` |
| 空间 | **viewport-css**：Puppeteer `Mouse`「main-frame CSS pixels relative to the top-left corner of the viewport」。测试用页面内 `50,50` 点 100×100 的 div，不是屏幕 DIP。 |
| 能否映射到 overlay 屏幕 DIP | **不可映射**。缺 Chrome 窗口屏上位置、工具栏/装饰、DPR、多屏。本计划禁止 Accessibility / CGEvent / 读窗几何来补映射。数值不得原样画到桌面。 |
| 默认路径 | `click(uid)` **无坐标** → 不得发明光标。`click_at` 默认未广告给未开 vision 的服务器。 |
| browser-use / tinyfish | README **无** 稳定指针键 |

`resize_page` 的 `width` / `height`、`emulate.viewport` 字符串是页面尺寸 / 设备模拟，**不是**指针。

## 4. 冻结策略

1. **只按第 2 节 name 精确匹配映射 `browser`。** 禁止 title 正则猜 URL，禁止把 `use_tool` 标成 browser，禁止把夹具 `computer-use` 当货架或白名单。
2. **URL 只从冻结键 `rawInput.url` 拷贝**，经 `parseBrowserOrigin`；失败则 unknown。不要读 `_meta`、title、`tool_input.url`。
3. **pointer 只在「ACP 键 observed 且空间 = screen-DIP（或已证明可映射）」时写入快照。** 本表 ACP 指针键全部 not-observed；MCP `click_at` 即使将来出现在 `rawInput.x/y`，空间仍是 viewport-css、**不可映射**。任务 6 **不得**标完成。任务 2–5 仍可继续（停止条可以没有光标）。
4. **`click(uid)` 没有坐标 → 不得发明光标。** 禁止用 uid、截图像素、title、无障碍树猜点。
5. **本计划不打开 `screen` / `clipboard`。** 不为画光标去改用户插件 MCP 启动参数，不加 `--experimentalVision`。
