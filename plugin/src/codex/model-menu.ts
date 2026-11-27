import { randomBytes } from 'node:crypto'
import type { TelegramApi } from '../channel/tools.js'
import type { ControlState } from './control-state.js'
import { effectiveEffort, type CodexModel, type ReasoningEffort } from './reasoning.js'

export const MODEL_MENU_CALLBACK = /^krot:cm:([a-f0-9]{16}):(\d{1,2})$/u
export const STALE_MODEL_MENU = 'Меню устарело. Открой /cc model заново.'
const unknownModel = 'Такой модели нет в списке /cc model.'

type Menu = { key: string; messageId: number } & (
  { names: string[] } | { model: string; efforts: readonly ReasoningEffort[] }
)

interface ModelMenuOptions {
  ownerId: number
  chat: string
  telegram: Pick<TelegramApi, 'sendMessage' | 'editMessageText'>
  controls: Pick<ControlState, 'model' | 'reasoningEffort' | 'selectModel'>
  models: () => Promise<CodexModel[]>
  defaultModel: string | undefined
}

interface ModelQuery {
  data: string
  fromId: number
  chatId: number | undefined
  chatType: string | undefined
  messageId: number | undefined
}

function keyboard(key: string, values: readonly string[], selected: string | undefined) {
  const buttons = values.map((value, index) => ({
    text: value === selected ? '✓ ' + value : value,
    callback_data: 'krot:cm:' + key + ':' + index,
  }))
  const rows = []
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2))
  return { inline_keyboard: rows }
}

export class ModelMenu {
  private menu: Menu | undefined
  private opening: string | undefined

  constructor(private readonly options: ModelMenuOptions) {}

  async open(): Promise<void> {
    const { chat, controls, defaultModel, telegram } = this.options
    const key = this.opening = randomBytes(8).toString('hex')
    this.menu = undefined
    const catalog = await this.options.models()
    if (this.opening !== key) return
    const models = [...catalog.filter(model => model.default), ...catalog.filter(model => !model.default)].slice(0, 30)
    if (!models.length) {
      await telegram.sendMessage(chat, 'Codex не вернул список моделей.', {})
      return
    }
    const selected = controls.model ?? defaultModel ?? models.find(model => model.default)?.name
    const names = models.map(model => model.name)
    const sent = await telegram.sendMessage(chat, 'Модель Codex для следующих запросов', {
      reply_markup: keyboard(key, names, selected),
    })
    if (this.opening === key) this.menu = { key, names, messageId: sent.message_id }
  }

  async choose(value: string): Promise<string> {
    const models = await this.options.models()
    const name = value === 'default'
      ? this.options.defaultModel ?? models.find(model => model.default)?.name
      : models.find(model => model.name === value)?.name
    if (!name) return unknownModel
    const model = models.find(entry => entry.name === name)
    const previous = value === 'default' ? undefined : this.options.controls.reasoningEffort
    const effort = previous && model?.reasoningEfforts?.includes(previous) ? previous : undefined
    return this.select(name, effort, effectiveEffort(model, effort))
  }

  async answer(query: ModelQuery): Promise<string | undefined> {
    const { chat, ownerId, telegram } = this.options
    if (query.fromId !== ownerId || query.chatId !== ownerId || query.chatType !== 'private') return undefined
    const match = MODEL_MENU_CALLBACK.exec(query.data)
    const menu = this.menu
    if (!match || !menu || match[1] !== menu.key || query.messageId !== menu.messageId) return STALE_MODEL_MENU
    const choice = ('names' in menu ? menu.names : menu.efforts)[Number(match[2])]
    if (!choice) return STALE_MODEL_MENU
    const catalog = await this.options.models()
    if (this.menu !== menu) return STALE_MODEL_MENU
    const model = catalog.find(entry => entry.name === ('names' in menu ? choice : menu.model))
    if (!model) return unknownModel
    const efforts = model.reasoningEfforts
    if ('names' in menu && efforts?.length) {
      const key = randomBytes(8).toString('hex')
      const next = { key, model: model.name, efforts, messageId: menu.messageId }
      this.menu = next
      try {
        await telegram.editMessageText(chat, menu.messageId, 'Уровень рассуждений для ' + model.name, {
          reply_markup: keyboard(key, efforts, effectiveEffort(model, this.options.controls.reasoningEffort)),
        })
      } catch (error) {
        if (this.menu === next) this.menu = menu
        throw error
      }
      return 'Выбери уровень рассуждений'
    }
    const effort = 'efforts' in menu ? menu.efforts[Number(match[2])] : undefined
    if (effort && !efforts?.includes(effort)) return 'Этот уровень сейчас недоступен. Открой /cc model заново.'
    const confirmation = this.select(model.name, effort, effort)
    await telegram.editMessageText(chat, menu.messageId, confirmation, { reply_markup: { inline_keyboard: [] } })
      .catch(() => undefined)
    return effort ? 'Уровень рассуждений: ' + effort : 'Модель: ' + model.name
  }

  private select(name: string, effort?: ReasoningEffort, effective?: ReasoningEffort): string {
    this.options.controls.selectModel(name, effort)
    this.menu = undefined
    this.opening = undefined
    return 'Модель для следующих запросов: ' + name + (effective ? '\nУровень рассуждений: ' + effective : '')
  }
}
