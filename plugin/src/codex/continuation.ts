import { randomUUID } from 'node:crypto'
import type { Message } from 'grammy/types'

const continuationMarker = /(?:^|\r?\n)KROT_CONTINUE_[a-f0-9-]{36}\s*$/u
export type ContinuationContext = { marker: string; objective: string; statusQuestion?: string }

export const followUpInstructions = 'Новая реплика владельца из Telegram во время текущей задачи. ' +
  'Если он задаёт вопрос или просит статус, ответь сразу отдельной публичной репликой «Ответ в чате: …» ' +
  'и продолжай текущую задачу с того же места. Уточнения и изменения задачи примени по смыслу. ' +
  'Отдельное действие, не относящееся к текущей задаче, выполни после её завершения.'

export function normalizeChatReply(text: string): string {
  return text.replace(/^\s*(?:Ответ\s+в\s+чате\s*:|\*\*Ответ\s+в\s+чате(?:\s*:\*\*|\*\*\s*:))\s*/iu, '')
}

export function automaticContinuation(ownerText: string, statusQuestion?: string) {
  const marker = 'KROT_CONTINUE_' + randomUUID()
  const objective = Array.from(ownerText).length <= 4000 ? ownerText :
    'Доведи до проверенного результата исходную задачу, сформулированную владельцем в предыдущем ходе этого диалога.'
  return {
    objective,
    context: { marker, objective, ...(statusQuestion ? { statusQuestion } : {}) },
    instructions: 'Перед финальным ответом сверь каждый согласованный шаг с фактическим результатом и проверкой. ' +
      'Если остался доступный шаг, выполни его сейчас. Ответ на вопрос владельца или отчёт о вехе не завершает работу. ' +
      'Заверши поручение, когда результат проверен или дальнейшая работа действительно требует решения владельца. ' +
      'Если для уже принятой задачи объективно нужен следующий ход Codex и ты можешь продолжать сам, ' +
      'кратко напиши о прогрессе и поставь отдельной последней строкой ' + marker +
      '. Это запустит продолжение в том же диалоге. Используй эту строку только как команду продолжить.',
    take(text: string): string | undefined {
      return takeContinuation(text, { marker, objective })
    },
  }
}

export function takeContinuation(text: string, context: ContinuationContext): string | undefined {
  const match = continuationMarker.exec(text)
  if (!match || match[0].trim() !== context.marker) return undefined
  return text.slice(0, match.index).trimEnd()
}

export function hideContinuationMarker(text: string): string {
  return text.replace(continuationMarker, '')
}

