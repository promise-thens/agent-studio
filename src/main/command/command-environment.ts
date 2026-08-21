import { AGENT_STUDIO_MODEL_API_KEY_ENV } from '../provider/grok-provider-config'

/**
 * 命令子进程只继承运行时必需变量。
 * 原因：不得浅拷贝 process.env 再剥离——漏网的 NPM_TOKEN / GIT_SSH_COMMAND / 模型 Key 会进入 lint/test。
 * 边界：PATH 与 locale/tmp/Windows 根变量可放行；GROK_ 与 CODEX_ 凭据名一律不进入。
 */
const COMMAND_RUNTIME_ENV_ALLOWLIST = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy'
] as const

const BLOCKED_ENV_NAMES = new Set([
  'XAI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'API_KEY',
  'AUTHORIZATION',
  'NPM_TOKEN',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  AGENT_STUDIO_MODEL_API_KEY_ENV.toUpperCase()
])

const CREDENTIAL_NAME_PATTERN = /API[_-]?KEY|AUTHORIZATION|SECRET|PASSWORD|PASSWD|TOKEN/i

/**
 * 从 allowlist 构造独立 env 对象，永不写入模型凭据或 App Secret。
 * 调用方必须传入来源快照；本函数不读取、也不改写全局 process.env。
 */
export function buildCommandEnvironment(sourceEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of COMMAND_RUNTIME_ENV_ALLOWLIST) {
    const value = sourceEnvironment[name]
    if (typeof value === 'string' && value.length > 0 && !isForbiddenCommandEnvName(name)) {
      environment[name] = value
    }
  }

  const pathValue = sourceEnvironment.PATH
  if (typeof pathValue === 'string' && pathValue.length > 0 && !isForbiddenCommandEnvName('PATH')) {
    environment.PATH = pathValue
  }

  // 二次扫描防止未来误把密钥名加进 allowlist。
  for (const name of Object.keys(environment)) {
    if (isForbiddenCommandEnvName(name)) delete environment[name]
  }
  return environment
}

/** 收集来源环境中的凭据值，仅用于 transcript 脱敏，不得写回子进程 env。 */
export function collectCommandEnvironmentSecrets(sourceEnvironment: NodeJS.ProcessEnv): string[] {
  const secrets: string[] = []
  for (const [name, value] of Object.entries(sourceEnvironment)) {
    if (value && isForbiddenCommandEnvName(name)) secrets.push(value)
  }
  return secrets
}

export function isForbiddenCommandEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  if (BLOCKED_ENV_NAMES.has(upper)) return true
  if (upper.startsWith('GROK_') || upper.startsWith('CODEX_')) return true
  return CREDENTIAL_NAME_PATTERN.test(name)
}
