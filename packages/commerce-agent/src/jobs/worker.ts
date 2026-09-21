import type { JobHandler, JobKind, LeaseToken } from './contracts.ts'
import { CancelledJobError, ManualReviewJobError, RetryableJobError, WaitingInputJobError } from './contracts.ts'
import type { DurableJobRepository } from './repository.ts'

export class DurableWorker {
  readonly #repository: DurableJobRepository
  readonly #workerId: string
  readonly #handlers: Partial<Record<JobKind, JobHandler>>
  readonly #leaseMs: number
  readonly #heartbeatMs: number
  readonly #now: () => Date
  readonly #maxActivePerTenant: number

  constructor(options: {
    repository: DurableJobRepository; workerId: string; handlers: Partial<Record<JobKind, JobHandler>>
    leaseMs?: number; heartbeatMs?: number; maxActivePerTenant?: number; now?: () => Date
  }) {
    this.#repository = options.repository
    this.#workerId = options.workerId
    this.#handlers = options.handlers
    this.#leaseMs = options.leaseMs ?? 30_000
    this.#heartbeatMs = options.heartbeatMs ?? Math.max(250, Math.floor(this.#leaseMs / 3))
    this.#maxActivePerTenant = options.maxActivePerTenant ?? 2
    this.#now = options.now ?? (() => new Date())
  }

  async runOnce(): Promise<boolean> {
    const kinds = Object.keys(this.#handlers) as JobKind[]
    const lease = this.#repository.claim({
      workerId: this.#workerId, kinds, now: this.#now().toISOString(),
      leaseMs: this.#leaseMs, maxActivePerTenant: this.#maxActivePerTenant,
    })
    if (!lease) return false
    const token: LeaseToken = { jobId: lease.jobId, owner: this.#workerId, epoch: lease.leaseEpoch }
    const controller = new AbortController()
    const heartbeat = setInterval(() => {
      const now = this.#now().toISOString()
      if (this.#repository.isCancellationRequested(lease.jobId)) controller.abort('cancel-requested')
      if (!this.#repository.heartbeat(token, now, this.#leaseMs)) controller.abort('lease-lost')
    }, this.#heartbeatMs)
    try {
      const handler = this.#handlers[lease.kind]
      if (!handler) throw new ManualReviewJobError(`No handler registered for ${lease.kind}`)
      await handler({
        lease, signal: controller.signal,
        checkpoint: (key, state) => this.#repository.checkpoint(token, key, state, this.#now().toISOString()),
        isCancellationRequested: () => this.#repository.isCancellationRequested(lease.jobId),
      })
      this.#repository.succeed(token, this.#now().toISOString())
    } catch (error) {
      const now = this.#now().toISOString()
      const detail = { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }
      if (error instanceof ManualReviewJobError) this.#repository.manualReview(token, now, detail)
      else if (error instanceof WaitingInputJobError) this.#repository.waitingInput(token, now)
      else if (error instanceof CancelledJobError) this.#repository.cancelLeased(token, now)
      else if (error instanceof RetryableJobError) {
        const delay = error.retryAfterMs ?? Math.min(60_000, 1_000 * (2 ** Math.max(0, lease.attempts - 1)))
        this.#repository.retry(token, now, new Date(Date.parse(now) + delay).toISOString(), detail)
      } else this.#repository.fail(token, now, detail)
    } finally {
      clearInterval(heartbeat)
    }
    return true
  }

  async run(signal: AbortSignal, idleMs = 250): Promise<void> {
    while (!signal.aborted) {
      const worked = await this.runOnce()
      if (!worked) await new Promise(resolve => setTimeout(resolve, idleMs))
    }
  }
}
