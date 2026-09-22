import type { AgentTurnOutcome } from '../../shared/agent'
import type { TaskExecutionSnapshot } from '../../shared/task-execution'
import type { TaskExecutor } from './task-executor'

/** 控制回合必须终态落盘并释放执行槽后才可确认；入队成功不代表 toggle 完成。 */
export async function runPermissionControlTurn(
  executor: Pick<TaskExecutor, 'waitForTerminal' | 'getSnapshot' | 'hasActiveExecution'>,
  start: () => Promise<TaskExecutionSnapshot>
): Promise<AgentTurnOutcome> {
  const accepted = await start()
  if (!accepted.execution) throw new Error('权限控制回合未被接受。')
  await executor.waitForTerminal()
  const terminal = executor.getSnapshot().execution
  if (
    !terminal ||
    terminal.executionId !== accepted.execution.executionId ||
    executor.hasActiveExecution()
  ) {
    throw new Error('权限控制回合状态不确定，发送已暂停。')
  }
  if (terminal.state === 'completed') return 'completed'
  if (terminal.state === 'cancelled') return 'cancelled'
  return 'failed'
}
