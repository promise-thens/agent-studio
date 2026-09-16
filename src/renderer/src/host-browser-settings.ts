export const HOST_BROWSER_SETTING_TITLE = '使用内置浏览器'

export const HOST_BROWSER_SETTING_HINT =
  '默认开启。Grok 经宿主 MCP 操作工作台右侧同一只浏览器。更改下一 session 生效，不会假装当前 Turn 已经有或没有这些工具。'

export const HOST_BROWSER_SETTING_BUSY_TITLE = '任务执行中，结束后才能改内置浏览器'

export function resolveHostBrowserSettingTitle(input: { runtimeBusy: boolean }): string {
  return input.runtimeBusy ? HOST_BROWSER_SETTING_BUSY_TITLE : HOST_BROWSER_SETTING_TITLE
}
