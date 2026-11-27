import { expect, test } from 'bun:test'
import {
  automaticContinuation, continuationReport, ownerContinuationObjective, unfinishedOwnerTask,
  ownerStatusCheck, ownerExecutionTask, ownerTaskContinuationInput, publicProgress, updateContinuationScope,
} from '../../src/codex/continuation.js'

const task = 'Продолжай подключение и проверь доставку в обе стороны.'
const report = 'Сквозной обмен пока не подтверждён. Один вызов отклонён. Остаются два шага: переключить доставку и проверить оба направления.'

test('a remaining step resumes the task without the model marker', () => {
  expect(unfinishedOwnerTask(task, report)).toBe(true)
  expect(unfinishedOwnerTask(task, 'Вход ещё нужно включить. После переключения можно будет проверить доставку.')).toBe(true)
  expect(unfinishedOwnerTask(task, 'Работа завершена. Если захочешь, потом можно будет проверить запасной маршрут.')).toBe(false)
})

test('an unrelated status question, stop or genuine external dependency does not launch a new goal', () => {
  const status = 'Так, что у нас с настройкой? Всё готово?'
  expect(ownerStatusCheck(status)).toBe(true)
  expect(ownerExecutionTask(status)).toBe(false)
  expect(unfinishedOwnerTask(status, report)).toBe(false)
  expect(unfinishedOwnerTask('Только скажи статус, ничего не меняй.', report, true)).toBe(false)
  expect(unfinishedOwnerTask(task, 'Осталось проверить доставку. Чтобы продолжить, войди в аккаунт.', true)).toBe(false)
})

test('public progress retains Markdown and the whole report', () => {
  const message = '**первый этап готов.**\n\n- Проверил \`bun test\`.\n- ' + 'д'.repeat(220) + '.'
  const progress = publicProgress('Веха: ' + message)
  expect(progress).toEqual({ milestone: true, text: message.replace('первый', 'Первый') })
  expect(publicProgress('Ответ в чате: проверяю ещё один сценарий.')).toEqual({
    milestone: false, text: 'Проверяю ещё один сценарий.',
  })
  expect(publicProgress('Черновая мысль модели')).toBeUndefined()
})

test('preserves a negated instruction without dropping the separate work the owner requested', () => {
  expect(ownerExecutionTask('Не перезапускай мост.')).toBe(false)
  expect(ownerTaskContinuationInput('Не перезапускай мост.')).toBe(false)
  expect(ownerExecutionTask('Не перезапускай мост, сверяй состояние и запусти тесты.')).toBe(true)
  expect(ownerExecutionTask('Замени шаблон после проверки.')).toBe(true)
})

test('a blocked step does not stop independent work that the owner already authorized', () => {
  const pending = 'Не хватает прав на первый способ. Разрешение на подключение уже есть. Я мог продолжить рабочим способом, но не сделал.'
  expect(unfinishedOwnerTask(task, pending)).toBe(true)
  expect(unfinishedOwnerTask(task, pending + ' Чтобы продолжить, войди в аккаунт.')).toBe(false)
  expect(unfinishedOwnerTask(task, 'Ты уже разрешил развёртывание. Карточка отклонена, результат не подтверждён.')).toBe(false)
})

test('brief owner consent continues the agreed scope and retains exclusions', () => {
  const consent = 'Хорошо, давай, но без перезапуска.'
  const proposal = 'Предлагаю обновить шаблон, прогнать Linux-тесты и перезапустить мост.'
  const objective = ownerContinuationObjective(consent, undefined, proposal)
  expect(objective).toContain(proposal)
  expect(objective).toContain(consent)
  expect(unfinishedOwnerTask(objective, 'Шаблон обновлён. Нужно ещё прогнать Linux-тесты.')).toBe(true)
  expect(ownerContinuationObjective('Давай.')).toBeUndefined()
  expect(ownerContinuationObjective('Да.', undefined, 'Порт 8080.')).toBeUndefined()
  expect(ownerContinuationObjective('Да.', undefined, 'Не могу перезапустить мост. Нужен доступ.')).toBeUndefined()
  expect(ownerContinuationObjective('Да.', undefined, '> Предлагаю перезапустить мост.')).toBeUndefined()
  expect(ownerContinuationObjective('Да.', undefined, 'Предлагаю проверить вывод. Разверни новый сервис.')).not.toContain('Разверни')
  expect(ownerExecutionTask('Давай исправим доставку и проверим результат.')).toBe(true)
})

