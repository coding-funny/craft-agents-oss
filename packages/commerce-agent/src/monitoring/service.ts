import { detectAnomalies } from './detector.ts'
import type { MonitorRepository } from './repository.ts'

export class MonitorService {
  constructor(private readonly repository: MonitorRepository, private readonly now: () => Date = () => new Date()) {}

  scan(scanValue: unknown, configValue: unknown) {
    const { scan, config, detections } = detectAnomalies(scanValue, configValue)
    let created = 0
    const items = detections.map(detection => {
      if (created >= config.maxNewCasesPerScan) return { detection, outcome: 'QUOTA_SUPPRESSED' as const }
      const result = this.repository.record(scan, config, detection, this.now().toISOString())
      if (result.created) created += 1
      return { detection, outcome: result.duplicate ? 'DUPLICATE' as const : result.created ? 'CREATED' as const : result.severityEscalated ? 'ESCALATED' as const : 'MERGED' as const, case: result.item }
    })
    return { ruleVersion: config.ruleVersion, scannedEntities: scan.entities.length, detections: items, newCases: created }
  }
}
