import { CommerceError } from '../domain/errors.ts'

export class LoopDetector {
  readonly #counts = new Map<string, number>()
  readonly #limit: number
  constructor(limit = 3) { this.#limit = limit }

  observe(fingerprint: string, producedNewEvidence: boolean): void {
    if (producedNewEvidence) {
      this.#counts.set(fingerprint, 0)
      return
    }
    const count = (this.#counts.get(fingerprint) ?? 0) + 1
    this.#counts.set(fingerprint, count)
    if (count >= this.#limit) throw new CommerceError('LOOP_DETECTED', 'Repeated tool call produced no new evidence')
  }
}
