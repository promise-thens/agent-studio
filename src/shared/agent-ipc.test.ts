import { describe, expect, it } from 'vitest'
import { AGENT_INVOKE_CHANNELS, AGENT_PUSH_CHANNELS } from './agent-ipc'
import { APP_INVOKE_CHANNELS } from './app-ipc'
import { TASK_INVOKE_CHANNELS } from './task-ipc'

describe('桌面 IPC 静态契约', () => {
  it('所有 Agent 与 App channel 都固定且唯一', () => {
    const channels = [
      ...Object.values(AGENT_INVOKE_CHANNELS),
      ...Object.values(AGENT_PUSH_CHANNELS),
      ...Object.values(APP_INVOKE_CHANNELS),
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
      'agent:status',
      'agent:execution-update',
      'agent:event',
      'agent:permission',
      'agent:permission-cancelled',
      'app:choose-project',
      'app:list-projects',
      'app:remove-project',
      'app:preview-project-history-deletion',
      'app:delete-project-history',
      'task:list',
      'task:get',
      'task:list-turns',
      'task:list-events',
      'task:list-permission-audits',
      'task:resume',
      'task:preview-delete',
      'task:delete'
    ])
  })

  it('中性契约不包含旧 Grok channel', () => {
    const channels = [
      ...Object.values(AGENT_INVOKE_CHANNELS),
      ...Object.values(AGENT_PUSH_CHANNELS),
      ...Object.values(APP_INVOKE_CHANNELS),
      ...Object.values(TASK_INVOKE_CHANNELS)
    ]

    expect(channels.every((channel) => !channel.startsWith('grok:'))).toBe(true)
    expect(channels).not.toContain('agent:send-prompt')
    expect(channels).not.toContain('agent:cancel')
    expect(channels).not.toContain('app:choose-workspace')
  })
})
