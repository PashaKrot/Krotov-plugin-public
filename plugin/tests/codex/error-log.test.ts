import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { errorDetail, ErrorJournal, errorLogDays, maskDiagnostic } from '../../src/codex/error-log.js'
import { createLogger } from '../../src/log.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-errors-'))
  dirs.push(dir)
  return dir
}

const day = 24 * 60 * 60 * 1000
const noon = Date.parse('2026-11-26T12:00:00Z')
const today = 'errors-2026-11-26.jsonl'

function seed(path: string, value: string): void {
  writeFileSync(path, value + '\n', { mode: 0o600 })
}

test('the logger journals warn and error below the stderr threshold, with named fields only', () => {
  const dir = stateDir()
  const journal = new ErrorJournal({ dir, now: () => noon })
  const previous = process.env.LOG_LEVEL
  let stderr = ''
  try {
    process.env.LOG_LEVEL = 'error'
    const stream = new Writable({ write(chunk, _encoding, done) { stderr += String(chunk); done() } })
    const log = createLogger('bridge', { stream, onErrorLog: (level, name, message, context) =>
      journal.record(level, name, message, context) })
    const problem = Object.assign(new Error('Telegram connection closed'), { code: 'ECONNRESET' })
    log.warn('Could not send reply', { area: 'delivery', error: errorDetail(problem), threadId: 'thread-1', messageId: 7,
      env: { EXAMPLE_SECRET: 'private value' }, text: 'private message text' })
    log.info('Reply delivered')
    log.error('Reply still pending')
    const raw = readFileSync(join(dir, today), 'utf8')
    expect(raw.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { ts: '2026-11-26T12:00:00.000Z', level: 'warn', area: 'delivery', message: 'Could not send reply',
        error: { name: 'Error', code: 'ECONNRESET', description: 'Telegram connection closed' }, threadId: 'thread-1', messageId: 7 },
      { ts: '2026-11-26T12:00:00.000Z', level: 'error', area: 'bridge', message: 'Reply still pending' },
    ])
    expect(stderr).not.toContain('Could not send reply')
    expect(stderr).toContain('Reply still pending')
    expect(statSync(join(dir, today)).mode & 0o777).toBe(0o600)
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = previous
  }
})

test('journal retention drops expired files and oldest days first when the byte cap fills', () => {
  expect(errorLogDays(undefined)).toBe(14)
  expect(errorLogDays('3')).toBe(7)
  expect(errorLogDays('30')).toBe(30)
  expect(errorLogDays('invalid')).toBe(14)
  const dir = stateDir()
  seed(join(dir, 'errors-2026-11-17.jsonl'), 'expired')
  seed(join(dir, 'errors-2026-11-24.jsonl'), 'a'.repeat(600))
  seed(join(dir, 'errors-2026-11-25.jsonl'), 'b'.repeat(600))
  seed(join(dir, 'other.jsonl'), 'unrelated')
  const journal = new ErrorJournal({ dir, days: 7, maxBytes: 1000, now: () => noon })
  journal.record('warn', 'bridge', 'Reply delayed')
  expect(readdirSync(dir).sort()).toEqual(['errors-2026-11-25.jsonl', today, 'other.jsonl'])
  for (let i = 0; i < 40; i++) journal.record('error', 'bridge', 'Delivery failed ' + i)
  expect(readdirSync(dir).sort()).toEqual([today, 'other.jsonl'])
  expect(statSync(join(dir, today)).size).toBeLessThanOrEqual(1000)
})

test('diagnostic masking retains useful codes but never exempts numeric or uppercase credentials', () => {
  const masked = maskDiagnostic('password=1234 x-api-key: ABCDEF Authorization: Bearer Qz7; ' +
    'https://api.example.com/send?value=hiddenquery Cookie: a=1; b=cookiesecret\n' +
    '{"api_key":"jsonkeyvalue","text":"private body"} max_tokens: 5000; session: ENOENT', ['hidden-exact'])
  for (const secret of ['1234', 'ABCDEF', 'Qz7', 'hiddenquery', 'cookiesecret', 'jsonkeyvalue', 'private body']) {
    expect(masked).not.toContain(secret)
  }
  expect(masked).toContain('https://api.example.com/send?[REDACTED]')
  expect(masked).toContain('Bearer [REDACTED]')
  expect(masked).toContain('max_tokens: 5000; session: ENOENT')
})

