// The bridge's error journal: every warn or error line the bridge logs is also appended as one JSON line to a daily
// file <state dir>/errors-YYYY-MM-DD.jsonl (UTC date), so the owner and the agent can look into problems later.
// Each line holds the time, level, area, message, error name/code/description and the turn, thread and chat message
// IDs. Free text is masked (maskDiagnostic: credential headers, key=value pairs, URL queries, opaque tokens) and
// redacted with the bridge's redactor. Only those fields are kept: no message bodies, payloads or env values.
// Files older than KROT_CODEX_ERROR_LOG_DAYS days (default 14, at least 7) are deleted. Above a total size cap the oldest
// day goes first, never the current one. Errors in the journal itself never reach the bridge.

import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, unlinkSync, type Stats } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { redactSecrets } from '../safety/redact.js'

const descriptionMax = 300
const messageMax = 300
const idMax = 128
const entryMax = 8_192
const dayMs = 24 * 60 * 60 * 1000
/** A warn area repeating this many times in 24 hours counts as a /doctor problem. */
export const repeatedWarnLimit = 5
export const defaultErrorLogDays = 14
export const minimumErrorLogDays = 7
export const defaultErrorLogMaxBytes = 50 * 1024 * 1024
const filePattern = /^errors-(\d{4}-\d{2}-\d{2})\.jsonl$/u

/** The journal's file name pattern inside the state directory, for docs and /doctor. */
export const errorJournalPattern = 'errors-YYYY-MM-DD.jsonl'

// Names whose value is a credential when they appear as a header, a key=value pair or a JSON field.
const secretName = String.raw`[A-Za-z0-9_-]*(?:key|token|secret|password|passwd|pwd|cookie|session|signature|credential|authorization)[A-Za-z0-9_-]*`
// `x-api-key: value`, `password="value"`, `token: 'value'`: a bare value runs to the next separator, a quoted one to
// its closing quote; an auth scheme stays. A bare number or an upper-case error code (`max_tokens: 5000`,
// `session: ENOENT`) is a diagnostic, not a credential.
const authScheme = String.raw`(?:(?:Bearer|Basic|Token|Digest)\s+)?`
const bareValue = String.raw`[^\s;,&"'{}]+`
const headerValueRe = new RegExp(String.raw`(\b(${secretName})\s*[:=]\s*)(?!${authScheme}\[REDACTED\])` +
  String.raw`(${authScheme})("[^"\n]*"|'[^'\n]*'|${bareValue})`, 'giu')
const maskHeaderValue = (match: string, prefix: string, name: string, scheme: string, value: string): string =>
  (/^max_tokens$/iu.test(name) && /^\d+$/u.test(value)) || (/^session$/iu.test(name) && /^E[A-Z_]{2,15}$/u.test(value))
    ? match : prefix + scheme + '[REDACTED]'
// Headers whose whole value is a credential (every cookie, every Digest parameter): masked up to the next
// `Header: ` or the end of the line.
const wholeHeaderRe = /(\b(?:Set-)?Cookie\s*:\s*|\b(?:Proxy-)?Authorization\s*:\s*Digest\s+)(?!\s*\[REDACTED\])[^\n]*?(?=\s+[A-Za-z][A-Za-z0-9-]*:\s|\n|$)/giu
// Mask credential values and message fields that providers may echo as JSON.
const jsonValueRe = new RegExp(String.raw`(["'](?:${secretName}|env|environment|message|text|caption|input|payload|body)["']\s*:\s*)` +
  String.raw`(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)`, 'giu')
