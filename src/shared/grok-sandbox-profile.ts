/**
 * Grok 内核沙箱档位（`grok --sandbox <PROFILE>`），不是 Electron `webPreferences.sandbox`，
 * 也不是 Permission Broker。
 *
 * CLI 位置（grok 1.0.13 已确认）：`--sandbox` 是 grok **全局**选项，插在 `--no-auto-update`
 * 之后、`agent` 子命令之前。禁止用环境变量 `GROK_SANDBOX` 猜测档位，禁止为此打开 `--leader`。
 * argv 组装属于后续任务，本模块只冻结可序列化枚举。
 *
 * 首期只允许这四档；非法值必须拒绝保存，type guard 不抛错。
 */
export const GROK_SANDBOX_PROFILES = ['off', 'workspace', 'read-only', 'strict'] as const

export type GrokSandboxProfile = (typeof GROK_SANDBOX_PROFILES)[number]

/**
 * 精确匹配四档字面量。`readonly`、`read_only`、大小写变体、空白、数字、对象一律 false。
 */
export function isGrokSandboxProfile(value: unknown): value is GrokSandboxProfile {
  return typeof value === 'string' && (GROK_SANDBOX_PROFILES as readonly string[]).includes(value)
}
