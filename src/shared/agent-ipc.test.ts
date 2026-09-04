import { describe, expect, it } from 'vitest'
import { AGENT_INVOKE_CHANNELS, AGENT_PUSH_CHANNELS } from './agent-ipc'
import { APP_INVOKE_CHANNELS, APP_PUSH_CHANNELS } from './app-ipc'
import { TASK_INVOKE_CHANNELS, parseSubagentActivityPage } from './task-ipc'

describe('桌面 IPC 静态契约', () => {
  it('所有 Agent 与 App channel 都固定且唯一', () => {
    const channels = [
      ...Object.values(AGENT_INVOKE_CHANNELS),
      ...Object.values(AGENT_PUSH_CHANNELS),
      ...Object.values(APP_INVOKE_CHANNELS),
      ...Object.values(APP_PUSH_CHANNELS),
      ...Object.values(TASK_INVOKE_CHANNELS)
    ]

    expect(new Set(channels).size).toBe(channels.length)
    expect(channels).toEqual([
      'agent:get-status',
      'agent:get-execution-snapshot',
      'agent:connect',
      'agent:disconnect',
      'agent:create-task',
      'agent:enter-task',
      'agent:start-turn',
      'agent:cancel-turn',
      'agent:get-task-runtime-state',
      'agent:respond-permission',
      'agent:respond-question',
      'agent:get-available-commands',
      'agent:set-permission-mode',
      'agent:status',
      'agent:execution-update',
      'agent:event',
      'agent:permission',
      'agent:permission-cancelled',
      'agent:question',
      'agent:question-cancelled',
      'agent:available-commands',
      'agent:task-runtime-state',
      'app:choose-project',
      'app:list-projects',
      'app:reveal-project',
      'app:remove-project',
      'app:preview-project-history-deletion',
      'app:delete-project-history',
      'app:get-appearance',
      'app:set-appearance',
      'app:list-plugins',
      'app:get-plugin',
      'app:set-plugin-enabled',
      'app:get-grok-config',
      'app:save-grok-config',
      'app:list-memories',
      'app:get-memory',
      'app:save-memory',
      'app:delete-memory',
      'app:get-memory-enabled',
      'app:set-memory-enabled',
      'app:get-grok-sandbox',
      'app:set-grok-sandbox',
      'app:list-mcp-servers',
      'app:upsert-mcp-server',
      'app:delete-mcp-server',
      'app:list-marketplace-plugins',
      'app:install-plugin',
      'app:uninstall-plugin',
      'app:add-marketplace-source',
      'app:probe-macos-folder-access',
      'app:open-macos-files-privacy-settings',
      'app:appearance',
      'task:list',
      'task:get',
      'task:list-turns',
      'task:list-events',
      'task:list-permission-audits',
      'task:resume',
      'task:preview-delete',
      'task:delete',
      'task:rename',
      'task:archive',
      'task:list-command-evidence',
      'task:get-command-evidence',
      'task:get-command-transcript',
      'task:get-change-set',
      'task:get-file-diff',
      'task:list-turn-checkpoints',
      'task:preview-latest-turn-restore',
      'task:restore-latest-turn',
      'task:list-artifacts',
      'task:get-artifact-content',
      'task:pick-attachments',
      'task:import-dropped-paths',
      'task:import-clipboard',
      'task:list-draft-attachments',
      'task:remove-attachment',
      'task:get-attachment-preview',
      'task:get-attachment-image',
      'task:get-change-media-preview',
      'task:get-subagent-activity'
    ])
  })

  it('中性契约不包含旧 Grok channel', () => {
    const channels = [
      ...Object.values(AGENT_INVOKE_CHANNELS),
      ...Object.values(AGENT_PUSH_CHANNELS),
      ...Object.values(APP_INVOKE_CHANNELS),
      ...Object.values(APP_PUSH_CHANNELS),
      ...Object.values(TASK_INVOKE_CHANNELS)
    ]

    expect(channels.every((channel) => !channel.startsWith('grok:'))).toBe(true)
    expect(channels).not.toContain('agent:send-prompt')
    expect(channels).not.toContain('agent:cancel')
    expect(channels).not.toContain('app:choose-workspace')
  })
})

describe('子代理活动公开回包', () => {
  it('只保留有界工具事实与真实最终回复，未知键不得穿透', () => {
    expect(
      parseSubagentActivityPage({
        source: 'grok-session',
        tools: [{ toolCallId: 'tool-1', title: 'Read `index.html`', status: 'completed' }],
        result: { text: '分析完成。', truncated: false, rawOutput: 'secret' },
        runtimeSessionId: 'private-session'
      })
    ).toEqual({
      source: 'grok-session',
      tools: [{ toolCallId: 'tool-1', title: 'Read `index.html`', status: 'completed' }],
      result: { text: '分析完成。', truncated: false }
    })
  })

  it('拒绝 NUL 与超过 32 KiB 的结果文本', () => {
    const base = { source: 'grok-session', tools: [] }
    expect(
      parseSubagentActivityPage({ ...base, result: { text: 'bad\0text', truncated: false } })
    ).toBeNull()
    expect(
      parseSubagentActivityPage({
        ...base,
        result: { text: '中'.repeat(11_000), truncated: true }
      })
    ).toBeNull()
  })
})