test('recent errors are counted and reconstructed from the sanitized fields even after restart', async () => {
  const dir = stateDir()
  const secret = 'fixture-nonspecific-secret'
  let now = noon - 3 * day
  const journal = new ErrorJournal({ dir, secrets: [secret], now: () => now })
  journal.record('error', 'bridge', 'Old failure')
  now = noon - 60_000
  for (let i = 1; i <= 6; i++) journal.record('warn', 'delivery', 'Part ' + i)
  journal.record('warn', 'telegram', 'One-off warning')
  const file = join(dir, today)
  const existing = readFileSync(file, 'utf8')
  seed(file, existing + JSON.stringify({
    ts: new Date(now).toISOString(), level: 'error', area: 'bridge\u202e', message: 'provider error ' + secret,
    error: { name: 'ProviderError', code: 401, description: 'Authorization: Basic abc123' },
    payload: 'untrusted message payload', env: { VAR: 'untrusted environment payload' },
  }))
  const summary = await new ErrorJournal({ dir, secrets: [secret], now: () => noon }).recent()
  expect(summary).toMatchObject({ day: 8, week: 9, problemCount: 7, path: join(dir, 'errors-YYYY-MM-DD.jsonl') })
  expect(summary.problems.map(entry => entry.message)).toEqual([
    'provider error [REDACTED]', 'Part 6', 'Part 5', 'Part 4', 'Part 3',
  ])
  expect(summary.problems[0]).toMatchObject({
    area: 'bridge', error: { name: 'ProviderError', code: 401, description: 'Authorization: Basic [REDACTED]' },
  })
  expect(JSON.stringify(summary)).not.toContain('untrusted')
})

test('journal writes and summaries ignore symlinked and oversized daily files', async () => {
  const dir = stateDir()
  const elsewhere = join(stateDir(), 'untouched.jsonl')
  const original = JSON.stringify({ ts: new Date(noon).toISOString(), level: 'error', area: 'bridge', message: 'external' })
  seed(elsewhere, original)
  symlinkSync(elsewhere, join(dir, today))
  const linked = new ErrorJournal({ dir, now: () => noon })
  linked.record('error', 'bridge', 'Rejected write')
  expect((await linked.recent()).day).toBe(0)
  expect(readFileSync(elsewhere, 'utf8')).toBe(original + '\n')

  const oversized = stateDir()
  seed(join(oversized, today), original + '\n' + 'x'.repeat(1000))
  const capped = new ErrorJournal({ dir: oversized, maxBytes: 200, now: () => noon })
  capped.record('error', 'bridge', 'Rejected write')
  expect((await capped.recent()).day).toBe(0)
  expect(readFileSync(join(oversized, today), 'utf8')).not.toContain('Rejected write')
})

test('a journal scan yields to the event loop and returns only the latest five problems', async () => {
  const dir = stateDir()
  const rows = Array.from({ length: 1_024 }, (_, i) => JSON.stringify({
    ts: new Date(noon).toISOString(), level: 'error', area: 'bridge', message: 'Failure ' + i,
  }))
  seed(join(dir, today), rows.join('\n'))
  const result = new ErrorJournal({ dir, now: () => noon }).recent()
  const first = await Promise.race([
    Promise.resolve(result).then(() => 'journal'),
    new Promise(resolve => setImmediate(() => resolve('polling'))),
  ])
  expect(first).toBe('polling')
  const report = await result
  expect(report.problemCount).toBe(1_024)
  expect(report.problems.map(row => row.message)).toEqual([
    'Failure 1023', 'Failure 1022', 'Failure 1021', 'Failure 1020', 'Failure 1019',
  ])
})
