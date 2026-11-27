import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

import { type ErrorEntry, type ErrorSummary, maskDiagnostic, repeatedWarnLimit } from './error-log.js'

export interface DoctorCheck { status: 'ok' | 'warning' | 'error'; message: string }
export interface DoctorProblem { text: string }
export interface DoctorReport {
  problems: DoctorProblem[]
  commit?: string
  upstream?: string
  codexVersion?: string
  errorJournal?: string
}

type Environment = Record<string, string | undefined>

const toolsEnv = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TMPDIR|TEMP|TMP|CODEX_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/u
const profileEnv = new Set([
  'XDG_STATE_HOME', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_STATE_DIR', 'TELEGRAM_CONFIG_FILE', 'TELEGRAM_EXPECTED_BOT_ID',
  'TELEGRAM_ALLOWED_USER_IDS', 'TELEGRAM_ALLOWED_CHAT_IDS', 'TELEGRAM_WORKSPACE_ROOT', 'TELEGRAM_ACCESS_MODE',
  'KROT_CODEX_PROXY', 'KROT_CODEX_APPROVALS', 'KROT_CODEX_APPROVAL_MODE',
])
const doctorLabels: Readonly<Record<string, DoctorCheck['status']>> = { OK: 'ok', ВНИМАНИЕ: 'warning', ОШИБКА: 'error' }
const maxOutputBytes = 256 * 1024
const listedFiles = 10
export const chatReportChars = 3500

function childEnv(env: Environment, includeProfile = false): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (toolsEnv.test(name) || includeProfile && profileEnv.has(name))) result[name] = value
  }
  return result
}

type CommandResult = { code: number; stdout: string }

async function run(command: [string, ...string[]], cwd: string, env: Record<string, string>,
  timeout: number, signal?: AbortSignal): Promise<CommandResult | undefined> {
  if (signal?.aborted) return
  try {
    const child = Bun.spawn(command, {
      cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout, killSignal: 'SIGKILL',
      ...(signal ? { signal } : {}),
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    const chunks: string[] = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxOutputBytes) {
          child.kill('SIGKILL')
          await child.exited
          return
        }
        chunks.push(decoder.decode(value, { stream: true }))
      }
      chunks.push(decoder.decode())
      return { code: await child.exited, stdout: chunks.join('') }
    } finally { reader.releaseLock() }
  } catch {
    return
  }
}

function cut(text: string, max: number): string {
  if (max <= 0) return ''
  return text.length > max ? text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…' : text
}

function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim()
}

export interface DoctorProcessOptions {
  entry: string
  cwd?: string
  env?: Environment
  secrets?: readonly string[]
  signal?: AbortSignal
}

/** Runs the same bridge entry in diagnostic mode, without loading dotenv or starting polling. */
export async function runDoctorReport(options: DoctorProcessOptions): Promise<DoctorCheck[]> {
  const env = childEnv(options.env ?? process.env, true)
  const result = await run([process.execPath, '--no-env-file', resolve(options.entry), '--doctor-report'],
    options.cwd ?? process.cwd(), env, 45_000, options.signal)
  const secrets = [...(options.secrets ?? []), env.TELEGRAM_BOT_TOKEN ?? '']
  const checks: DoctorCheck[] = []
  if (result?.code === 0 || result?.code === 1) {
    for (const line of maskDiagnostic(result.stdout, secrets).split('\n')) {
      const match = /^\[([^\]]+)\] (.+)$/u.exec(line.trim())
      const status = match && Object.hasOwn(doctorLabels, match[1]!) ? doctorLabels[match[1]!] : undefined
      if (status) checks.push({ status, message: cut(oneLine(match![2]!), 500) })
      if (checks.length === 30) break
    }
  }
  return checks.length ? checks : [{ status: 'error', message: 'Не удалось запустить самопроверку моста.' }]
}

const LockSchema = z.object({
  workspaces: z.record(z.object({
    dependencies: z.record(z.string()).optional(),
    devDependencies: z.record(z.string()).optional(),
  })).optional(),
  packages: z.record(z.array(z.unknown())),
})
const packageName = /^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/iu

async function readText(path: string, limit: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Invalid diagnostic file')
    const data = Buffer.alloc(info.size + 1)
    let size = 0
    while (size < data.length) {
      const { bytesRead } = await file.read(data, size, data.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > info.size) throw new Error('Diagnostic file changed during read')
    return data.toString('utf8', 0, size)
  } finally { await file.close() }
}