const actionRequest = /(?:^|[^а-яё])(не[\t ]+)?(?:проверь|проверяй|настрой|подключи|поставь|установи|сделай|поправь|исправь|доделай|доделывай|продолжи|продолжай|выполни|выполняй|доведи|перенеси|найди|включи|переключи|обнови|перезапусти|перезапускай|сверь|сверяй|разверни|замени|заменяй|убери|убирай|удали|удаляй|запусти|запускай)(?![а-яё])|\b((?:do not|don't)[\t ]+)?(?:check|configure|install|fix|finish|continue|deploy|enable|update|verify|restart|replace|start)\b/giu
const statusRequest = /(?:что\s+(?:у нас|там|с\s)|как\s+(?:там|ид[её]т|продвигается)|вс[её]\s+готово|какой\s+статус|на\s+каком\s+этапе|что\s+осталось|сколько\s+осталось|what(?:'s| is) (?:the status|left)|how(?:'s| is) (?:it|the work) going)/iu
const statusOnly = /(?:ничего\s+не\s+(?:меняй|делай|запускай)|пока\s+не\s+(?:меняй|запускай|продолжай)|(?:только|просто)\s+(?:скажи|ответь|сообщи|объясни)|\b(?:only|just)\s+(?:tell|explain|answer)\b)/iu
const planOnly = /(?:только|просто)\s+(?:план(?!\p{L})|(?:предложи|составь|покажи|пришли|набросай|подготовь|дай)\s+(?:[\p{L}-]+\s+){0,3}план(?!\p{L}))|\b(?:only|just)\s+(?:propose|draft|outline)\s+(?:a |the )?plan\b/iu
const waitsForOwner = /(?:(?:дождись|жди|после)\s+(?:моего|моей)\s+[«"'„]?(?:давай|го|сигнала|согласия|разрешения|подтверждения|команды)(?!\p{L})|пока\s+не\s+(?:начинай|приступай|выполняй)(?!\p{L})|не\s+(?:начинай|приступай|выполняй)[^.!?\n]{0,80}\s+без\s+моего\s+(?:согласия|разрешения|подтверждения)(?!\p{L})|\b(?:wait\s+for|after)\s+my\s+(?:approval|go-ahead|confirmation)\b)/iu
const howTo = /^(?:(?:подскажи|скажи|объясни|расскажи)[, ]+)?как\s|^(?:tell me )?how\s/iu
const repairQuestion = /^\s*(?:а\s+)?почему\s+(?:ты\s+)?не\s+(?:проверил|сделал|продолжил|закончил)(?![а-яё])/iu
const externalBlocker = /(?:доступ запрещ[её]н|доступа нет|нет доступа|не хватает прав|нужен доступ)/iu
const declined = /(?:карточк[аеи]|запрос)\s+(?:отклон[её]н|запрещ[её]н)|(?:отклонил[аи]?|запретил[аи]?)\s+(?:эту\s+)?(?:карточку|запрос)|(?:approval|request)\s+(?:(?:was|is)\s+)?(?:denied|declined)/iu
const ownerStep = /(?:нужен (?:твой|ваш) вход|чтобы продолжить,\s*(?:введи|войди|открой|нажми)|без (?:твоего|вашего) (?:решения|доступа|входа)|пользователь отменил|нужен\s+(?:один\s+)?запуск\s+из\s+административной\s+сессии|waiting for (?:your approval|you to (?:sign in|log in)))/iu
const acknowledgedGrant = /(?:разрешени[ея]|согласие|разрешил|согласован[оа])[^.!?\n]{0,105}(?:уже (?:есть|дал|выдано|получено)|ранее)|уже (?:разрешил|согласовал)/iu
const remaining = /(?:ещ[её]\s+(?:нужно|надо|предстоит)\s+[а-яё]+ть|остал(?:ось|ся)\s+[а-яё]+ть|оста(?:[её]тся|ются|лось)\s+(?:[а-яё]+\s+){0,3}(?:шаг(?:а|ов)?|действи[ея])\s*:\s*[а-яё]+ть)(?![а-яё])|\b(?:still need to|remaining steps?:)\s+\w+/iu
const afterPrerequisite = /после\s+[^.!?\n]{2,130}\s+можно\s+будет\s+[а-яё]+ть(?![а-яё])/iu
const unfinished = /пока\s+нет|ещ[её]\s+не\s+[а-яё]+|не\s+(?:подтвержден[оаы]?|завершен[оаы]?|проверен[оаы]?|включ[её]н[оаы]?|переключ[её]н[оаы]?)|этого\s+я\s+не\s+(?:сделал|проверил)|мог\s+(?:продолжить|проверить|закончить|сделать)[^.!?\n]{0,135}\s+не\s+(?:сделал|проверил|продолжил)/iu
const optional = /если\s+(?:захочешь|понадобится|хочешь)|по\s+желанию|if (?:needed|you (?:want|prefer))/iu
const jointAction = /^(?:(?:да|хорошо|ок(?:ей)?)[,! .]+)?дава(?:й|йте)\s+(?:сделаем|исправим|поправим|проверим|доделаем|настроим|установим|перенес[её]м|обновим|включим|отключим|добавим|сверим|продолжим|запустим|закончим)(?![а-яё])/iu
const shortConsent = /^(?:(?:да|хорошо|ок(?:ей)?|согласен|подтверждаю)[,! .]+)?(давай(?:те)?|делай|го|продолжай|продолжи|да|согласен|подтверждаю)(?:[\s,]+((?:но\s+)?(?:без|только)\s+[^?\n]{1,160}))?[.!]*$/iu
const unblocked = /^(?:вош[её]л(?:а)?|подтвердил(?:а)?|разрешил(?:а)?|нажал(?:а)?|открыл(?:а)?\s+доступ|доступ\s+выдан)(?:[.,! ]+(?:давай|продолжай|делай))?[.!]*$/iu
const offeredWork = /^(?:(?:я|давай|дальше)\s+)?(?:(?:предлагаю|могу|готова?)\s+[\p{L}-]+(?:ть|ти)(?!\p{L})|предлагаю\s*:|следующий\s+шаг\s*[-—:])/iu
const stepInReport = /(?:(?:остал(?:ось|ся)|надо|нужно|предстоит)\s+(?:ещ[её]\s+)?[\p{L}-]+(?:ть|ти)(?!\p{L})|[\p{L}-]+(?:ть|ти)\s+(?:[^.!?\n]{0,80}\s+)?остал(?:ось|ся)(?!\p{L}))/iu
const independentStep = /(?:независимо\s+от\s+(?:этого|нег[оа]|не[её]|отказа|блокировк[аи]|карточки)|отдельно\s+от\s+этого|без\s+этого\s+(?:доступа|шага|действия)|не\s+требу(?:ет|ют)\s+(?:этого|доступа|нового\s+подтверждения))/iu
const alternativeRoute = /мог\s+(?:продолжить|проверить|закончить|сделать)[^.!?\n]{0,80}(?:другим|рабочим|разреш[её]нным)\s+способом/iu
const negatedStep = /не\s+(?:нужно|надо|требуется|остал(?:ось|ся))\s|(?:уже\s+)?нет\s+(?:оставшихся|обязательных)\s+шагов/iu
const quotedText = /\x60{3}[\s\S]*?\x60{3}|\x60[^\x60\n]*\x60|«[^»]*»|„[^“”\n]*[“”]|“[^”]*”|‘[^’\n]*’|"[^"\n]*"|^\s*>[^\n]*$/gmu

function instructionText(text: string): string {
  return text.replace(quotedText, quote => quote.match(/^[«"“„‘](давай|го)[»"“”’]$/iu)?.[1] ?? ' ')
}

function discussionOnly(text: string): boolean {
  const prose = instructionText(text)
  return statusOnly.test(prose) || planOnly.test(prose) || waitsForOwner.test(prose)
}

export function ownerTaskResume(text: string | undefined): boolean {
  const command = text?.trim() ?? ''
  return shortConsent.test(command) || unblocked.test(command)
}

export function ownerTaskNeedsProposal(text: string | undefined): boolean {
  const command = shortConsent.exec(text?.trim() ?? '')?.[1]
  return !!command && !/^продолж/iu.test(command)
}

export function ownerTaskWithdrawn(text: string | undefined): boolean {
  return /(?:^|[.!?]\s+)(?:пока\s+)?(?:не\s+продолжай|отмени(?:\s+(?:эту|текущую)\s+задачу)?|останови(?:сь|\s+(?:эту|текущую)\s+задачу)?|stop|cancel (?:this|the) task)(?=$|[,!.?])/iu.test(text?.trim() ?? '')
}

export function ownerExecutionTask(text: string | undefined): boolean {
  return !!text && !ownerTaskWithdrawn(text) && !discussionOnly(text) && !howTo.test(text) &&
    (jointAction.test(text.trim()) || Array.from(text.matchAll(actionRequest)).some(match => !match[1] && !match[2]))
}

export function ownerStatusCheck(text: string | undefined): boolean {
  return !!text && statusRequest.test(text) && !discussionOnly(text) && !ownerExecutionTask(text)
}

export function ownerTaskContinuationInput(text: string | undefined): boolean {
  return !!text && !ownerTaskWithdrawn(text) && !discussionOnly(text) && !howTo.test(text) &&
    !ownerStatusCheck(text) && (ownerExecutionTask(text) || repairQuestion.test(text) ||
      !text.trimEnd().endsWith('?') && !Array.from(text.matchAll(actionRequest)).some(match => match[1] || match[2]))
}

export function ownerContinuationObjective(text: string | undefined, pending?: string, previousReport?: string): string | undefined {
  if (!text || ownerTaskWithdrawn(text) || discussionOnly(text) || howTo.test(text)) return undefined
  if (ownerTaskResume(text)) {
    const qualifier = shortConsent.exec(text.trim())?.[2]
    if (pending && (!ownerTaskNeedsProposal(text) || !previousReport || ownerTaskBlocked(previousReport))) {
      if (!qualifier) return pending
      return 'Выполни сохранённое поручение с новым ограничением владельца.\n' +
        'Уточнение владельца: ' + text.trim() + '\nПредыдущее поручение: ' + pending.slice(0, 3600)
    }
    if (!shortConsent.test(text.trim()) || !previousReport) return undefined
    const blocks = previousReport.replace(/\x60{3}[\s\S]*?\x60{3}/gu, '').trim().split(/\r?\n\s*\r?\n/u)
    const proposals = blocks.flatMap(block => {
      const [line = '', ...details] = block.replace(/^[\s*_#-]+/u, '').split(/\r?\n/u)
      const sentence = line.match(/^.*?(?:[.!?](?=\s|$)|$)/u)?.[0] ?? ''
      if (!offeredWork.test(sentence) && (ownerTaskNeedsProposal(text) || ownerTaskBlocked(sentence) ||
          !stepInReport.test(sentence))) return []
      return /^предлагаю\s*:\s*$/iu.test(sentence) ? [
        [sentence, ...details.filter(detail => /^\s*(?:[-*]|\d+[.)])\s+/u.test(detail))].join('\n'),
      ] : [sentence]
    })
    const proposal = proposals.at(-1)
    if (!proposal) return undefined
    return 'Выполни последнее конкретное предложение из этого диалога в объёме, согласованном владельцем.\n' +
      'Ответ владельца и его ограничения: ' + text.trim() + '\nПредыдущее предложение: ' + proposal.slice(0, 3000)
  }
  return ownerTaskContinuationInput(text) ? text : undefined
}

export function directOwnerTask(message: Message, transcript?: string, editing = false): string | undefined {
  if (editing || message.forward_origin) return
  return (message.text ?? message.caption ?? (message.voice ? transcript : undefined))?.trim() || undefined
}

export function updateContinuationScope(context: ContinuationContext, text: string | undefined): ContinuationContext {
  if (!text || (!waitsForOwner.test(instructionText(text)) &&
      !/^(?:(?:хорошо|давай|да|ок(?:ей)?)[, ]+(?:но\s+)?)?(?:уточнение(?:\s+по\s+задаче)?\s*[:,.]|поправка\s*[:,.]|(?:только|без|вместо|не)\s)/iu.test(text)) ||
      /^(?:только|просто)\s+(?:скажи|ответь|сообщи|объясни)/iu.test(text) ||
      ownerStatusCheck(text) || ownerTaskWithdrawn(text)) return context
  const update = 'Актуальное уточнение владельца к объёму поручения: ' + text.slice(0, 1000)
  const objective = context.objective.slice(0, 3900 - update.length) + '\n' + update
  return { ...context, objective }
}

export function ownerTaskBlocked(text: string): boolean {
  return externalBlocker.test(text) || declined.test(text) || ownerStep.test(text)
}

function accessibleRemainingStep(report: string): boolean {
  return report.replace(quotedText, ' ').split(/[.!?\n]/u).some(sentence =>
    !optional.test(sentence) && !negatedStep.test(sentence) && independentStep.test(sentence) &&
    (remaining.test(sentence) || stepInReport.test(sentence)))
}

function requiresOwner(report: string): boolean {
  return (ownerStep.test(report) || declined.test(report)) && !accessibleRemainingStep(report)
}

export function unfinishedOwnerTask(objective: string | undefined, report: string, openPlan = false, redundantAsk = false): boolean {
  if (!objective || !report.trim() || ownerTaskWithdrawn(objective) || discussionOnly(objective) ||
      requiresOwner(report)) return false
  const action = ownerExecutionTask(objective)
  const stated = report.replace(quotedText, ' ')
  if (externalBlocker.test(report)) return action && (accessibleRemainingStep(stated) ||
    acknowledgedGrant.test(stated) && unfinished.test(stated) && alternativeRoute.test(stated))
  if ((action || repairQuestion.test(objective)) && acknowledgedGrant.test(stated) && unfinished.test(stated)) return true
  const steps = stated.split(/[.!?\n]/u).filter(sentence => !optional.test(sentence) && !negatedStep.test(sentence))
  return action && (openPlan || redundantAsk || steps.some(sentence =>
    remaining.test(sentence) || stepInReport.test(sentence) || (unfinished.test(stated) && afterPrerequisite.test(sentence))))
}

export function continuationReport(context: ContinuationContext, report: string, openPlan = false,
  redundantAsk = false): string | undefined {
  if (ownerTaskWithdrawn(context.objective) || discussionOnly(context.objective)) return undefined
  const requested = takeContinuation(report, context)
  const text = requested ?? report.trim()
  if (requiresOwner(text) || (externalBlocker.test(text) &&
      !unfinishedOwnerTask(context.objective, text, openPlan, redundantAsk))) return undefined
  return requested ?? (unfinishedOwnerTask(context.objective, text, openPlan, redundantAsk) ? text : undefined)
}

export function publicProgress(commentary: string): { milestone: boolean; text: string } | undefined {
  const match = /^\s*((?:✅\s*)?Веха|Ответ в чате):\s*([\s\S]+)$/iu.exec(commentary)
  const text = match?.[2]?.trim()
  if (!text) return
  return { milestone: !/^Ответ в чате$/iu.test(match![1]!),
    text: text.replace(/^([*_~#>\s-]*)(\p{Ll})/u, (_, prefix, letter) => prefix + letter.toLocaleUpperCase('ru')) }
}
