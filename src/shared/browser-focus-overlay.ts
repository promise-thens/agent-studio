import { z } from 'zod'
import type { DesktopIpcResult } from './ipc-result'

export const BROWSER_FOCUS_CHANNELS = {
  publish: 'app:browser-focus-publish',
  snapshot: 'app:browser-focus-snapshot',
  intent: 'app:browser-focus-intent',
  ownerIntent: 'app:browser-focus-owner-intent',
  read: 'app:browser-focus-read'
} as const

export const BROWSER_FOCUS_MAX_DRAFT = 64 * 1024
const text = (max: number): z.ZodString =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes('\0') && new TextEncoder().encode(value).length <= max)
const identity = text(256).min(1)
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const coordinate = z.number().finite().min(0).max(32768)
const executionSchema = z
  .object({
    executionId: identity,
    taskId: identity,
    turnId: identity
  })
  .strict()

const snapshotSchema = z
  .object({
    projectionId: identity,
    taskId: identity,
    revision: counter,
    draftAck: counter,
    visible: z.boolean(),
    draft: text(BROWSER_FOCUS_MAX_DRAFT),
    taskTitle: text(512),
    status: text(1024),
    modelLabel: text(512),
    attachmentCount: z.number().int().min(0).max(100),
    canSend: z.boolean(),
    textareaDisabled: z.boolean(),
    execution: executionSchema.nullable(),
    theme: z.enum(['dark', 'light']),
    browserBounds: z
      .object({
        x: coordinate,
        y: coordinate,
        width: coordinate,
        height: coordinate
      })
      .strict(),
    /** 最新一条模型回复纯文本，用于浮层展开卡片展示（最大 32KB，允许为 null） */
    latestAssistantMessage: text(32 * 1024).nullable()
  })
  .strict()

const intentBase = { projectionId: identity, revision: counter }
const intentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...intentBase,
      kind: z.literal('draft'),
      sequence: counter,
      text: text(BROWSER_FOCUS_MAX_DRAFT)
    })
    .strict(),
  z.object({ ...intentBase, kind: z.literal('send') }).strict(),
  z.object({ ...intentBase, kind: z.literal('stop'), execution: executionSchema }).strict(),
  z.object({ ...intentBase, kind: z.literal('expand') }).strict()
])

export type BrowserFocusSnapshot = z.infer<typeof snapshotSchema>
export type BrowserFocusIntent = z.infer<typeof intentSchema>

/** 跨进程仅接受完整有界投影，拒绝附带路径、凭据或其他未知字段。 */
export function parseBrowserFocusSnapshot(value: unknown): BrowserFocusSnapshot | null {
  const result = snapshotSchema.safeParse(value)
  return result.success ? result.data : null
}

/** 浮层事件只有编辑与三个操作，不接受动态 channel 或任意命令。 */
export function parseBrowserFocusIntent(value: unknown): BrowserFocusIntent | null {
  const result = intentSchema.safeParse(value)
  return result.success ? result.data : null
}

export interface BrowserFocusOwnerApi {
  publish(snapshot: BrowserFocusSnapshot): Promise<DesktopIpcResult<null>>
  onIntent(listener: (intent: BrowserFocusIntent) => void): () => void
}

export interface BrowserFocusOverlayApi {
  read(): Promise<DesktopIpcResult<BrowserFocusSnapshot | null>>
  dispatch(intent: BrowserFocusIntent): Promise<DesktopIpcResult<null>>
  onSnapshot(listener: (snapshot: BrowserFocusSnapshot) => void): () => void
}
