const REDACTED_VALUE = '[REDACTED]'

const SENSITIVE_FIELD_PATTERN =
  /(["']?(?:api[-_]?key|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd)["']?\s*[:=]\s*["']?)([^"',&#\s}\]]+)/gi
const BEARER_PATTERN = /(\bBearer\s+)([^\s,;"'}\]]+)/gi
const SECRET_QUERY_PATTERN =
  /([?&#](?:api[-_]?key|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|token|secret|password|passwd)=)([^&#\s]*)/gi
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)([^/\s@]+)@/gi

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceKnownSecret(text: string, secret: string): string {
  if (!secret) return text

  return text.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED_VALUE)
}

/**
 * 对即将进入日志、错误提示或 IPC 的文本统一脱敏。
 *
 * `knownSecrets` 应由当前主进程持有的凭据提供；函数同时兜底处理常见
 * Authorization Header、API Key Header、URL Secret 参数和 URL 内嵌凭据。
 */
export function redactSensitiveText(text: string, knownSecrets: Iterable<string> = []): string {
  let redacted = text

  // 先替换最长的已知密钥，避免短密钥破坏长密钥后留下可识别片段。
  const secrets = [...new Set(knownSecrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)

  for (const secret of secrets) {
    redacted = replaceKnownSecret(redacted, secret)

    const encodedSecret = encodeURIComponent(secret)
    if (encodedSecret !== secret) {
      redacted = replaceKnownSecret(redacted, encodedSecret)
    }
  }

  return redacted
    .replace(BEARER_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(SENSITIVE_FIELD_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(SECRET_QUERY_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED_VALUE}@`)
}

/** 将未知异常转换为可展示的脱敏文本，不向 Renderer 传递原始堆栈。 */
export function redactSensitiveError(error: unknown, knownSecrets: Iterable<string> = []): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message, knownSecrets)
  }

  if (typeof error === 'string') {
    return redactSensitiveText(error, knownSecrets)
  }

  try {
    return redactSensitiveText(JSON.stringify(error), knownSecrets)
  } catch {
    return '发生了无法序列化的内部错误。'
  }
}

export { REDACTED_VALUE }
