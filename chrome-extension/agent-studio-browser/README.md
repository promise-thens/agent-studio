# Agent Studio 配套浏览器扩展

 unpacked 安装（开发版与安装包都走同一目录）：

1. 在 Agent Studio 设置 → 浏览器点击「安装配套扩展」。这会打开本目录，并写入 Chrome Native Host 清单。
2. 打开 Chrome 的 `chrome://extensions`。
3. 启用右上角「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择本目录 `chrome-extension/agent-studio-browser`。

扩展 id 必须是 `odcgomechdmpbooelpdakcenicncehko`（由清单里的 `key` 固定）。装上后会连接 Native Host `com.agentstudio.browser`，用 `cookies.getAll` 同步登录态，不读取磁盘 Chrome Profile。

弹出窗口只显示「已连接」或「未连接」，没有把当前标签交给 Agent 的按钮。
