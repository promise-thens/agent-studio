/**
 * Grok ACP 私有方言契约：启动参数、握手允许字段、set_model 守卫。
 * 只服务 runtime/grok；不得泄漏到 shared 或中性 AgentRuntimeAdapter。
 */

/** Agent Studio 写入 Grok config.toml / session/set_model 的固定模型别名。 */
export const AGENT_STUDIO_MODEL_ALIAS = 'agent-studio-default'

/** Grok 扩展方法名；禁止提升为中性 Runtime 方法。 */
export const GROK_SET_MODEL_METHOD = 'session/set_model'

/**
 * 生产默认 spawn argv。必须保持原样，不能经由通用 command/args 抽象。
 * 受控 E2E 不得复用本常量。
 */
export const GROK_PRODUCTION_AGENT_ARGV = [
  '--no-auto-update',
  'agent',
  '--no-leader',
  '-m',
  AGENT_STUDIO_MODEL_ALIAS,
  'stdio'
] as const

/** 受控 E2E fixture argv 的固定 flag；与生产 argv 刻意分离。 */
export const GROK_CONTROLLED_E2E_SPAWN_ARG_FLAGS = {
  scenario: '--scenario',
  userData: '--user-data'
} as const

export const GROK_ACP_CLIENT_INFO_NAME = 'agent-studio'

/**
 * 握手里的 Client 版本字面量。
 * 任务 2 才改为真实应用版本；本任务保持 GACP-01 观察基线。
 */
export const GROK_ACP_CLIENT_INFO_VERSION = '0.1.0'

/** GACP-05 之前禁止改成 fs/terminal true。 */
export const GROK_ACP_CLIENT_CAPABILITIES = {} as const

/**
 * initialize 响应里允许进入产品逻辑的字段路径。
 * 其它字段只进观察文档，不得驱动业务分支。
 */
export const GROK_INITIALIZE_RESPONSE_ALLOWED_FIELDS = [
  'protocolVersion',
  'agentInfo.version',
  'loadSession',
  'sessionCapabilities.resume',
  'sessionCapabilities.close'
] as const

/** 已投影的握手子集；方言检查不得读取未列出的原始扩展字段。 */
export interface GrokHandshakeProjectedFields {
  protocolVersion: number
  agentInfoVersion?: string
  loadSession?: boolean
  resume?: boolean
  close?: boolean
}

export interface GrokHandshakeCompatResult {
  ok: true
  notes: string[]
}

/**
 * 校验握手兼容性：版本不等立即拒绝；session/new 基线只记录、不发明探测。
 * Mapper / Adapter 必须调用本函数，禁止另写一套 version 判断。
 */
export function assertGrokHandshakeCompat(
  projected: GrokHandshakeProjectedFields,
  expectedProtocolVersion: number
): GrokHandshakeCompatResult {
  if (projected.protocolVersion !== expectedProtocolVersion) {
    throw new Error(
      `ACP 协议版本不兼容：Runtime 返回 ${projected.protocolVersion}，客户端支持 ${expectedProtocolVersion}。`
    )
  }

  // 备注：ACP 规范要求 Agent 支持 session/new，但 initialize 不广告该方法；禁止自行探测。
  return {
    ok: true,
    notes: ['session/new 为 ACP 基线能力，当前仅依赖规范要求，不自行发明探测。']
  }
}

/**
 * session/set_model 成功响应守卫：必须是非 null 普通对象。
 * 不读取 `_meta` 或其它业务字段；形状不对由 Adapter fail-closed。
 */
export function isGrokSetModelResponseValid(response: unknown): boolean {
  return response !== null && typeof response === 'object' && !Array.isArray(response)
}

/** 组装受控 E2E spawn args；executable 仍是 process.execPath，不走生产 argv。 */
export function buildGrokControlledE2ESpawnArgs(input: {
  fixturePath: string
  scenario: string
  userDataPath: string
}): string[] {
  return [
    input.fixturePath,
    GROK_CONTROLLED_E2E_SPAWN_ARG_FLAGS.scenario,
    input.scenario,
    GROK_CONTROLLED_E2E_SPAWN_ARG_FLAGS.userData,
    input.userDataPath
  ]
}
