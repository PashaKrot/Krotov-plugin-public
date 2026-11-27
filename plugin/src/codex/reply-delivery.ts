import { splitMessage } from '../format/chunk.js'
import { markdownToTelegramHtml } from '../format/html.js'
import { splitLongBlock } from '../format/paragraphs.js'
import { classifySendError } from '../safety/reliable-telegram-api.js'

export type PartStatus = 'sending' | 'sent' | 'fallback' | 'failed' | 'uncertain'

export async function deliverReplyPart<T>(
  previous: PartStatus | undefined,
  persist: (state: PartStatus | undefined) => void,
  send: () => Promise<T>,
  needsFallback?: (value: T) => boolean,
): Promise<{ state: Exclude<PartStatus, 'sending'>; value?: T }> {
  if (previous === 'sending') {
    persist('uncertain')
    return { state: 'uncertain' }
  }
  if (previous) return { state: previous }
  persist('sending')
  let value: T
  try {
    value = await send()
  } catch (error) {
    const { kind } = classifySendError(error, 30_000)
    if (kind === 'pre_send' || kind === 'rate_limited') {
      persist(undefined)
      throw error
    }
    const state = kind === 'ambiguous' ? 'uncertain' : 'failed'
    persist(state)
    return { state }
  }
  const state = needsFallback?.(value) ? 'fallback' : 'sent'
  persist(state)
  return { state, value }
}

interface ReplyReceipts {
  replyPart(id: number, key: string): PartStatus | undefined
  replyPlan(id: number): readonly string[] | undefined
  setReplyPlan(id: number, parts: readonly string[]): void
}

/** Saves the exact HTML chunks before their numbered delivery receipts are written. */
export function plannedTextParts(receipts: ReplyReceipts, id: number, normalizedText: string): string[] {
  const saved = receipts.replyPlan(id)
  if (saved) return [...saved]
  // Unversioned Krotov receipts count chunks from the original, ungrouped text.
  const text = receipts.replyPart(id, 'text:0') === undefined ? splitLongBlock(normalizedText) : normalizedText
  const parts = splitMessage(markdownToTelegramHtml(text))
  if (parts.length > 0) receipts.setReplyPlan(id, parts)
  return parts
}
