import { expect, test } from 'bun:test'
import type { TelegramApi } from '../../src/channel/tools.js'
import { createLogger } from '../../src/log.js'
import { createRateLimitedTelegramApi } from '../../src/safety/rate-limited-telegram-api.js'

function rawApi(methods: Partial<TelegramApi>): TelegramApi {
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected raw Telegram call') }
  return {
    sendMessage: unexpected, sendRichMessage: unexpected, editMessageText: unexpected,
    setMessageReaction: unexpected, sendChatAction: unexpected, sendDocument: unexpected,
    sendPhoto: unexpected, downloadFile: unexpected, deleteMessage: unexpected, answerGuestQuery: unexpected,
    ...methods,
  }
}

function floodWait(seconds: number) {
  return Object.assign(new Error('Too Many Requests'), { error_code: 429, parameters: { retry_after: seconds } })
}

test('a fail-fast edit arms its full flood wait for the next send in another chat', async () => {
  let now = 5_000
  const sentAt: number[] = []
  const api = createRateLimitedTelegramApi(rawApi({
    async editMessageText() { throw floodWait(80) },
    async sendMessage() {
      sentAt.push(now)
      return { message_id: 1 }
    },
  }), createLogger('telegram-rate-test'), {
    jitterMaxMs: 0, now: () => now, sleep: async ms => { now += ms },
  })

  await expect(api.editMessageText('owner', 1, 'status', {})).rejects.toMatchObject({ error_code: 429 })
  expect(now).toBe(5_000)
  await api.sendMessage('other-chat', 'reply', {})
  expect(sentAt).toEqual([85_000])
})

test('a pending retry obeys a newer flood wait set while it was sleeping', async () => {
  let now = 5_000
  const sleeping = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const attempts: number[] = []
  const api = createRateLimitedTelegramApi(rawApi({
    async sendMessage() {
      attempts.push(now)
      if (attempts.length === 1) throw floodWait(1)
      return { message_id: 1 }
    },
    async setMessageReaction() { throw floodWait(30) },
  }), createLogger('telegram-rate-test'), {
    jitterMaxMs: 0, now: () => now,
    sleep: async ms => {
      if (ms === 1_000) {
        sleeping.resolve()
        await resume.promise
      }
      now += ms
    },
  })

  const send = api.sendMessage('owner', 'retry me', {})
  await sleeping.promise
  try {
    await expect(api.setMessageReaction('other-chat', 1, '👀')).rejects.toMatchObject({ error_code: 429 })
  } finally { resume.resolve() }
  await send
  expect(attempts).toEqual([5_000, 35_000])
})