/** Checks installed dependency versions without touching the checkout or installing packages. */
export async function dependencyDrift(plugin: string): Promise<DoctorProblem | undefined> {
  let lock: z.infer<typeof LockSchema>
  try {
    const source = await readText(join(plugin, 'bun.lock'), 1024 * 1024)
    lock = LockSchema.parse(JSON.parse(source.replace(/,(\s*[}\]])/gu, '$1')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    return { text: 'Не удалось прочитать plugin/bun.lock.' }
  }

  const modules = join(plugin, 'node_modules')
  if (!(await stat(modules).catch(() => undefined))?.isDirectory()) {
    return { text: 'Зависимости моста не установлены (нет plugin/node_modules).' }
  }
  const root = lock.workspaces?.['']
  const direct = new Set(Object.keys({ ...root?.dependencies, ...root?.devDependencies }))
  const drift: string[] = []
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (!packageName.test(name) || typeof entry[0] !== 'string') continue
    const version = entry[0].slice(entry[0].lastIndexOf('@') + 1)
    if (!/^\d/u.test(version)) continue
    let installed: unknown
    try {
      const manifest = await readText(join(modules, name, 'package.json'), 128 * 1024)
      installed = (JSON.parse(manifest) as { version?: unknown }).version
    } catch { installed = undefined }
    if (installed === undefined ? direct.has(name) : installed !== version) drift.push(name)
  }
  if (!drift.length) return
  const extra = drift.length > listedFiles ? ' и ещё ' + (drift.length - listedFiles) : ''
  return { text: 'Установленные зависимости не совпадают с plugin/bun.lock: ' + drift.slice(0, listedFiles).join(', ') + extra + '.' }
}

const secretSegment = /^(?:\.?secrets?|\.env.*|.*\.env|\.ssh|\.aws|\.gnupg|auth\.json|.*\.(?:key|pem|p12|pfx)|credentials.*|id_(?:rsa|ed25519|ecdsa|dsa).*)$/iu
const refName = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u

function localEdits(porcelain: string, secrets: readonly string[]): DoctorProblem | undefined {
  const entries = porcelain.split('\0')
  const names: string[] = []
  let hidden = 0
  let extra = 0
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.length < 4) continue
    const path = entry.slice(3)
    const previous = /[RC]/u.test(entry.slice(0, 2)) ? entries[++index] : undefined
    if ([path, previous].some(value => value?.split('/').some(segment => secretSegment.test(segment)))) hidden++
    else if (names.length === listedFiles) extra++
    else names.push(JSON.stringify(maskDiagnostic(path, secrets)))
  }
  if (!names.length && !hidden) return
  if (extra) names.push('ещё ' + extra)
  if (hidden) names.push('скрыто имён файлов с секретами: ' + hidden)
  return { text: 'В копии моста есть локальные правки: ' + names.join(', ') + '.' }
}

async function compareLocalCheckout(repo: string, env: Environment, report: DoctorReport, secrets: readonly string[],
  signal?: AbortSignal): Promise<void> {
  const gitEnv = {
    ...childEnv(env), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C',
  }
  const git = (...args: string[]) =>
    run(['git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args], repo, gitEnv, 8_000, signal)
  const head = await git('rev-parse', '--short', 'HEAD')
  if (head?.code !== 0 || !/^[a-f\d]{4,64}$/u.test(head.stdout.trim())) {
    report.problems.push({ text: 'Не удалось прочитать локальную Git-копию моста.' })
    return
  }
  report.commit = head.stdout.trim()
  const [filters, remotes] = await Promise.all([
    git('config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'), git('remote'),
  ])
  if (filters?.code === 1) {
    // Git returns 1 when no keys match. In any other case status may invoke a configured filter.
    const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all')
    if (status?.code === 0) {
      const edits = localEdits(status.stdout, secrets)
      if (edits) report.problems.push(edits)
    } else report.problems.push({ text: 'Не удалось проверить локальные правки моста.' })
  } else if (filters?.code === 0) {
    report.problems.push({ text: 'Локальные правки не проверены: настроен внешний Git-фильтр.' })
  } else {
    report.problems.push({ text: 'Не удалось проверить настройки Git-фильтров для оценки локальных правок.' })
  }
  const remote = env.KROT_UPDATE_REMOTE?.trim() || (remotes?.stdout.split('\n').includes('public') ? 'public' : 'origin')
  const branch = env.KROT_UPDATE_BRANCH?.trim() || 'main'
  if (!refName.test(remote) || !refName.test(branch)) {
    report.problems.push({ text: 'Некорректное имя удалённого репозитория или ветки в настройках обновления.' })
    return
  }
  const source = remote + '/' + branch
  const counts = await git('rev-list', '--left-right', '--count', 'HEAD...refs/remotes/' + source, '--')
  const match = counts?.code === 0 ? /^(\d+)\s+(\d+)$/u.exec(counts.stdout.trim()) : null
  if (!match) {
    report.problems.push({ text: 'Локальная ссылка для сравнения не найдена: ' + source + '.' })
    return
  }
  report.upstream = source
  const ahead = Number(match[1])
  const behind = Number(match[2])
  if (behind > 0) report.problems.push({ text: 'Локальная копия отстаёт от сохранённой ссылки на ' + behind + ' комм.' })
  if (ahead > 0) report.problems.push({ text: 'В локальной копии есть коммиты вне сохранённой ссылки: ' + ahead + '.' })
}

function journalEntry(entry: ErrorEntry, secrets: readonly string[]): string {
  const quote = (text: string, max: number) => JSON.stringify(cut(oneLine(maskDiagnostic(text, secrets)), max))
  const timestamp = new Date(entry.ts)
  const at = Number.isFinite(timestamp.getTime()) ? timestamp.toISOString().slice(0, 16).replace('T', ' ') + ' UTC ' : ''
  const code = entry.error?.code
  const cause = [code === undefined ? '' : 'код ' + quote(String(code), 60),
    entry.error?.description ? quote(entry.error.description, 200) : ''].filter(Boolean).join(': ')
  return at + entry.level + ' ' + quote(entry.area, 60) + ': ' + quote(entry.message, 200) + (cause ? ' (' + cause + ')' : '')
}

function journalCounts(summary: ErrorSummary): string {
  return 'Журнал ошибок: за 24 ч — ' + summary.day + ', за 7 дней — ' + summary.week + '.'
}

async function localCodexVersion(env: Environment, signal?: AbortSignal): Promise<string | undefined> {
  const result = await run(['codex', '--version'], process.cwd(), childEnv(env), 8_000, signal)
  return result?.code === 0 ? /\d+\.\d+\.\d+[\w.+-]*/u.exec(result.stdout)?.[0] : undefined
}

function olderThan(version: string, minimum: string): boolean {
  const parts = (value: string) => value.split(/[.+-]/u, 3).map(Number)
  const [actual, required] = [parts(version), parts(minimum)]
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== required[index]) return (actual[index] ?? 0) < (required[index] ?? 0)
  }
  return false
}

