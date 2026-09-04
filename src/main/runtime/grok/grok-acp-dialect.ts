/**
 * Grok ACP 私有方言契约：启动参数、握手允许字段、set_model 守卫。
 * 只服务 runtime/grok；不得泄漏到 shared 或中性 AgentRuntimeAdapter。
 */
import { isGrokSandboxProfile } from '../../../shared/grok-sandbox-profile'

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

/**
 * 由已校验的 sandbox profile 复制生产 argv。
 * off 必须与 GROK_PRODUCTION_AGENT_ARGV 全等；其它档把 `--sandbox <profile>`
 * 插在 `--no-auto-update` 之后、`agent` 之前。禁止改常量、禁止 GROK_SANDBOX env、
 * 禁止打开 `--leader`。非法值抛错且不得返回数组，避免 Renderer 字符串进 spawn。
 */
export function buildGrokProductionAgentArgv(profile: unknown): string[] {
  if (!isGrokSandboxProfile(profile)) {
    throw new Error('Grok sandbox profile 无效。')
  }
  const argv = [...GROK_PRODUCTION_AGENT_ARGV]
  if (profile === 'off') return argv
  const insertAt = argv.indexOf('--no-auto-update')
  if (insertAt < 0 || argv[insertAt + 1] !== 'agent') {
    throw new Error('Grok sandbox profile 无效。')
  }
  argv.splice(insertAt + 1, 0, '--sandbox', profile)
  return argv
}

/** 受控 E2E fixture argv 的固定 flag；与生产 argv 刻意分离。 */
export const GROK_CONTROLLED_E2E_SPAWN_ARG_FLAGS = {
  scenario: '--scenario',
  userData: '--user-data'
} as const

export const GROK_ACP_CLIENT_INFO_NAME = 'agent-studio'

/** GACP-05 之前禁止改成 fs/terminal true。 */
export const GROK_ACP_CLIENT_CAPABILITIES = {} as const

/**
 * initialize 响应里允许进入产品逻辑的字段路径。
 * 其它字段（auth / providers / _meta / promptCapabilities.audio 等）只进观察文档。
 */
export const GROK_INITIALIZE_RESPONSE_ALLOWED_FIELDS = [
  'protocolVersion',
  'agentInfo.version',
  'loadSession',
  'sessionCapabilities.resume',
  'sessionCapabilities.close',
  'promptCapabilities.image',
  'promptCapabilities.embeddedContext'
] as const

/**
 * 产品实际读取的握手字段。必须始终是 allow-list 子集；
 * Adapter/Mapper 新增读取时先改本列表，单测会强制同步 allow-list。
 */
export const GROK_INITIALIZE_PRODUCT_READ_FIELDS = [
  'protocolVersion',
  'agentInfo.version',
  'loadSession',
  'sessionCapabilities.resume',
  'sessionCapabilities.close',
  'promptCapabilities.image',
  'promptCapabilities.embeddedContext'
] as const

/**
 * 方言内部失败分类。只服务 runtime/grok 诊断；不得提升为通用 AgentRuntimeAdapterErrorCode。
 */
export type GrokAcpFailureKind =
  | 'cli-missing'
  | 'protocol-incompatible'
  | 'provider-config-missing'
  | 'set-model-failed'
  | 'process-exited'
  | 'config-write-failed'
  | 'generic'

/** 用户可感知且互相可区分的产品文案；不含路径、stderr 原文或密钥。 */
export const GROK_ACP_PRODUCT_MESSAGES = {
  cliMissing: '还没有安装 Grok Build CLI。',
  providerConfigMissing: '模型服务配置不可用，请重新配置 URL、Key 和模型。',
  setModelFailed: '绑定 Agent Studio 模型失败',
  /** set_model 响应形状不对时的产品文案；与 RPC 失败同属 fail-closed 家族。 */
  setModelShapeRejected: 'Grok Runtime 未确认 Agent Studio 模型绑定，已阻止继续执行。',
  processDisconnected: 'Grok Build 已断开',
  connectFailed: '连接失败'
} as const

/** 已投影的握手子集；方言检查不得读取未列出的原始扩展字段。 */
export interface GrokHandshakeProjectedFields {
  protocolVersion: number
  agentInfoVersion?: string
  loadSession?: boolean
  resume?: boolean
  close?: boolean
  /** 来自 promptCapabilities.image；驱动 Composer 识图提示与 ContentBlock::Image。 */
  promptImage?: boolean
  /** 来自 promptCapabilities.embeddedContext；驱动附件 resource_link 路径。 */
  promptEmbeddedContext?: boolean
}

/**
 * initialize 原始响应中方言允许窥视的最小形状。
 * agentInfo / agentCapabilities 可为 null（ACP SDK）；投影时不得读取 audio 等未列字段。
 */
export interface GrokInitializeResponseLike {
  protocolVersion: number
  agentInfo?: { version?: string } | null
  agentCapabilities?: {
    loadSession?: boolean
    sessionCapabilities?: {
      resume?: unknown
      close?: unknown
    } | null
    promptCapabilities?: {
      image?: boolean
      embeddedContext?: boolean
      /** 仅观察用；投影函数不得消费。 */
      audio?: boolean
    } | null
  } | null
}

export interface GrokHandshakeCompatResult {
  ok: true
  notes: string[]
}

export interface GrokAcpClientInfo {
  name: typeof GROK_ACP_CLIENT_INFO_NAME
  version: string
}

export interface GrokAcpResolvedFailure {
  kind: GrokAcpFailureKind
  /** 映射到现有通用码的建议；Adapter 负责最终抛出，禁止新增 Grok 专属码。 */
  adapterErrorCode: 'runtime-unavailable' | 'operation-failed'
  message: string
}