// A Bearer value of any length (the shared redactor only catches 8+ characters); other schemes count only in an
// Authorization header, so prose like "Basic plan" or "Token expired" stays.
const schemeRe = /\b(Bearer)\s+(?!\[REDACTED\])[^\s;,"']+/giu
// Everything after `?` or `#` in a URL: query strings carry signed parameters under any name.
const urlQueryRe = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/giu
// A long opaque run (24+ characters mixing letters and digits) with a hyphen-free stretch of 16+ characters is a
// token; UUIDs and dated model names (`claude-sonnet-4-5-20250929`) are short segments and stay readable.
const opaqueRe = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/gu
const maskOpaque = (run: string): string => run.split('-').some(part => part.length >= 16) ? '[REDACTED]' : run

/**
 * Masks what a provider may echo back in an error before it is journaled: header values, key=value pairs and JSON
 * fields with a credential name, auth scheme values, URL query strings and long opaque tokens, then the bridge's
 * redactor. Status words, header names, hosts and paths stay readable for diagnosis.
 */
export function maskDiagnostic(value: string, secrets: readonly string[] = []): string {
  for (const secret of secrets) {
    if (secret.length >= 4) value = value.replaceAll(secret, '[REDACTED]')
  }
  const masked = value
    .replace(urlQueryRe, '$1?[REDACTED]')
    .replace(jsonValueRe, '$1"[REDACTED]"')
    .replace(wholeHeaderRe, '$1[REDACTED]')
    .replace(schemeRe, '$1 [REDACTED]')
    .replace(headerValueRe, maskHeaderValue)
    .replace(opaqueRe, maskOpaque)
  return redactSecrets(masked)
}

export interface ErrorDetail {
  name: string
  code?: number | string
  description: string
}

/**
 * What a caught error says about itself: its name, a numeric or short code (Telegram error_code, HTTP status) and its
 * description with credentials masked (maskDiagnostic), cut to 300 characters. No other field is kept.
 */
export function errorDetail(error: unknown, secrets: readonly string[] = []): ErrorDetail {
  const fields = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {}
  const name = diagnosticText(fields.name, 64, secrets) ?? 'Error'
  const code = errorCode(fields.error_code ?? fields.code ?? fields.status, secrets)
  const raw = typeof fields.description === 'string' ? fields.description
    : error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const description = diagnosticText(raw, descriptionMax, secrets) ?? ''
  return { name, ...(code === undefined ? {} : { code }), description }
}

/** KROT_CODEX_ERROR_LOG_DAYS controls retention. Default 14 days, minimum 7. */
export function errorLogDays(raw: string | undefined): number {
  const value = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  if (!Number.isInteger(value)) return defaultErrorLogDays
  return Math.max(minimumErrorLogDays, value)
}

export type ErrorLevel = 'warn' | 'error'

export interface ErrorEntry {
  ts: string
  level: ErrorLevel
  area: string
  message: string
  error?: ErrorDetail
  status?: string
  turnId?: string
  threadId?: string
  messageId?: number
  delivered?: number
  component?: string
}

export interface ErrorSummary {
  /** Entries of the last 24 hours and the last 7 days. */
  day: number
  week: number
  /** Entries of the last 24 hours that need attention: level error, or a warn area seen at least 5 times. */
  problemCount: number
  /** The newest of those entries, newest first, at most 5. */
  problems: ErrorEntry[]
  /** Where the daily files live: <state dir>/errors-YYYY-MM-DD.jsonl. */
  path: string
}

export interface ErrorJournalOptions {
  dir: string
  days?: number
  maxBytes?: number
  secrets?: readonly string[]
  now?: () => number
}

// Free text of errors and log messages may quote a provider response, so credentials are masked there too.
function diagnosticText(value: unknown, max: number, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return maskDiagnostic(value, secrets).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\s]+/gu, ' ')
    .trim().slice(0, max) || undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function errorCode(value: unknown, secrets: readonly string[]): number | string | undefined {
  return typeof value === 'string' && /^[a-z0-9._-]{1,64}$/iu.test(value) ? diagnosticText(value, 64, secrets) : count(value)
}

function detail(value: unknown, secrets: readonly string[]): ErrorDetail | undefined {
  if (value instanceof Error) return errorDetail(value, secrets)
  // Older log lines carry the error as its message string.
  if (typeof value === 'string') return { name: 'Error', description: diagnosticText(value, descriptionMax, secrets) ?? '' }
  if (typeof value !== 'object' || value === null) return undefined
  const fields = value as Record<string, unknown>
  const description = diagnosticText(fields.description, descriptionMax, secrets)
  const name = diagnosticText(fields.name, 64, secrets) ?? 'Error'
  const code = errorCode(fields.code, secrets)
  return { name, ...(code === undefined ? {} : { code }), description: description ?? '' }
}

