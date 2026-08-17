/**
 * 受控 ACP Runtime Electron E2E 的私有启动契约。
 *
 * 它刻意不承载可执行文件、任意参数或环境变量；只有 Main 进程能构造该对象，
 * Adapter 仍会在启动前重新校验其中的固定路径。
 */
export const CONTROLLED_ACP_E2E_SCENARIOS = [
  'E2E:FIFO',
  'E2E:TOOLCALL_CANCEL',
  'E2E:TURN_CANCEL',
  'E2E:EXECUTE_UNSUPPORTED',
  'E2E:LONG_RUNNING',
  'E2E:PERMISSION_WAIT',
  'E2E:IGNORE_CANCEL',
  'E2E:RUNTIME_CRASH'
] as const

export type ControlledAcpFixtureScenario = (typeof CONTROLLED_ACP_E2E_SCENARIOS)[number]

/** 受控临时 userData 下只允许使用这些固定目录，避免测试夹具接收自由路径。 */
export const CONTROLLED_ACP_E2E_DIRECTORIES = {
  workspace: 'controlled-acp-e2e-workspace',
  secondaryWorkspace: 'controlled-acp-e2e-secondary-workspace',
  trace: 'controlled-acp-e2e-trace',
  barriers: 'controlled-acp-e2e-barriers',
  runtimeHome: 'controlled-acp-e2e-home'
} as const

export const CONTROLLED_ACP_E2E_MARKER_FILE = 'permission-e2e-marker.txt'
/** Adapter 与 fixture 分开记录固定 trace，避免跨进程并发追加破坏顺序证据。 */
export const CONTROLLED_ACP_E2E_ADAPTER_TRACE_FILE = 'adapter-trace.jsonl'
export const CONTROLLED_ACP_E2E_FIXTURE_TRACE_FILE = 'fixture-trace.jsonl'
export const CONTROLLED_ACP_E2E_FIXTURE_FILE = 'controlled-acp-runtime.mjs'
export const CONTROLLED_ACP_E2E_MODEL_ID = 'controlled-acp-e2e-model'

/**
 * Adapter 的受限 fixture 描述符。
 * 任意命令、参数或环境变量均不属于此接口，防止测试开关扩张为通用子进程入口。
 */
export interface ControlledAcpFixtureLaunch {
  readonly scenario: ControlledAcpFixtureScenario
  /** Main 从构建后模块位置反推的仓库根，由 bootstrap 与 Adapter 双重复核。 */
  readonly repositoryRootPath: string
  /** 已校验的临时 userData；fixture 只从它派生固定工作目录，拒绝自由路径参数。 */
  readonly userDataPath: string
  readonly fixturePath: string
  readonly traceDirectory: string
  readonly barrierDirectory: string
  readonly runtimeHomeDirectory: string
}
