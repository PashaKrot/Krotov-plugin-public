const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type ReasoningEffort = typeof levels[number]

export interface CodexModel {
  name: string
  default: boolean
  reasoningEfforts?: readonly ReasoningEffort[]
  defaultReasoningEffort?: ReasoningEffort
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return levels.some(level => level === value)
}

export function effectiveEffort(model: CodexModel | undefined, selected?: ReasoningEffort): ReasoningEffort | undefined {
  const supported = model?.reasoningEfforts
  if (!supported?.length) return undefined
  if (selected && supported.includes(selected)) return selected
  if (supported.includes('high')) return 'high'
  const fallback = model?.defaultReasoningEffort
  return fallback && supported.includes(fallback) ? fallback : undefined
}