function journalEntry(
  at: number, level: ErrorLevel, area: unknown, message: unknown,
  context: Record<string, unknown>, secrets: readonly string[],
): ErrorEntry {
  const entry: ErrorEntry = {
    ts: new Date(at).toISOString(), level,
    area: diagnosticText(context.area, 64, secrets) ?? diagnosticText(area, 64, secrets) ?? 'bridge',
    message: diagnosticText(message, messageMax, secrets) ?? '',
  }
  const error = detail(context.error, secrets)
  if (error) {
    const code = error.code ?? count(context.code)
    if (code !== undefined) error.code = code
    entry.error = error
  }
  const status = diagnosticText(context.status, 32, secrets)
  if (status) entry.status = status
  const turnId = diagnosticText(context.turnId, idMax, secrets)
  if (turnId) entry.turnId = turnId
  const threadId = diagnosticText(context.threadId, idMax, secrets)
  if (threadId) entry.threadId = threadId
  const messageId = count(context.messageId)
  if (messageId !== undefined) entry.messageId = messageId
  const delivered = count(context.delivered)
  if (delivered !== undefined) entry.delivered = delivered
  const component = diagnosticText(context.component, 64, secrets)
  if (component) entry.component = component
  return entry
}

function isPrivateFile(stat: Stats): boolean {
  const uid = process.getuid?.()
  return stat.isFile() && stat.nlink === 1 && (uid === undefined || (stat.uid === uid && (stat.mode & 0o077) === 0))
}

type RecentEntry = { entry: ErrorEntry; time: number; order: number }

function compareRecent(a: RecentEntry, b: RecentEntry): number {
  return b.time - a.time || a.order - b.order
}

function keepLatest(entries: RecentEntry[], candidate: RecentEntry): void {
  const last = entries[4]
  if (last && compareRecent(last, candidate) <= 0) return
  entries.push(candidate)
  entries.sort(compareRecent)
  if (entries.length > 5) entries.pop()
}

function yieldToLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(() => resolve()))
}

/** Daily JSON-lines error files in the bridge's state directory, kept for a number of days under a size cap. */
export class ErrorJournal {
  private readonly days: number
  private readonly maxBytes: number
  private readonly secrets: readonly string[]
  private readonly now: () => number
  private total = 0
  private prunedFor = ''

  constructor(private readonly options: ErrorJournalOptions) {
    this.days = Math.max(minimumErrorLogDays, options.days ?? defaultErrorLogDays)
    this.maxBytes = count(options.maxBytes) ?? defaultErrorLogMaxBytes
    this.secrets = options.secrets ?? []
    this.now = options.now ?? Date.now
    this.prune()
  }

  /** Appends one entry; only the known fields of `context` are kept. Never throws. */
  record(level: ErrorLevel, area: string, message: string, context: Record<string, unknown> = {}): void {
    try {
      const at = this.now()
      if (this.prunedFor !== dateOf(at)) this.prune()
      const entry = journalEntry(at, level, area, message, context, this.secrets)
      const line = JSON.stringify(entry) + '\n'
      const bytes = Buffer.byteLength(line)
      if (this.total + bytes > this.maxBytes) this.prune(bytes)
      // A log storm on one day stops at the cap instead of filling the disk.
      if (this.total + bytes > this.maxBytes) return
      const descriptor = openSync(join(this.options.dir, `errors-${dateOf(at)}.jsonl`),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
      try {
        const stat = fstatSync(descriptor)
        if (!isPrivateFile(stat) || stat.size + bytes > this.maxBytes) return
        appendFileSync(descriptor, line)
        this.total += bytes
      } finally { closeSync(descriptor) }
    } catch { /* The journal is best effort: logging never breaks the bridge. */ }
  }

