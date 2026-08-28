import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ArtifactDescriptor } from '../../shared/artifact'
import {
  artifactAvailabilityLabel,
  artifactKindLabel,
  formatArtifactSize,
  groupArtifactsByTurn
} from './task-artifacts-presentation'

function artifact(overrides: Partial<ArtifactDescriptor> = {}): ArtifactDescriptor {
  return {
    artifactId: 'art-1',
    projectId: 'project-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    kind: 'markdown',
    title: 'README.md',
    mimeType: 'text/markdown',
    source: 'git-review',
    environmentId: 'local:env',
    location: { kind: 'file', relativePath: 'README.md' },
    size: 12,
    contentHash: 'abc',
    createdAt: '2026-08-28T00:00:00.000Z',
    trustLevel: 'verified',
    availability: 'ready',
    revision: 1,
    ...overrides
  }
}

describe('产物展示', () => {
  it('按 Turn 分组并保留变化/缺失状态文案', () => {
    const groups = groupArtifactsByTurn([
      artifact({ artifactId: 'a2', turnId: 'turn-2', createdAt: '2026-08-28T01:00:00.000Z' }),
      artifact({ artifactId: 'a1', title: 'note.md' })
    ])
    expect(groups.map((group) => group.turnId)).toEqual(['turn-1', 'turn-2'])
    expect(artifactKindLabel('markdown')).toBe('Markdown')
    expect(artifactAvailabilityLabel('changed')).toBe('源文件已变化')
    expect(artifactAvailabilityLabel('missing')).toBe('源文件缺失')
    expect(formatArtifactSize(2048)).toBe('2 KB')
  })
})

describe('产物面板源码约束', () => {
  it('Inspector 挂载 TaskArtifactsPanel，Viewer 不走 v-html', () => {
    const rendererDir = dirname(fileURLToPath(import.meta.url))
    const inspector = readFileSync(join(rendererDir, 'components/TaskInspector.vue'), 'utf8')
    const markdown = readFileSync(
      join(rendererDir, 'components/MarkdownArtifactViewer.vue'),
      'utf8'
    )
    const panel = readFileSync(join(rendererDir, 'components/TaskArtifactsPanel.vue'), 'utf8')
    expect(inspector).toContain('TaskArtifactsPanel')
    expect(inspector).toContain('artifactsController')
    expect(panel).toContain('groupArtifactsByTurn')
    expect(markdown).toContain('AssistantMarkdown')
    expect(markdown).not.toContain('v-html')
  })
})