/**
 * 组装握手 clientInfo。version 必须由 Main 注入，禁止从 Renderer 接受。
 * 空/空白 version 立即拒绝，避免再写死与安装包不一致的字面量。
 */
export function buildGrokAcpClientInfo(version: string): GrokAcpClientInfo {
  const trimmed = version.trim()
  if (!trimmed) {
    throw new Error('Grok ACP clientInfo.version 不能为空。')
  }
  return {
    name: GROK_ACP_CLIENT_INFO_NAME,
    version: trimmed
  }
}

/**
 * 从 initialize 响应投影 allow-list 子集。
 * Mapper / Adapter 只能消费本函数结果，禁止直接读 promptCapabilities.audio 等未列字段。
 */
export function projectGrokHandshakeFields(
  response: GrokInitializeResponseLike
): GrokHandshakeProjectedFields {
  const agentInfoVersion = response.agentInfo?.version?.trim()
  return {
    protocolVersion: response.protocolVersion,
    ...(agentInfoVersion ? { agentInfoVersion } : {}),
    loadSession: response.agentCapabilities?.loadSession === true,
    resume: response.agentCapabilities?.sessionCapabilities?.resume != null,
    close: response.agentCapabilities?.sessionCapabilities?.close != null,
    // 备注：严格 === true；缺省或 false 都视为未声明识图 / 嵌入上下文；绝不读 audio。
    promptImage: response.agentCapabilities?.promptCapabilities?.image === true,
    promptEmbeddedContext: response.agentCapabilities?.promptCapabilities?.embeddedContext === true
  }
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

/**
 * 识别 spawn 找不到二进制（ENOENT）。只看 code / message，不把路径带回产品文案。
 */
export function isGrokCliMissingSpawnError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return true
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /\bENOENT\b/.test(message)
}

/** spawn / 进程启动错误分类；ENOENT 固定为 cli-missing。 */
export function classifyGrokSpawnProcessError(error: unknown): GrokAcpFailureKind {
  return isGrokCliMissingSpawnError(error) ? 'cli-missing' : 'generic'
}

/**
 * 握手或 connect 捕获错误分类。
 * 协议版本文案必须可识别，避免再被笼统包成“连接失败”。
 */
export function classifyGrokConnectError(error: unknown): GrokAcpFailureKind {
  if (isGrokCliMissingSpawnError(error)) return 'cli-missing'
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.includes('ACP 协议版本不兼容')) return 'protocol-incompatible'
  if (message.includes(GROK_ACP_PRODUCT_MESSAGES.providerConfigMissing)) {
    return 'provider-config-missing'
  }
  if (message.includes(GROK_ACP_PRODUCT_MESSAGES.setModelFailed)) return 'set-model-failed'
  return 'generic'
}

/**
 * 把方言失败 kind 收成现有通用错误码 + 可区分产品文案。
 * redactedDetail 必须已脱敏；本函数不再做二次脱敏，也不拼接家目录或 stderr 原文。
 */
export function resolveGrokAcpFailure(
  kind: GrokAcpFailureKind,
  options: {
    exitCode?: number | null
    redactedDetail?: string
  } = {}
): GrokAcpResolvedFailure {
  const detail = options.redactedDetail?.trim()

  switch (kind) {
    case 'cli-missing':
      return {
        kind,
        adapterErrorCode: 'runtime-unavailable',
        message: GROK_ACP_PRODUCT_MESSAGES.cliMissing
      }
    case 'provider-config-missing':
      return {
        kind,
        adapterErrorCode: 'runtime-unavailable',
        message: GROK_ACP_PRODUCT_MESSAGES.providerConfigMissing
      }
    case 'protocol-incompatible':
      return {
        kind,
        adapterErrorCode: 'operation-failed',
        message: detail && detail.includes('ACP 协议版本不兼容') ? detail : 'ACP 协议版本不兼容。'
      }
    case 'set-model-failed':
      return {
        kind,
        adapterErrorCode: 'operation-failed',
        message: detail
          ? `${GROK_ACP_PRODUCT_MESSAGES.setModelFailed}：${detail}`
          : GROK_ACP_PRODUCT_MESSAGES.setModelFailed
      }
    case 'process-exited':
      return {
        kind,
        adapterErrorCode: 'operation-failed',
        // 备注：干净断开文案由 Adapter 在无活跃 Turn 且 code===0 时单独处理。
        message: `Grok Build 已退出，代码 ${options.exitCode ?? '未知'}`
      }
    case 'config-write-failed':
      return {
        kind,
        adapterErrorCode: 'operation-failed',
        message: `无法生成 Grok 配置：${detail || '未知错误'}`
      }
    case 'generic':
    default:
      return {
        kind: 'generic',
        adapterErrorCode: 'operation-failed',
        message: detail
          ? `${GROK_ACP_PRODUCT_MESSAGES.connectFailed}：${detail}`
          : GROK_ACP_PRODUCT_MESSAGES.connectFailed
      }
  }
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

/**
 * 组装 Grok session/new 请求。
 * 只有 Task 快照接管时才写 `_meta.yoloMode`；这是把审批交给 Grok always-approve，
 * 不是 Permission Broker 沙箱。键集合必须字面量构造，禁止透传未知 _meta。
 */
export function buildGrokNewSessionRequest<TMcpServers>(input: {
  cwd: string
  mcpServers: TMcpServers
  takeoverEnabled: boolean
}): { cwd: string; mcpServers: TMcpServers; _meta?: { yoloMode: true } } {
  if (input.takeoverEnabled) {
    return { cwd: input.cwd, mcpServers: input.mcpServers, _meta: { yoloMode: true } }
  }
  return { cwd: input.cwd, mcpServers: input.mcpServers }
}
