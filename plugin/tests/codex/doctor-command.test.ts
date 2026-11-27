import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chatReportChars, collectDoctorReport, dependencyDrift, DoctorCommand, formatDoctorReport, runDoctorReport,
} from '../../src/codex/doctor-command.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'krot-doctor-'))
  roots.push(root)
  return root
}

test('bundled installations report self-checks without requiring a source checkout', async () => {
  const report = await collectDoctorReport({
    env: {},
    doctor: async () => [{ status: 'ok', message: 'Telegram доступен.' }],
    codexVersion: async () => '0.130.0',
    errors: async () => ({ day: 1, week: 2, problemCount: 0, problems: [], path: '/private/journal' }),
  })
  expect(report.problems).toEqual([])
  const text = formatDoctorReport(report)
  expect(text).toContain('0.130.0')
  expect(text).toContain('Журнал ошибок')
  expect(text).not.toContain('/private/journal')
  expect(text).not.toContain('GitHub')
})

test('doctor sanitizes an asynchronous journal entry before limiting its visible length', async () => {
  const secret = 'private phrase from the test fixture'
  const report = await collectDoctorReport({
    env: {}, doctor: async () => [], codexVersion: async () => undefined, secrets: [secret],
    errors: async () => ({
      day: 1, week: 1, problemCount: 1, path: '/private/journal',
      problems: [{
        ts: '2026-03-17T12:00:00Z', level: 'error', area: 'fixture',
        message: 'A '.repeat(88) + secret + ' trailing details',
      }],
    }),
  })
  expect(report.problems[0]?.text).toContain('[REDACTED]')
  expect(report.problems[0]?.text).not.toContain('private phrase')
  expect(formatDoctorReport(report)).not.toContain('/private/journal')
})

test('a bundled child receives the doctor flag and only diagnostic environment variables', async () => {
  const cwd = temporaryDirectory()
  const entry = join(cwd, 'bridge.js')
  writeFileSync(join(cwd, '.env'), 'BUNDLE_SECRET=hidden-dotenv-value\n')
  writeFileSync(entry, [
    'if (process.argv[2] !== "--doctor-report") throw new Error("Missing doctor flag")',
    'console.log("[OK] State: " + process.env.TELEGRAM_STATE_DIR)',
    'console.log("[ОШИБКА] Bot: " + process.env.TELEGRAM_BOT_TOKEN)',
    'console.log("[ОШИБКА] Hook: " + process.env.KROT_CODEX_POLICY_TOKEN)',
    'console.log("[ОШИБКА] Dotenv: " + process.env.BUNDLE_SECRET)',
    'process.exitCode = 1',
  ].join('\n'))
  expect(await runDoctorReport({ entry, cwd, env: {
    TELEGRAM_STATE_DIR: '/srv/bot-state', TELEGRAM_BOT_TOKEN: '111111:token-canary-value',
    KROT_CODEX_POLICY_TOKEN: 'hidden-hook-value',
  } })).toEqual([
    { status: 'ok', message: 'State: /srv/bot-state' },
    { status: 'error', message: 'Bot: [REDACTED]' },
    { status: 'error', message: 'Hook: undefined' },
    { status: 'error', message: 'Dotenv: undefined' },
  ])
})

test('bridge shutdown stops the self-check child', async () => {
  const cwd = temporaryDirectory()
  const entry = join(cwd, 'bridge.js')
  writeFileSync(entry, 'await Bun.sleep(20_000)\nconsole.log("[OK] unexpectedly completed")\n')
  const abort = new AbortController()
  const checking = runDoctorReport({ entry, cwd, env: {}, signal: abort.signal })
  await Bun.sleep(25)
  abort.abort()
  expect(await checking).toEqual([{ status: 'error', message: 'Не удалось запустить самопроверку моста.' }])
})

test('the chat report redacts before truncating and declines repair requests', async () => {
  const secret = 'fixture-only-sensitive-value'
  const sent: string[] = []
  let runs = 0
  const command = new DoctorCommand({
    collect: async () => {
      runs++
      return { problems: [{ text: (secret + ' ').repeat(300) }], commit: secret }
    },
    send: async (text: string) => { sent.push(text) },
    secrets: [secret],
  })
  await command.handle('fix')
  expect(runs).toBe(0)
  await command.handle('')
  expect(runs).toBe(1)
  expect(sent.every(text => text.length <= chatReportChars)).toBe(true)
  expect(sent.at(-1)).toContain('[REDACTED]')
  expect(sent.join('\n')).not.toContain(secret)
})

test('dependency drift reads the installed version against the Bun lockfile', async () => {
  const root = temporaryDirectory()
  const installed = join(root, 'node_modules', 'zod')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(root, 'bun.lock'), `{
    "workspaces": {"": {"dependencies": {"zod": "^3.0.0"}}},
    "packages": {"zod": ["zod@3.25.0"],},
  }`)
  writeFileSync(join(installed, 'package.json'), '{"version":"3.25.0"}')
  expect(await dependencyDrift(root)).toBeUndefined()
  writeFileSync(join(installed, 'package.json'), '{"version":"3.20.0"}')
  expect((await dependencyDrift(root))?.text).toContain('zod')
})

test('doctor compares local Git refs and skips status when external filters are configured', async () => {
  const repo = temporaryDirectory()
  const git = async (...args: string[]) => {
    const child = Bun.spawn(['git', '-c', 'user.name=Doctor Test', '-c', 'user.email=doctor@example.invalid', ...args], {
      cwd: repo, stdout: 'ignore', stderr: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
    expect(await child.exited).toBe(0)
  }
  await git('init', '--initial-branch=main')
  writeFileSync(join(repo, 'README.md'), 'Bridge fixture\n')
  await git('add', 'README.md')
  await git('commit', '-m', 'Initial')
  await git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  writeFileSync(join(repo, 'untracked.txt'), 'Fixture contents\n')
  const collect = () => collectDoctorReport({
    repo, env: { PATH: process.env.PATH },
    doctor: async () => [], codexVersion: async () => undefined,
  })

  const normal = await collect()
  expect(normal.upstream).toBe('origin/main')
  expect(formatDoctorReport(normal)).toContain('"untracked.txt"')

  await git('config', 'filter.fixture.clean', '/usr/bin/false')
  const guarded = await collect()
  expect(guarded.upstream).toBe('origin/main')
  expect(formatDoctorReport(guarded)).toContain('внешний Git-фильтр')
  expect(formatDoctorReport(guarded)).not.toContain('untracked.txt')
})
