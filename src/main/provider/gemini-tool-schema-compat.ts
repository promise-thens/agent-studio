/**
 * Gemini 经 Chat Completions 网关时，会把 JSON Schema enum 里的 null 收成空字符串并 400。
 * 桌面只在模型名带 gemini 时启用本机清洗；不改 Grok 内置工具定义。
 */
export function needsGeminiToolSchemaCompat(modelId: string): boolean {
  return /gemini/i.test(modelId)
}

/**
 * 只清洗 tools / functions 里的 schema enum，不动 messages 正文。
 * 去掉 null、空串和非有限数字；enum 被掏空则删除该键。
 */
export function sanitizeChatCompletionsToolSchemas<T>(body: T): T {
  if (!isRecord(body)) return body
  const next: Record<string, unknown> = { ...body }
  if ('tools' in next) next.tools = sanitizeJsonValue(next.tools)
  if ('functions' in next) next.functions = sanitizeJsonValue(next.functions)
  return next as T
}

function sanitizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item))
  if (!isRecord(value)) return value

  const next: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'enum' && Array.isArray(nested)) {
      const filtered = nested.filter((item) => isUsableEnumValue(item))
      if (filtered.length > 0) next.enum = filtered
      continue
    }
    next[key] = sanitizeJsonValue(nested)
  }
  return next
}

function isUsableEnumValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  return typeof value === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
