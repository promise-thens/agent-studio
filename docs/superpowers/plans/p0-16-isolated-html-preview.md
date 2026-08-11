# P0-16 隔离 HTML Preview 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0+ / 权重 4（动态 Artifact 的高隔离增强，不阻塞 P0-A/P0-B）

**目标：** 在 P0-13 基础 Artifact Registry 上增加 HTML/CSS/JS 预览，并固定使用 sandboxed `WebContentsView`、独立临时 session partition 和窄 custom protocol，使生成页面可以运行自身前端脚本但不能获得 Agent Studio、用户浏览器或默认网络权限。

**核心数据流：** 用户打开 `html` Artifact 后，Renderer 只提交 artifactId 与可视区域；主进程重新验证 Artifact/environment，创建专属临时 session 和 sandboxed WebContentsView；custom protocol 将 artifactId 下的 HTML 与允许的相对静态资源映射为只读响应；主进程拦截网络、导航、弹窗和下载，并把有限加载状态返回 Renderer。

**约束与边界：** HTML 不在 Renderer DOM 中直接 `v-html`，不使用普通 iframe 共享 App origin，也不使用 `file://`。WebContentsView 必须保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、无 Preload、无 App IPC；每次预览使用非持久 session partition，不继承 Cookie、缓存或登录态。默认禁止外网、顶层导航、弹窗和下载。

**主要风险：** custom protocol 路径逃逸、WebContents/session 复用泄漏、脚本外发数据、窗口导航覆盖 App 和资源洪泛；使用 artifact root 白名单、每预览独立 partition、CSP、session 级请求阻断、WebContents 生命周期清理和资源上限。

**技术栈：** Electron 39 `WebContentsView`、Session/Protocol API、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。

---

## 实施范围

**前置依赖：**
- 依赖 P0-13、P0-14；P0-14 已保证 Local/Worktree 均可通过 environmentId 解析稳定 execution root。

**文件范围：**
- 创建 `src/main/artifact/html-preview-service.ts`、`html-preview-protocol.ts`、`html-preview-policy.ts` 及就近测试。
- 扩展 `src/shared/artifact.ts` 的 HTML descriptor/preview snapshot，增加固定 Preview IPC 与 Preload API。
- 创建 `src/renderer/src/components/HtmlArtifactPreview.vue`，修改 ArtifactViewer；WebContentsView 的创建、销毁和 bounds 由主进程服务持有。

**安全策略：**
- 使用不带 `persist:` 的随机 partition；关闭预览时移除 WebContentsView、协议处理器、请求拦截器和 session 引用，不复用用户默认 session。
- custom protocol 只接受 opaque previewId/artifactId 和规范化相对资源路径；禁止 `..`、绝对路径、编码绕过、符号链接逃逸、目录列举和任意 Range 洪泛。
- CSP 至少限制 `default-src 'none'`、`connect-src 'none'`、`object-src 'none'`、`frame-src 'none'`、`base-uri 'none'`、`form-action 'none'`；脚本、样式、图片和字体只允许当前 custom origin 及经确认的有限 data URL。
- `will-navigate`、`setWindowOpenHandler`、permission request、download 和非 custom-scheme 请求默认拒绝；不向页面注入 Provider Secret、Project token 或 App API。

### 任务 1: 冻结 WebContentsView 与临时 Session 基线

**任务目标：**
- 先用最小安全 harness 证明 Electron 39 的隔离配置和资源清理行为。

**涉及范围：**
- preview harness、webPreferences、session 生命周期和安全测试。

**前置依赖：**
- P0-13 已提供 ArtifactRegistry、opaque ID、路径与 availability 边界；本计划扩展 HTML kind/注册规则，但不会在 Renderer 直接渲染。

- [ ] **第 1 步: 创建 sandboxed WebContentsView**
说明：主进程创建 WebContentsView，固定 sandbox/contextIsolation/nodeIntegration/preload 配置；Renderer 只能请求 open/close/updateBounds，不能传 webPreferences 或 URL。
预期：预览页面中 `require`、`process`、Electron API、Preload bridge，以及 Agent Studio 实际暴露的 `window.agent`、`window.app`、`window.provider` 均不存在。

- [ ] **第 2 步: 创建独立临时 partition**
说明：每个 preview session 使用随机、非持久 partition，禁用持久缓存并在关闭后销毁引用；禁止复用 defaultSession、受管浏览器或其它 Artifact session。
预期：不同预览之间不共享 Cookie/localStorage/sessionStorage；关闭应用后没有持久登录态或缓存残留。

- [ ] **第 3 步: 验证视图生命周期**
说明：覆盖 Task 切换、Artifact 切换、窗口 resize/minimize、主窗口关闭、加载崩溃和重复 close；主进程统一移除 view 和监听器。
预期：没有悬挂 WebContents、后台脚本、重复事件订阅或不可见网络请求。

### 任务 2: 实现窄 custom protocol 与资源根

**任务目标：**
- 只让预览读取已注册 HTML Artifact 根内的有限静态资源。

**涉及范围：**
- html-preview-protocol、ArtifactRegistry、MIME 响应和测试。

