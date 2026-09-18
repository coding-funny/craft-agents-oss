import type { ProposalRepository } from './repository.ts'

export class AuditLog {
  readonly #repository: ProposalRepository

  constructor(repository: ProposalRepository) {
    this.#repository = repository
  }

  list(proposalId: string): Array<Record<string, unknown>> {
    return this.#repository.listAudit(proposalId)
  }
}