export interface DoctorOptions {
  repo?: string | undefined
  env: Environment
  doctor: () => Promise<DoctorCheck[]>
  codexVersion?: () => Promise<string | undefined>
  minimumCodexVersion?: string
  errors?: () => ErrorSummary | Promise<ErrorSummary>
  secrets?: readonly string[]
  signal?: AbortSignal
}

export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const report: DoctorReport = { problems: [] }
  const secrets = options.secrets ?? []
  const [checks, version] = await Promise.all([
    options.doctor(),
    (options.codexVersion ?? (() => localCodexVersion(options.env, options.signal)))().catch(() => undefined),
  ])
  options.signal?.throwIfAborted()
  for (const check of checks) {
    if (check.status !== 'ok') report.problems.push({ text: check.message })
  }
  if (options.repo) {
    await compareLocalCheckout(options.repo, options.env, report, secrets, options.signal)
    options.signal?.throwIfAborted()
    const drift = await dependencyDrift(join(options.repo, 'plugin'))
    if (drift) report.problems.push(drift)
  }
  if (version) report.codexVersion = version
  if (version && options.minimumCodexVersion && olderThan(version, options.minimumCodexVersion)) {
    report.problems.push({ text: 'Codex CLI ' + version + ' старее минимальной версии ' + options.minimumCodexVersion + '.' })
  }
  options.signal?.throwIfAborted()
  const errors = await options.errors?.()
  if (errors) {
    report.errorJournal = journalCounts(errors)
    if (errors.problemCount > 0) {
      report.problems.push({
        text: 'Ошибки или повторяющиеся предупреждения за 24 ч: ' + errors.problemCount +
          ' (предупреждения одной области — от ' + repeatedWarnLimit + ').\n' +
          errors.problems.slice(0, 5).map(entry => '  • ' + journalEntry(entry, secrets)).join('\n'),
      })
    }
  }
  return report
}

export function formatDoctorReport(report: DoctorReport, maxChars = chatReportChars,
  secrets: readonly string[] = []): string {
  const lines = [
    report.problems.length ? '🩺 Доктор нашёл проблемы: ' + report.problems.length + '.' : '🩺 Доктор: всё в порядке.',
    report.commit ? 'Версия моста: ' + report.commit + (report.upstream ? ' (локальная ссылка ' + report.upstream + ').' : '.') : '',
    report.codexVersion ? 'Codex CLI: ' + report.codexVersion + '.' : '',
    report.errorJournal ?? '',
    ...report.problems.map((problem, index) => (index + 1) + '. ' + problem.text),
  ].filter(Boolean)
  return cut(maskDiagnostic(lines.join('\n'), secrets), maxChars)
}

interface DoctorCommandHooks {
  collect: () => Promise<DoctorReport>
  send: (text: string) => Promise<unknown>
  secrets: readonly string[]
}

export class DoctorCommand {
  private running = false

  constructor(private readonly hooks: DoctorCommandHooks) {}

  async handle(args: string): Promise<void> {
    if (args.trim()) {
      await this.hooks.send('Используйте /doctor без аргументов.')
      return
    }
    if (this.running) {
      await this.hooks.send('Самопроверка уже идёт. Дождитесь отчёта.')
      return
    }
    this.running = true
    try {
      await this.hooks.send('Запускаю самопроверку моста.').catch(() => undefined)
      let report: DoctorReport
      try { report = await this.hooks.collect() } catch {
        await this.hooks.send('Не удалось выполнить самопроверку моста.')
        return
      }
      await this.hooks.send(formatDoctorReport(report, chatReportChars, this.hooks.secrets))
    } finally { this.running = false }
  }
}
