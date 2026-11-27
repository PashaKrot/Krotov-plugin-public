import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { atomicWriteInRoot } from '../autonomy/store.js'
import { object } from './rpc.js'

export type NativeApprovalPolicy = 'never' | 'on-request'

export class ApprovalContextRefreshError extends Error {
  constructor() { super('Could not refresh the context for the current approval policy') }
}

export class ApprovalContext {
  private readonly directory: string
  private readonly filename: string
  private policies = new Map<string, NativeApprovalPolicy>()

  constructor(stateFile: string, private readonly policy: NativeApprovalPolicy) {
    this.directory = dirname(stateFile)
    this.filename = basename(stateFile) + '.approval-context.json'
    try {
      const saved = object(JSON.parse(readFileSync(join(this.directory, this.filename), 'utf8')))
      for (const [thread, policy] of Object.entries(saved).slice(-64)) {
        if (policy === 'never' || policy === 'on-request') this.policies.set(thread, policy)
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  needsRefresh(thread: string): boolean {
    // Older versions kept the thread ID alone. If cards are enabled, refresh the legacy thread once.
    return (this.policies.get(thread) ?? 'never') !== this.policy
  }

  remember(thread: string, policy = this.policy): void {
    if (this.policies.get(thread) === policy) return
    const updated = new Map(this.policies)
    updated.delete(thread)
    updated.set(thread, policy)
    if (updated.size > 64) updated.delete(updated.keys().next().value!)
    atomicWriteInRoot({ root: this.directory }, this.filename, JSON.stringify(Object.fromEntries(updated)) + '\n')
    this.policies = updated
  }

  rememberFork(source: string, target: string): void {
    this.remember(target, this.policies.get(source) ?? 'never')
  }
}
