import { CommerceError } from '../domain/errors.ts'

export const PROPOSAL_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'MANUAL_REVIEW',
] as const

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

const TRANSITIONS: Record<ProposalStatus, ProposalStatus[]> = {
  DRAFT: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'EXPIRED'],
  APPROVED: ['EXECUTING', 'EXPIRED'],
  REJECTED: [],
  EXPIRED: [],
  EXECUTING: ['SUCCEEDED', 'FAILED', 'UNKNOWN', 'MANUAL_REVIEW'],
  SUCCEEDED: [],
  FAILED: [],
  UNKNOWN: ['SUCCEEDED', 'FAILED', 'MANUAL_REVIEW'],
  MANUAL_REVIEW: [],
}

export function assertProposalTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new CommerceError('INVALID_ARGUMENT', `Illegal proposal transition: ${from} -> ${to}`)
  }
}
