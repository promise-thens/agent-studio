import type {
  ArtifactAvailability,
  ArtifactDescriptor,
  ArtifactKind,
  ArtifactSource,
  ArtifactTrustLevel
} from '../../shared/artifact'

export interface ArtifactTurnGroup {
  turnId: string
  items: ArtifactDescriptor[]
}

export function artifactKindLabel(kind: ArtifactKind): string {
  if (kind === 'markdown') return 'Markdown'
  if (kind === 'image') return '图片'
  if (kind === 'diff') return 'Diff'
  return '文本'
}

export function artifactAvailabilityLabel(availability: ArtifactAvailability): string {
  if (availability === 'ready') return '可用'
  if (availability === 'missing') return '源文件缺失'
  if (availability === 'changed') return '源文件已变化'
  if (availability === 'unsupported') return '类型不受支持'
  return '当前不可用'
}

export function artifactTrustLabel(trust: ArtifactTrustLevel): string {
  if (trust === 'verified') return '已验证'
  if (trust === 'untrusted') return '未验证'
  return '不受支持'
}

export function artifactSourceLabel(source: ArtifactSource): string {
  if (source === 'git-review') return '变更审阅'
  if (source === 'agent-event') return 'Agent 事件'
  return '用户选择'
}

export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 按 Turn 分组，组内按创建时间。失效项仍保留，避免假装没生成过。 */
export function groupArtifactsByTurn(items: readonly ArtifactDescriptor[]): ArtifactTurnGroup[] {
  const groups = new Map<string, ArtifactDescriptor[]>()
  for (const item of items) {
    const current = groups.get(item.turnId) ?? []
    current.push(item)
    groups.set(item.turnId, current)
  }
  return [...groups.entries()]
    .map(([turnId, grouped]) => ({
      turnId,
      items: [...grouped].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    }))
    .sort((left, right) => left.items[0].createdAt.localeCompare(right.items[0].createdAt))
}

export function artifactNeedsAttention(item: ArtifactDescriptor): boolean {
  return item.availability !== 'ready'
}