**前置依赖：**
- 依赖任务 1 的专属 session。

- [ ] **第 1 步: 定义 PreviewRootDescriptor**
说明：记录 previewId、artifactId、taskId、environmentId、root relative path、entry file、content hash、允许 MIME、总资源数/字节上限和过期时间；不返回绝对路径给 Renderer/页面。
预期：每个 previewId 只能访问一个已验证 Artifact 根，Task/environment 变化后立即失效。

- [ ] **第 2 步: 映射只读资源**
说明：custom protocol 对 URL decode、规范化和 realpath 后验证仍在 root 内，只允许普通文件和 HTML/CSS/JS/安全图片/字体等白名单 MIME；响应带 `nosniff`、CSP 和 no-store。
预期：`..`、双重编码、绝对路径、符号链接、目录、设备文件、未知 MIME 和超限资源均拒绝。

- [ ] **第 3 步: 控制资源预算和变化**
说明：限制单文件、总字节、请求数和并发数；文件 hash/revision 变化后终止旧 preview 并要求重新打开，不让已验证入口静默加载新树。
预期：资源洪泛不会拖垮主进程，外部修改不会继续沿用旧 trust 状态。

### 任务 3: 固定网络、导航与外部副作用策略

**任务目标：**
- 让 HTML 可以运行同根前端脚本，但不能把项目内容发出去或突破桌面应用边界。

**涉及范围：**
- session webRequest、navigation/window/download/permission hooks、CSP 和攻击 fixture。

**前置依赖：**
- 依赖任务 2 的 custom protocol。

- [ ] **第 1 步: 默认阻断非预览网络**
说明：session 只允许当前 custom scheme；阻断 http/https/ws/wss/file/data navigation 和 fetch/XHR/WebSocket，data URL 仅在 CSP 明确允许的图片/字体上下文使用。
预期：`fetch`、图片 beacon、WebSocket、表单提交和动态 script 外链均失败，阻断原因可诊断但不泄漏路径。

- [ ] **第 2 步: 阻断导航、弹窗和下载**
说明：拒绝 will-navigate、window.open、target=_blank、下载、permission request、fullscreen/pointer lock 等外部能力；外链只以不可点击或“复制目标”摘要展示，本计划不调用系统浏览器。
预期：恶意页面不能覆盖 Agent Studio、拉起外部应用、写入下载目录或请求摄像头/麦克风/剪贴板。

- [ ] **第 3 步: 验证脚本隔离**
说明：使用攻击 fixture 覆盖 App API 探测、top/opener 访问、custom protocol 越权、Service Worker、跨预览 storage、CSP 绕过和大量 console/error。
预期：页面只能在自身预览环境运行，失败状态有界且不会把原始异常/绝对路径传 Renderer。

### 任务 4: 接入 Artifact Viewer 与真实页面走查

**任务目标：**
- 提供可刷新、可关闭、尺寸同步且边界清晰的 HTML Artifact 体验。

**涉及范围：**
- HtmlArtifactPreview、ArtifactViewer、Preview IPC、组件/集成测试和 Electron 走查。

**前置依赖：**
- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 实现视图编排**
说明：Renderer 发送 artifactId 和经过主进程校验的 bounds 更新；主进程创建/复用当前 previewId，切换 Artifact 时先关闭旧 view。Titlebar 和交互控件保持 no-drag。
预期：预览准确覆盖 Viewer 区域，窗口缩放、侧栏变化和 Task 切换不出现残影或点击穿透。

- [ ] **第 2 步: 展示加载与限制状态**
说明：显示 loading/ready/blocked/error/stale/crashed，资源缺失和被阻断网络使用有限摘要；提供刷新和关闭，不提供 DevTools/任意 URL 输入作为正式能力。
预期：用户知道页面是隔离预览，外网不可用不是“网络坏了”的模糊错误。

- [ ] **第 3 步: 完成 Local/Worktree 真实走查**
说明：验证常见 HTML/CSS/JS 页面、同根图片/字体、动态交互、reduced-motion、Local/Worktree 路径、源文件变化，以及恶意网络/导航/下载/路径 fixture。
预期：真实页面可用，原项目外文件、App IPC、登录态和网络均不可达。

## 验收标准

- [ ] HTML 只在 sandboxed WebContentsView 中运行，保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、无 Preload 和无 App IPC。
- [ ] 每个预览使用独立非持久 session partition，不继承默认浏览器 Cookie、缓存、登录态或其它预览 storage。
- [ ] custom protocol 只能读取已注册 Artifact 根内的白名单资源；路径逃逸、符号链接、未知 MIME 和资源洪泛被拒绝。
- [ ] 默认网络、导航、弹窗、下载和权限请求全部被阻断；页面无法访问 Node、Electron、用户浏览器数据或 Provider Secret。
- [ ] Local/Worktree 页面、源文件变化、崩溃与关闭均能正确收束，无悬挂 WebContents 或监听器。
- [ ] 目标 ESLint、相关 Vitest/集成与安全测试、`pnpm typecheck`、`pnpm build`、`git diff --check` 通过，并完成 Electron HTML 隔离攻击走查。
