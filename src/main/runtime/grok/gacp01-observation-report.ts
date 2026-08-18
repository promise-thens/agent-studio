import type { GrokAcpObservationRecord } from './grok-acp-protocol-observer'

export interface Gacp01ProductFacts {
  commit: string
  grokCliVersion: string
  nodeVersion: string
  pnpmVersion: string
  electronVersion: string
  sdkVersion: string
  protocolVersionConstant: string
  connectState: string
  connectMessage: string
  runtimeVersion?: string
  protocolVersion?: string
  sessionCreate: string
  sessionResume: string
  sessionLoad: string
  taskATurn1State?: string
  taskATurn2State?: string
  taskBState?: string
  resumeMethod?: string
  publicEventKinds: string[]
  permissionDecisions: string[]
  grokConfigHashBefore?: string
  grokConfigHashAfter?: string
}

export interface Gacp01ObservationReport {
  product: Gacp01ProductFacts
  records: GrokAcpObservationRecord[]
}

const NOT_OBSERVED = '`not-observed`'

/** 把脱敏观察记录填进 GACP-01 A–E 表；没见到的项保持 not-observed。 */
export function renderGacp01ObservationMarkdown(report: Gacp01ObservationReport): string {
  const initialize = lastOf(report.records, 'initialize')
  const setModel = lastOf(report.records, 'set-model')
  const sessionOps = report.records.filter((record) => record.kind === 'session-op')
  const updates = report.records.filter((record) => record.kind === 'session-update')
  const stops = report.records.filter((record) => record.kind === 'prompt-stop')
  const permissions = report.records.filter((record) => record.kind === 'permission')
  const stderr = report.records.find((record) => record.kind === 'stderr')
  const updateKinds = [...new Set(updates.map((record) => record.sessionUpdate))]
  const stopReasons = [...new Set(stops.map((record) => record.stopReason))]
  const hashUnchanged =
    report.product.grokConfigHashBefore && report.product.grokConfigHashAfter
      ? String(report.product.grokConfigHashBefore === report.product.grokConfigHashAfter)
      : NOT_OBSERVED

  return `# GACP-01 真机 Grok ACP 观察记录

> 本文件由可选脚本 \`pnpm test:gacp01:observe\` 通过正式桌面路径 \`window.agent.connect → createTask → startTurn\` 填写。不是受控 fixture，也不是独立 ACP Client。
>
> **状态：** 脚本已跑过一轮；没见到的项仍为 ${NOT_OBSERVED}。

## 0. 观察环境

| 项 | 值 |
| --- | --- |
| 记录日期 | ${new Date().toISOString().slice(0, 10)} |
| Agent Studio commit | \`${escapeCell(report.product.commit)}\` |
| Node | \`${escapeCell(report.product.nodeVersion)}\` |
| pnpm | \`${escapeCell(report.product.pnpmVersion)}\` |
| Electron | \`${escapeCell(report.product.electronVersion)}\` |
| Grok CLI | \`${escapeCell(report.product.grokCliVersion)}\` |
| \`@agentclientprotocol/sdk\` | \`${escapeCell(report.product.sdkVersion)}\` |
| \`acp.PROTOCOL_VERSION\` | \`${escapeCell(report.product.protocolVersionConstant)}\` |
| \`~/.grok/config.toml\` 观察前 hash | ${cell(report.product.grokConfigHashBefore)} |
| \`~/.grok/config.toml\` 观察后 hash | ${cell(report.product.grokConfigHashAfter)} |
| hash 是否不变 | ${hashUnchanged} |

## A. 进程与握手

| 项 | 结果 |
| --- | --- |
| Grok CLI 版本原文 | \`${escapeCell(report.product.grokCliVersion)}\` |
| \`acp.PROTOCOL_VERSION\` | \`${escapeCell(report.product.protocolVersionConstant)}\` |
| Runtime 返回的 \`protocolVersion\` | ${cell(initialize?.protocolVersion)} |
| 版本是否相等 | ${cell(initialize?.protocolVersionMatches)} |
| \`agentInfo.name\` 是否存在 | ${cell(initialize?.hasAgentInfoName)} |
| \`agentInfo.version\` 是否存在 | ${cell(initialize?.hasAgentInfoVersion)} |
| 是否写入能力快照 \`runtimeVersion\` | ${cell(report.product.runtimeVersion)} |
| \`agentCapabilities.loadSession\` | ${cell(initialize?.loadSession)} |
| \`sessionCapabilities.resume\` | ${cell(initialize?.resumeDeclared)} |
| \`sessionCapabilities.close\` | ${cell(initialize?.closeDeclared)} |
| \`promptCapabilities.image\` | ${cell(initialize?.promptImage)} |
| \`promptCapabilities.audio\` | ${cell(initialize?.promptAudio)} |
| \`promptCapabilities.embeddedContext\` | ${cell(initialize?.promptEmbeddedContext)} |
| \`auth\` 是否出现 | ${cell(initialize?.hasAuth)} |
| \`providers\` 是否出现 | ${cell(initialize?.hasProviders)} |
| \`_meta\` 是否出现 | ${cell(initialize?.hasMeta)} |
| stderr 是否有可脱敏握手噪音 | ${cell(stderr?.hasText)} |
| 连接状态 | \`${escapeCell(report.product.connectState)}\` / ${escapeCell(report.product.connectMessage)} |
| 产品 \`session.create\` | \`${escapeCell(report.product.sessionCreate)}\` |
| 产品 \`session.resume\` | \`${escapeCell(report.product.sessionResume)}\` |
| 产品 \`session.load\` | \`${escapeCell(report.product.sessionLoad)}\` |

## B. Session 生命周期

| 操作 | 结果 |
| --- | --- |
| \`session/new\` 返回的 \`sessionId\` 形状 | ${joinValues(sessionOps.filter((item) => item.method === 'new').map((item) => item.sessionIdShape))} |
| \`session/set_model\` 是否被接受 | ${cell(setModel?.accepted)} |
| \`session/set_model\` 响应形状 | ${cell(setModel?.responseShape)} |
| 同 Task 第二轮终态 | ${cell(report.product.taskATurn2State)} |
| Task B 终态 | ${cell(report.product.taskBState)} |
| 切回 A 实际走的 method | ${cell(report.product.resumeMethod)} |
| \`session/resume\` | ${joinValues(sessionOps.filter((item) => item.method === 'resume').map((item) => `${item.ok ? 'ok' : 'fail'}:${item.sessionIdShape}`))} |
| \`session/load\` | ${joinValues(sessionOps.filter((item) => item.method === 'load').map((item) => `${item.ok ? 'ok' : 'fail'}:${item.sessionIdShape}`))} |
| \`session/close\` | ${joinValues(sessionOps.filter((item) => item.method === 'close').map((item) => `${item.ok ? 'ok' : 'fail'}`))} |

## C. Prompt 与 session/update

见到的 \`sessionUpdate\`：${updateKinds.length > 0 ? updateKinds.map((item) => `\`${item}\``).join(', ') : NOT_OBSERVED}

