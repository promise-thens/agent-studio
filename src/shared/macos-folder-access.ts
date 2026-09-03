export const MACOS_PROTECTED_FOLDER_KINDS = ['documents', 'desktop', 'downloads'] as const
export type MacosProtectedFolderKind = (typeof MACOS_PROTECTED_FOLDER_KINDS)[number]

export const MACOS_FOLDER_ACCESS_STATUSES = [
  'ok',
  'denied',
  'not-protected',
  'unsupported'
] as const
export type MacosFolderAccessStatus = (typeof MACOS_FOLDER_ACCESS_STATUSES)[number]

export const MACOS_PRIVACY_SETTINGS_APP_LABELS = ['Agent Studio', 'Electron'] as const
export type MacosPrivacySettingsAppLabel = (typeof MACOS_PRIVACY_SETTINGS_APP_LABELS)[number]

/** Renderer 只拿状态码和设置页显示名，不拿完整工作区路径。 */
export interface MacosFolderAccessNotice {
  status: MacosFolderAccessStatus
  folderKind?: MacosProtectedFolderKind
  settingsAppLabel: MacosPrivacySettingsAppLabel
}

export function isMacosProtectedFolderKind(value: unknown): value is MacosProtectedFolderKind {
  return (
    typeof value === 'string' && (MACOS_PROTECTED_FOLDER_KINDS as readonly string[]).includes(value)
  )
}

export function isMacosFolderAccessStatus(value: unknown): value is MacosFolderAccessStatus {
  return (
    typeof value === 'string' && (MACOS_FOLDER_ACCESS_STATUSES as readonly string[]).includes(value)
  )
}

export function isMacosPrivacySettingsAppLabel(
  value: unknown
): value is MacosPrivacySettingsAppLabel {
  return (
    typeof value === 'string' &&
    (MACOS_PRIVACY_SETTINGS_APP_LABELS as readonly string[]).includes(value)
  )
}

/**
 * 丢掉未知键。denied 必须带 folderKind；其它状态可以没有。
 * 禁止把路径字段带进 Renderer。
 */
export function parseMacosFolderAccessNotice(value: unknown): MacosFolderAccessNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isMacosFolderAccessStatus(record.status)) return null
  if (!isMacosPrivacySettingsAppLabel(record.settingsAppLabel)) return null
  if (record.status === 'denied') {
    if (!isMacosProtectedFolderKind(record.folderKind)) return null
    return {
      status: 'denied',
      folderKind: record.folderKind,
      settingsAppLabel: record.settingsAppLabel
    }
  }
  const notice: MacosFolderAccessNotice = {
    status: record.status,
    settingsAppLabel: record.settingsAppLabel
  }
  if (isMacosProtectedFolderKind(record.folderKind)) {
    notice.folderKind = record.folderKind
  }
  return notice
}
