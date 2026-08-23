import type * as acp from '@agentclientprotocol/sdk'
import type { TaskAttachmentKind } from '../../../shared/task-attachment'

export const EMPTY_PROMPT_WITH_ATTACHMENTS = '请查看附件。'

export interface GrokPromptAttachment {
  fileName: string
  mimeType: string
  kind: TaskAttachmentKind
  bytes: Buffer
}

function attachmentUri(fileName: string): string {
  return `attachment://${encodeURIComponent(fileName)}`
}

/** 按握手能力组 ACP Prompt 块：未声明 image 时不得发 Image。 */
export function buildGrokPromptContentBlocks(input: {
  prompt: string
  attachments: readonly GrokPromptAttachment[]
  promptImage: boolean
  embeddedContext: boolean
}): acp.ContentBlock[] {
  const text =
    input.prompt.trim() || (input.attachments.length > 0 ? EMPTY_PROMPT_WITH_ATTACHMENTS : '')
  const blocks: acp.ContentBlock[] = [{ type: 'text', text }]

  for (const attachment of input.attachments) {
    if (attachment.kind === 'image' && input.promptImage) {
      blocks.push({
        type: 'image',
        mimeType: attachment.mimeType,
        data: attachment.bytes.toString('base64')
      })
      continue
    }
    if (!input.embeddedContext) continue
    if (attachment.kind === 'text') {
      blocks.push({
        type: 'resource',
        resource: {
          uri: attachmentUri(attachment.fileName),
          mimeType: attachment.mimeType,
          text: attachment.bytes.toString('utf8')
        }
      })
      continue
    }
    blocks.push({
      type: 'resource',
      resource: {
        uri: attachmentUri(attachment.fileName),
        mimeType: attachment.mimeType,
        blob: attachment.bytes.toString('base64')
      }
    })
  }

  return blocks
}
