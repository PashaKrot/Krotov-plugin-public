import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexInbox } from '../../src/codex/inbox.js'
import { splitMessage } from '../../src/format/chunk.js'
import { markdownToTelegramHtml } from '../../src/format/html.js'
import { deliverReplyPart, plannedTextParts, type PartStatus } from '../../src/codex/reply-delivery.js'

test('skips confirmed parts and interrupted sends, and retries proven pre-send failures', async () => {
  const saved = new Map<string, PartStatus>([['text:0', 'sent'], ['file:0', 'sending']])
  const invoke = (key: string, send: () => Promise<object>) => deliverReplyPart(
    saved.get(key), state => { if (state) saved.set(key, state); else saved.delete(key) }, send,
  )
  const calls: string[] = []
  const send = async (label: string) => { calls.push(label); return { message_id: 17 } }
  expect((await invoke('text:0', () => send('old text'))).state).toBe('sent')
  expect((await invoke('file:0', () => send('uncertain file'))).state).toBe('uncertain')
  await expect(invoke('file:1', async () => {
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' })
  })).rejects.toThrow('offline')
  expect(saved.has('file:1')).toBe(false)
  expect((await invoke('file:1', () => send('new file'))).state).toBe('sent')
  expect(calls).toEqual(['new file'])
})

const owner = { id: 100, is_bot: false as const, first_name: 'Owner' }
const prose = Array.from({ length: 60 }, (_, index) =>
  `Проверка ${index + 1} сохраняет результат на диске и возвращает точное состояние после перезапуска.`).join(' ')

function prepareReply(root: string, text: string): CodexInbox {
  const inbox = new CodexInbox(root, owner.id)
  inbox.receive({ message_id: 7, date: 1, chat: { id: owner.id, type: 'private', first_name: owner.first_name },
    from: owner, text: 'Проверь доставку' })
  inbox.take()
  inbox.start(7, { mayRestartBridge: true })
  inbox.complete(7, { text, files: ['/work/check.txt'] }, false, true, true)
  return inbox
}

test('resumes an unversioned partially delivered Krotov reply with the old chunk boundaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-old-reply-'))
  try {
    let inbox = prepareReply(root, prose)
    const oldParts = splitMessage(markdownToTelegramHtml(prose))
    expect(oldParts).toHaveLength(2)
    inbox.setReplyPart(7, 'rich', 'fallback')
    inbox.setReplyPart(7, 'text:0', 'sent')
    inbox.setReplyPart(7, 'file:0', 'sent')
    inbox = new CodexInbox(root, owner.id)

    const delivered: string[] = []
    for (const [index, part] of plannedTextParts(inbox, 7, prose).entries()) {
      const key = 'text:' + index
      await deliverReplyPart(inbox.replyPart(7, key), state => inbox.setReplyPart(7, key, state), async () => {
        delivered.push(part)
        return { message_id: 20 + index }
      })
    }

    expect(delivered).toEqual(oldParts.slice(1))
    expect(inbox.replyPart(7, 'file:0')).toBe('sent')
    expect(inbox.active?.outcome).toMatchObject({ restartBridge: true, restartVerification: true })
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('saves the laid-out HTML before sending and retains it through cancellation and restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-new-reply-'))
  try {
    let inbox = prepareReply(root, prose)
    inbox.setReplyPart(7, 'rich', 'fallback')
    const parts = plannedTextParts(inbox, 7, prose)
    expect(parts.join('')).toContain('\n\n')
    expect(parts).not.toEqual(splitMessage(markdownToTelegramHtml(prose)))
    inbox.setReplyPart(7, 'file:0', 'sent')

    inbox = new CodexInbox(root, owner.id)
    expect(inbox.active?.outcome).toMatchObject({ restartBridge: true, restartVerification: true })
    inbox.cancelContinuation()
    inbox = new CodexInbox(root, owner.id)
    expect(plannedTextParts(inbox, 7, 'Different formatting input')).toEqual(parts)
    expect(inbox.replyPart(7, 'file:0')).toBe('sent')
    expect(inbox.active?.outcome).not.toHaveProperty('restartBridge')
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('groups prose without changing Markdown links, table rows or fenced code', () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-markup-reply-'))
  try {
    const text = [
      '**Отчёт**',
      'Сравнили три варианта.',
      'Первый прошёл проверку.',
      'Детали в [отчёте](https://example.com/report).',
      'Название | Результат',
      '--- | ---',
      'Сводка | Готово',
      '\x60\x60\x60text',
      'Пробелы   сохраняются.'.repeat(30),
      '\x60\x60\x60',
    ].join('\n')
    const parts = plannedTextParts(prepareReply(root, text), 7, text)
    const grouped = markdownToTelegramHtml(text.replace('**Отчёт**\n', '**Отчёт**\n\n'))
    expect(parts.join('')).toBe(grouped)
  } finally { rmSync(root, { force: true, recursive: true }) }
})
