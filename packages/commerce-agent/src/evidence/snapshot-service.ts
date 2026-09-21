import type { DataSnapshot } from '../data/contracts.ts'
import { CommerceError } from '../domain/errors.ts'
import type { DataGovernanceRepository } from '../storage/ports/data-governance-repository.ts'

export class SnapshotService {
  readonly #repository: DataGovernanceRepository

  constructor(repository: DataGovernanceRepository) {
    this.#repository = repository
  }

  async bind(scope: { tenantId: string; shopId: string; asOf: string }): Promise<DataSnapshot> {
    const snapshot = await this.#repository.resolveSnapshot(scope)
    if (!snapshot) throw new CommerceError('NOT_FOUND', 'No governed data snapshot is available for the requested asOf')
    if (Date.parse(snapshot.asOf) > Date.parse(scope.asOf)) {
      throw new CommerceError('INTERNAL', 'Repository returned a snapshot newer than the requested asOf')
    }
    return snapshot
  }
}
