import type { CaseRunState } from './case-repository.ts'

export const CASE_COMPLETION_STATES: CaseRunState[] = [
  'REPORT_READY',
  'PROPOSAL_PENDING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'TIMED_OUT',
]

export function isCaseCompletionState(state: CaseRunState): boolean {
  return CASE_COMPLETION_STATES.includes(state)
}
