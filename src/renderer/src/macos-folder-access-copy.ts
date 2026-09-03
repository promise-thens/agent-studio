import type {
  MacosFolderAccessNotice,
  MacosProtectedFolderKind
} from '../../shared/macos-folder-access'

const FOLDER_LABELS: Record<MacosProtectedFolderKind, string> = {
  documents: '文稿',
  desktop: '桌面',
  downloads: '下载'
}

/** 只解释系统文件夹权限，不把它说成 Grok 沙箱。 */
export function formatMacosFolderAccessMessage(notice: MacosFolderAccessNotice): string {
  if (notice.status !== 'denied' || !notice.folderKind) return ''
  const folder = FOLDER_LABELS[notice.folderKind]
  const appLabel = notice.settingsAppLabel
  const base = `当前工作区在「${folder}」里。系统还没允许 ${appLabel} 访问该文件夹，Grok 的命令和搜索可能无法读取该目录。`
  if (appLabel === 'Electron') {
    return `${base} 开发版在系统设置里可能显示为 Electron。`
  }
  return base
}