  /** Counts for the last 24 hours and 7 days and the newest 5 entries that need attention. Never throws. */
  async recent(): Promise<ErrorSummary> {
    const at = this.now()
    const oldest = at - 7 * dayMs
    const oldestFile = startOfDay(oldest)
    const today = startOfDay(at)
    const problems: RecentEntry[] = []
    const warnings = new Map<string, { count: number; samples: RecentEntry[] }>()
    let day = 0
    let week = 0
    let problemCount = 0
    let parsed = 0
    let remaining = this.maxBytes
    const names = await readdir(this.options.dir).catch(() => [] as string[])
    for (const name of names.sort().reverse()) {
      const fileTime = journalFileTime(name)
      if (fileTime === undefined || fileTime < oldestFile || fileTime > today) continue
      const data = await this.read(name, remaining)
      if (!data) continue
      remaining -= data.length
      // Among entries of the same millisecond the later line is the newer one.
      for (let end = data.length; end > 0;) {
        const start = data.lastIndexOf(10, end - 1) + 1
        const line = end - start <= entryMax ? data.toString('utf8', start, end) : ''
        end = start - 1
        if (++parsed % 128 === 0) await yieldToLoop()
        if (!line) continue
        try {
          const value: unknown = JSON.parse(line)
          if (!value || typeof value !== 'object') continue
          const row = value as Record<string, unknown>
          if (typeof row.ts !== 'string' || (row.level !== 'warn' && row.level !== 'error')) continue
          const time = Date.parse(row.ts)
          if (!Number.isFinite(time) || time <= oldest || time > at || startOfDay(time) !== fileTime) continue
          week++
          if (time <= at - dayMs) continue
          day++
          const entry = journalEntry(time, row.level, row.area, row.message, row, this.secrets)
          const recent = { entry, time, order: parsed }
          if (entry.level === 'error') {
            problemCount++
            keepLatest(problems, recent)
          } else {
            let group = warnings.get(entry.area)
            if (!group) {
              group = { count: 0, samples: [] }
              warnings.set(entry.area, group)
            }
            group.count++
            keepLatest(group.samples, recent)
          }
        } catch { /* A cut line (disk full, crash) is skipped. */ }
      }
    }
    for (const { count, samples } of warnings.values()) {
      if (++parsed % 128 === 0) await yieldToLoop()
      if (count < repeatedWarnLimit) continue
      problemCount += count
      for (const sample of samples) keepLatest(problems, sample)
    }
    return {
      day, week, problemCount,
      problems: problems.map(({ entry }) => entry),
      path: join(this.options.dir, errorJournalPattern),
    }
  }

  private async read(name: string, remaining: number): Promise<Buffer | undefined> {
    try {
      const file = await open(join(this.options.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!isPrivateFile(stat) || stat.size === 0 || stat.size > remaining) return undefined
        const data = Buffer.alloc(stat.size)
        let length = 0
        while (length < data.length) {
          const { bytesRead } = await file.read(data, length, data.length - length, length)
          if (bytesRead === 0) break
          length += bytesRead
        }
        return data.subarray(0, length)
      } finally { await file.close() }
    } catch { return undefined }
  }

  private files(): Array<{ name: string; time: number; size: number }> {
    let names: string[]
    try { names = readdirSync(this.options.dir) } catch { return [] }
    return names.flatMap(name => {
      const time = journalFileTime(name)
      if (time === undefined) return []
      try {
        const stat = lstatSync(join(this.options.dir, name))
        return isPrivateFile(stat) ? [{ name, time, size: stat.size }] : []
      } catch { return [] }
    }).sort((a, b) => a.time - b.time)
  }

  // Deletes days past the retention, then the oldest days while the total (plus `incoming`) is above the cap.
  private prune(incoming = 0): void {
    const at = this.now()
    const today = startOfDay(at)
    const oldest = today - this.days * dayMs
    const kept: Array<{ name: string; time: number; size: number }> = []
    for (const file of this.files()) {
      if (file.time < oldest && this.remove(file.name)) continue
      kept.push(file)
    }
    let total = kept.reduce((sum, file) => sum + file.size, 0)
    for (const file of kept) {
      if (total + incoming <= this.maxBytes || file.time >= today) break
      if (this.remove(file.name)) total -= file.size
    }
    this.total = total
    this.prunedFor = dateOf(at)
  }

  private remove(name: string): boolean {
    try {
      unlinkSync(join(this.options.dir, name))
      return true
    } catch { return false }
  }
}

function journalFileTime(name: string): number | undefined {
  const date = filePattern.exec(name)?.[1]
  if (!date) return undefined
  const time = Date.parse(date + 'T00:00:00Z')
  return Number.isFinite(time) && dateOf(time) === date ? time : undefined
}

function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function startOfDay(ms: number): number {
  return Date.parse(dateOf(ms) + 'T00:00:00Z')
}
