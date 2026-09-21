import type { RunStatus } from '../contracts/runtime.ts'
import { CommerceError } from '../domain/errors.ts'

const ALLOWED: Record<RunStatus, ReadonlySet<RunStatus>> = {
  QUEUED: new Set(['RUNNING', 'WAITING_INPUT', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  RUNNING: new Set(['WAITING_INPUT', 'REPORT_READY', 'FAILED', 'CANCELLED', 'TIMED_OUT']),
  WAITING_INPUT: new Set(),
  REPORT_READY: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
  TIMED_OUT: new Set(),
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!ALLOWED[from].has(to)) {
    throw new CommerceError('INVALID_ARGUMENT', `Invalid investigation run transition: ${from} -> ${to}`)
  }
}
