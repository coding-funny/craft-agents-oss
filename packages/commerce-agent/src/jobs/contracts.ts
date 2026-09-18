export const JOB_KINDS = ['INVESTIGATE', 'EXECUTE', 'RECONCILE'] as const
export type JobKind = (typeof JOB_KINDS)[number]

export const JOB_STATUSES = [
  'READY', 'LEASED', 'RETRY_WAIT', 'WAITING_INPUT',
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'MANUAL_REVIEW',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export type DurableJob<T = unknown> = {
  jobId: string
  kind: JobKind
  tenantId: string
  shopId: string
  businessKey: string
  payload: T
  priority: number
  status: JobStatus
  availableAt: string
  attempts: number
  maxAttempts: number
  leaseOwner?: string
  leaseUntil?: string
  leaseEpoch: number
  cancelRequestedAt?: string
  lastError?: unknown
  createdAt: string
  updatedAt: string
}

export type JobLease<T = unknown> = DurableJob<T> & {
  status: 'LEASED'
  leaseOwner: string
  leaseUntil: string
}

export type LeaseToken = {
  jobId: string
  owner: string
  epoch: number
}

export type JobContext = {
  lease: JobLease
  signal: AbortSignal
  checkpoint(key: string, state: unknown): boolean
  isCancellationRequested(): boolean
}

export type JobHandler = (context: JobContext) => Promise<void>

export class RetryableJobError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message)
    this.name = 'RetryableJobError'
  }
}

export class ManualReviewJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManualReviewJobError'
  }
}

export class WaitingInputJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WaitingInputJobError'
  }
}

export class CancelledJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CancelledJobError'
  }
}