见到的 \`stopReason\`：${stopReasons.length > 0 ? stopReasons.map((item) => `\`${item}\``).join(', ') : NOT_OBSERVED}

产品公开事件 kind：${report.product.publicEventKinds.length > 0 ? report.product.publicEventKinds.map((item) => `\`${item}\``).join(', ') : NOT_OBSERVED}

## D. 权限 RPC

${renderPermissionRows(permissions)}

产品层权限决策：${report.product.permissionDecisions.length > 0 ? report.product.permissionDecisions.map((item) => `\`${item}\``).join(', ') : NOT_OBSERVED}

## E. 生命周期与 P0-08 遗留

脚本本轮只覆盖连接、同 Task 两轮、A→B→A、可选权限和一次取消。退出三分支与窗口销毁仍需产品对话框，保持 ${NOT_OBSERVED}。

| # | 路径 | 结果 |
| --- | --- | --- |
| 1 | 执行中切 Task 再切回 | ${cell(report.product.resumeMethod)} |
| 2 | Renderer reload | ${NOT_OBSERVED} |
| 3 | 退出三分支 | ${NOT_OBSERVED} |
| 4 | Runtime 崩溃 | ${NOT_OBSERVED} |
| 5 | 取消超时 | ${NOT_OBSERVED} |
`
}

function renderPermissionRows(
  permissions: Extract<GrokAcpObservationRecord, { kind: 'permission' }>[]
): string {
  if (permissions.length === 0) {
    return `未观察到 \`requestPermission\`。`
  }
  const header =
    '| 次 | option.kind | 唯一 allow_once | 唯一 reject_once | toolCall.kind | locations.path | diff | rawInput | rawOutput | name | _meta |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  const rows = permissions.map((item, index) =>
    [
      index + 1,
      item.optionKinds.join('/') || 'empty',
      item.uniqueAllowOnce,
      item.uniqueRejectOnce,
      item.toolCallKind,
      item.hasLocationPath,
      item.hasDiffContent,
      item.hasRawInput,
      item.hasRawOutput,
      item.hasName,
      item.hasMeta
    ].join(' | ')
  )
  return `${header}\n| ${rows.join(' |\n| ')} |`
}

function lastOf<K extends GrokAcpObservationRecord['kind']>(
  records: GrokAcpObservationRecord[],
  kind: K
): Extract<GrokAcpObservationRecord, { kind: K }> | undefined {
  return [...records]
    .reverse()
    .find((record): record is Extract<GrokAcpObservationRecord, { kind: K }> => {
      return record.kind === kind
    })
}

function cell(value: unknown): string {
  if (value == null || value === '') return NOT_OBSERVED
  if (typeof value === 'boolean' || typeof value === 'number') return `\`${String(value)}\``
  return `\`${escapeCell(String(value))}\``
}

function joinValues(values: string[]): string {
  return values.length > 0
    ? values.map((value) => `\`${escapeCell(value)}\``).join(', ')
    : NOT_OBSERVED
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '/').replaceAll('\n', ' ').slice(0, 200)
}
