import {
  ARTIFACT_LIMITS,
  sanitizeArtifactMarkdown,
  type ArtifactContent,
  type ArtifactDescriptor
} from '../../shared/artifact'
import type { FileDiffResult } from '../../shared/git-review'
import {
  ArtifactRegistry,
  ArtifactRegistryError,
  type ArtifactImageProbe
} from './artifact-registry'

export interface ArtifactContentServiceOptions {
  registry: ArtifactRegistry
  getFileDiff: (taskId: string, path: string) => Promise<FileDiffResult>
  probeImagePixels?: ArtifactImageProbe
  maxCacheBytes?: number
}

interface CacheEntry {
  key: string
  bytes: number
  content: ArtifactContent
}

/**
 * 按 artifactId 返回有限、净化后的内容。缓存键绑定 revision/hash，文件变化不得复用旧正文。
 */
export class ArtifactContentService {
  private readonly registry: ArtifactRegistry
  private readonly getFileDiff: ArtifactContentServiceOptions['getFileDiff']
  private readonly probeImagePixels: ArtifactImageProbe | undefined
  private readonly maxCacheBytes: number
  private readonly cache = new Map<string, CacheEntry>()
  private cacheBytes = 0

  constructor(options: ArtifactContentServiceOptions) {
    this.registry = options.registry
    this.getFileDiff = options.getFileDiff
    this.probeImagePixels = options.probeImagePixels
    this.maxCacheBytes = options.maxCacheBytes ?? ARTIFACT_LIMITS.maxCacheBytes
  }

  async getContent(taskId: string, artifactId: string): Promise<ArtifactContent> {
    const descriptor = await this.registry.get(taskId, artifactId)
    if (descriptor.kind === 'diff') return this.readDiff(taskId, descriptor)

    const cacheKey = contentCacheKey(descriptor)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      this.cache.delete(cacheKey)
      this.cache.set(cacheKey, cached)
      return { ...cached.content, descriptor }
    }

    const { bytes } = await this.registry.readVerifiedBytes(taskId, artifactId)
    const content = this.projectFileContent(descriptor, bytes)
    this.remember(cacheKey, content)
    return content
  }

  /** Viewer 关闭后可丢掉图片缓存，避免大图长期占着主进程内存。 */
  evict(artifactId: string): void {
    for (const [key, entry] of this.cache) {
      if (!key.startsWith(`${artifactId}:`)) continue
      this.cache.delete(key)
      this.cacheBytes -= entry.bytes
    }
  }

  private async readDiff(taskId: string, descriptor: ArtifactDescriptor): Promise<ArtifactContent> {
    if (descriptor.location.kind !== 'diff') {
      throw new ArtifactRegistryError('not-file', 'Diff Artifact 引用无效。')
    }
    const diff = await this.getFileDiff(taskId, descriptor.location.path)
    return { kind: 'diff', diff, descriptor }
  }

  private projectFileContent(descriptor: ArtifactDescriptor, bytes: Buffer): ArtifactContent {
    if (descriptor.kind === 'image') {
      const pixels = this.probeImagePixels?.(bytes)
      if (!pixels) throw new ArtifactRegistryError('mime-mismatch', '无法解码该图片。')
      if (pixels.width * pixels.height > ARTIFACT_LIMITS.maxImagePixels) {
        throw new ArtifactRegistryError('too-large', '图片像素超过上限。')
      }
      return {
        kind: 'image',
        mimeType: descriptor.mimeType,
        imageBase64: bytes.toString('base64'),
        descriptor
      }
    }

    const decoded = decodeUtf8Text(bytes)
    if (descriptor.kind === 'markdown') {
      const { text, truncated } = truncateUtf8(
        sanitizeArtifactMarkdown(decoded),
        ARTIFACT_LIMITS.maxTextBytes
      )
      const content: ArtifactContent = { kind: 'markdown', markdown: text, descriptor }
      if (truncated) content.truncated = true
      return content
    }

    const { text, truncated } = truncateUtf8(decoded, ARTIFACT_LIMITS.maxTextBytes)
    const content: ArtifactContent = { kind: 'text', text, descriptor }
    if (truncated) content.truncated = true
    return content
  }

  private remember(key: string, content: ArtifactContent): void {
    const bytes = estimateContentBytes(content)
    if (bytes > this.maxCacheBytes) return
    while (this.cacheBytes + bytes > this.maxCacheBytes) {
      const oldest = this.cache.keys().next().value
      if (!oldest) break
      const entry = this.cache.get(oldest)
      this.cache.delete(oldest)
      if (entry) this.cacheBytes -= entry.bytes
    }
    this.cache.set(key, { key, bytes, content })
    this.cacheBytes += bytes
  }
}

function contentCacheKey(descriptor: ArtifactDescriptor): string {
  return `${descriptor.artifactId}:${descriptor.revision}:${descriptor.contentHash}`
}

function decodeUtf8Text(bytes: Buffer): string {
  const sliced =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  if (sliced.includes(0)) throw new ArtifactRegistryError('nul', '文本内容包含非法空字符。')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(sliced)
  } catch {
    throw new ArtifactRegistryError('binary-text', '文本内容不是合法 UTF-8。')
  }
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let end = text.length
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) end -= 1
  return { text: text.slice(0, end), truncated: true }
}

function estimateContentBytes(content: ArtifactContent): number {
  if (content.kind === 'image') return Buffer.byteLength(content.imageBase64, 'utf8')
  if (content.kind === 'markdown') return Buffer.byteLength(content.markdown, 'utf8')
  if (content.kind === 'text') return Buffer.byteLength(content.text, 'utf8')
  return Buffer.byteLength(content.diff.unifiedDiff ?? '', 'utf8')
}
