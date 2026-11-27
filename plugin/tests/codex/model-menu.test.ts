import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SendMessageOpts } from '../../src/channel/tools.js'
import { ControlState } from '../../src/codex/control-state.js'
import { ModelMenu, STALE_MODEL_MENU } from '../../src/codex/model-menu.js'
import type { CodexModel } from '../../src/codex/reasoning.js'

function fixture(root: string, defaultModel: string | null = 'gpt-configured') {
  const controls = new ControlState(root, false)
  const sent: SendMessageOpts[] = []
  const confirmations: Array<{ id: number; text: string }> = []
  let catalog: CodexModel[] = [
    { name: 'gpt-other', default: false }, { name: 'gpt-default', default: true },
  ]
  let edited: SendMessageOpts | undefined
  let currentModel: string | undefined
  const menu = new ModelMenu({
    ownerId: 42, chat: '42', controls, defaultModel: defaultModel ?? undefined,
    currentModel: () => currentModel,
    models: async () => catalog,
    telegram: {
      async sendMessage(_chat, _text, options) {
        sent.push(options)
        return { message_id: sent.length + 100 }
      },
      async editMessageText(_chat, id, text, options) {
        edited = options
        confirmations.push({ id, text })
      },
    },
  })
  const rendered = () => sent.at(-1)?.reply_markup?.inline_keyboard.flat() ?? []
  const query = () => ({ fromId: 42, chatId: 42, chatType: 'private', messageId: sent.length + 100,
    data: rendered().find(button => button.text === 'gpt-other')!.callback_data! })
  const effortButtons = () => edited?.reply_markup?.inline_keyboard.flat() ?? []
  return { controls, menu, rendered, query, confirmations, effortButtons,
    setCatalog: (next: typeof catalog) => { catalog = next },
    setCurrentModel: (name: string) => { currentModel = name },
  }
}

test('effort opens levels for the current model and saves only the level', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-model-menu-'))
  try {
    const { controls, menu, rendered, setCatalog, setCurrentModel } = fixture(root, null)
    setCatalog([
      { name: 'gpt-default', default: true, reasoningEfforts: ['medium'] },
      { name: 'gpt-other', default: false, reasoningEfforts: ['low', 'high'] },
    ])
    setCurrentModel('gpt-other')
    await menu.openEffort()
    expect(rendered().map(button => button.text)).toEqual(['low', '✓ high'])
    const choice = { fromId: 42, chatId: 42, chatType: 'private', messageId: 101,
      data: rendered()[0]!.callback_data! }
    expect(await menu.answer({ ...choice, fromId: 15 })).toBeUndefined()
    setCurrentModel('gpt-default')
    expect(await menu.answer(choice)).toBe(STALE_MODEL_MENU)
    expect(controls.reasoningEffort).toBeUndefined()
    setCurrentModel('gpt-other')
    expect(await menu.answer(choice)).toBe('Уровень рассуждений: low')
    expect(new ControlState(root, false)).toMatchObject({ model: undefined, reasoningEffort: 'low' })
    expect(await menu.answer(choice)).toBe(STALE_MODEL_MENU)
    controls.selectModel('gpt-default', 'medium')
    await menu.openEffort()
    expect(rendered().map(button => button.text)).toEqual(['✓ medium'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('model buttons open supported reasoning levels and persist the pair for the next turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-model-menu-'))
  try {
    const { controls, menu, query, setCatalog, effortButtons } = fixture(root)
    const defaultModel: CodexModel = { name: 'gpt-default', default: true, reasoningEfforts: ['low'], defaultReasoningEffort: 'low' }
    const other: CodexModel = { name: 'gpt-other', default: false, reasoningEfforts: ['low', 'high', 'ultra'], defaultReasoningEffort: 'low' }
    setCatalog([defaultModel, other])
    await menu.open()
    const model = query()
    await menu.answer(model)
    expect(controls.model).toBeUndefined()
    expect(effortButtons().map(button => button.text)).toEqual(['low', '✓ high', 'ultra'])
    expect(await menu.answer(model)).toBe(STALE_MODEL_MENU)
    const choice = { ...model, data: effortButtons()[2]!.callback_data! }
    expect(await menu.answer({ ...choice, fromId: 15 })).toBeUndefined()
    expect(await menu.answer({ ...choice, messageId: 5 })).toBe(STALE_MODEL_MENU)
    setCatalog([defaultModel, { ...other, reasoningEfforts: ['low', 'high'] }])
    expect(await menu.answer(choice)).toContain('недоступен')
    expect(controls.model).toBeUndefined()
    setCatalog([defaultModel, other])
    await menu.answer(choice)
    expect(new ControlState(root, false)).toMatchObject({ model: 'gpt-other', reasoningEffort: 'ultra' })
    controls.selectMirror(true)
    expect(new ControlState(root, false).reasoningEffort).toBe('ultra')
    expect(await menu.choose('gpt-default')).toContain('low')
    expect(new ControlState(root, false)).toMatchObject({ model: 'gpt-default', reasoningEffort: undefined })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('model buttons are owner-only, bound to the menu message and persisted for later turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-model-menu-'))
  try {
    const { controls, menu, rendered, query, confirmations } = fixture(root)
    await menu.open()
    expect(rendered().map(button => button.text)).toEqual(['gpt-default', 'gpt-other'])
    const choice = query()
    expect(await menu.answer({ ...choice, fromId: 15 })).toBeUndefined()
    expect(await menu.answer({ ...choice, chatId: 15 })).toBeUndefined()
    expect(await menu.answer({ ...choice, chatType: 'group' })).toBeUndefined()
    expect(await menu.answer({ ...choice, messageId: 5 })).toBe(STALE_MODEL_MENU)
    expect(await menu.answer({ ...choice, data: choice.data.replace(/:\d+$/u, ':99') })).toBe(STALE_MODEL_MENU)
    expect(controls.model).toBeUndefined()
    expect(await menu.answer(choice)).toBe('Модель: gpt-other')
    expect(new ControlState(root, false).model).toBe('gpt-other')
    expect(confirmations).toEqual([{ id: choice.messageId, text: 'Модель для следующих запросов: gpt-other' }])
    expect(await menu.answer(choice)).toBe(STALE_MODEL_MENU)
    await menu.open()
    expect(rendered().map(button => button.text)).toEqual(['gpt-default', '✓ gpt-other'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('older menus and removed models cannot override the selection, and text commands still work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krotov-model-menu-'))
  try {
    const { controls, menu, query, setCatalog } = fixture(root)
    await menu.open()
    const earlier = query()
    await menu.open()
    expect(await menu.answer(earlier)).toBe(STALE_MODEL_MENU)
    setCatalog([{ name: 'gpt-default', default: true }])
    expect(await menu.answer(query())).toBe('Такой модели нет в списке /cc model.')
    expect(await menu.choose('invalid')).toBe('Такой модели нет в списке /cc model.')
    expect(controls.model).toBeUndefined()
    expect(await menu.choose('gpt-default')).toContain('gpt-default')
    expect(await menu.choose('default')).toContain('gpt-configured')
    expect(new ControlState(root, false).model).toBe('gpt-configured')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