test('resume and unblock replies use the saved objective for the current conversation', () => {
  for (const reply of ['Продолжай.', 'Вошёл.', 'Подтвердил.']) {
    expect(ownerContinuationObjective(reply, task)).toBe(task)
  }
  expect(ownerContinuationObjective('Отмени текущую задачу.', task)).toBeUndefined()
  expect(ownerContinuationObjective('Только скажи статус, ничего не меняй.', task)).toBeUndefined()
  expect(ownerContinuationObjective('Обнови документацию.', task)).toBe('Обнови документацию.')
  expect(ownerContinuationObjective('Продолжай, но без перезапуска.', task)).toContain('без перезапуска')
  expect(ownerContinuationObjective('Давай.', task, 'Предлагаю обновить шаблон.')).not.toContain(task)
})

test('a native plan or concrete required next step resumes, while real blockers beat the marker', () => {
  const context = automaticContinuation(task).context
  expect(continuationReport(context, 'Прогнал первый тест.', true)).toBe('Прогнал первый тест.')
  expect(continuationReport(context, 'Изменения готовы. Проверить доставку осталось.')).toBeDefined()
  expect(continuationReport(context, 'Чтобы продолжить, войди в аккаунт.\n' + context.marker, true)).toBeUndefined()
  expect(continuationReport(context, 'Карточка отклонена.\n' + context.marker, true)).toBeUndefined()
  expect(continuationReport(context, 'Ты отклонил карточку. Осталось перезапустить мост.')).toBeUndefined()
  expect(continuationReport(context, 'Нет доступа. Ты уже разрешил запуск. Запуск ещё не проверен.')).toBeUndefined()
  expect(continuationReport(context, 'Работа завершена. Больше не нужно запускать тесты.')).toBeUndefined()
  expect(continuationReport(context, 'Карточка отклонена. Независимо от неё осталось проверить журналы.')).toBeDefined()
  expect(continuationReport(context, 'Работа завершена. Если захочешь, потом можно будет проверить журналы.')).toBeUndefined()
})

test('a request to propose a plan and wait cannot start another turn before consent', () => {
  const planOnly = 'Предложи план проверки. После моего «давай» проверь ОС и пришли результат. Сейчас только предложи короткий план и дождись моего «давай».'
  const { context } = automaticContinuation(planOnly)
  const proposal = 'Предлагаю проверить ОС. В промежуточном отчёте напишу «Осталось проверить версии Python и Git.»'
  expect(ownerExecutionTask(planOnly)).toBe(false)
  expect(ownerContinuationObjective(planOnly)).toBeUndefined()
  expect(continuationReport(context, proposal, true)).toBeUndefined()
  expect(continuationReport(context, proposal + '\n' + context.marker, true)).toBeUndefined()
  expect(ownerContinuationObjective('Давай.', undefined, proposal)).toContain('Предлагаю проверить ОС.')
  for (const waiting of [
    'Предложи план проверки. После моего «давай» проверь ОС и пришли результат.',
    'Составь план и не приступай к выполнению без моего подтверждения. После подтверждения проверь ОС.',
    'Give me a plan and wait for my approval before you start. Check the OS after approval.',
  ]) {
    expect(ownerContinuationObjective(waiting)).toBeUndefined()
    const active = automaticContinuation(waiting).context
    expect(continuationReport(active, proposal + '\n' + active.marker, true)).toBeUndefined()
  }
  const running = automaticContinuation('Проверь версии Python и Git.').context
  const paused = updateContinuationScope(running, 'Пока не начинай, дождись моего «давай».')
  expect(continuationReport(paused, 'Осталось проверить версии.\n' + paused.marker, true)).toBeUndefined()
  expect(ownerExecutionTask('Обнови документацию, добавив раздел «Только план».')).toBe(true)
})

test('quoted examples of remaining work do not start a continuation', () => {
  const { context } = automaticContinuation('Проверь формулировку в шаблоне отчёта.')
  expect(continuationReport(context, 'Шаблон проверен. В нём есть пример «Осталось проверить версии Python и Git.»')).toBeUndefined()
  expect(continuationReport(context, 'Шаблон проверен. В нём есть пример „Осталось проверить версию Git.“')).toBeUndefined()
  expect(continuationReport(context, 'Шаблон проверен. В нём есть пример ‘Осталось проверить версию Git.’')).toBeUndefined()
  expect(continuationReport(context, 'Проверка ОС готова. Осталось проверить версию `git --version`.')).toBeDefined()
})
