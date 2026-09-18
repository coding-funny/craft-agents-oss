import { MonitorRuleConfigSchema, MonitorScanSchema, type Detection, type MonitorRuleConfig, type MonitorScan } from './contracts.ts'

const REQUIRED_FIELDS = ['salesUnits', 'stockUnits', 'adSpendMinor', 'adClicks', 'adConversions', 'adRevenueMinor']

export function detectAnomalies(scanValue: unknown, configValue: unknown): { scan: MonitorScan; config: MonitorRuleConfig; detections: Detection[] } {
  const scan = MonitorScanSchema.parse(scanValue)
  const config = MonitorRuleConfigSchema.parse(configValue)
  const detections: Detection[] = []
  for (const entity of scan.entities) {
    const missing = REQUIRED_FIELDS.filter(field => !entity.completeFields.includes(field))
    if (missing.length > 0) {
      detections.push({ anomalyType: 'DATA_INCOMPLETE', entityType: entity.entityType, entityId: entity.entityId, severity: 'LOW', reason: `Deferred: missing ${missing.join(', ')}`, metrics: { missingFieldCount: missing.length } })
      continue
    }
    if (entity.entityType === 'CAMPAIGN' && entity.current.adSpendMinor >= config.ads.minimumSpendMinor && entity.current.adClicks >= config.ads.minimumClicks) {
      const baselineCvr = entity.baseline.adClicks === 0 ? 0 : entity.baseline.adConversions / entity.baseline.adClicks
      const currentCvr = entity.current.adConversions / entity.current.adClicks
      const drop = baselineCvr === 0 ? 0 : (baselineCvr - currentCvr) / baselineCvr
      if (drop >= config.ads.cvrDropRatio) detections.push({
        anomalyType: 'ADS_EFFICIENCY', entityType: entity.entityType, entityId: entity.entityId,
        severity: drop >= config.ads.cvrDropRatio * 1.5 ? 'HIGH' : 'MEDIUM',
        reason: `CVR declined ${(drop * 100).toFixed(1)}%; rule scan does not establish causality`,
        metrics: { baselineCvr, currentCvr, cvrDropRatio: drop, spendMinor: entity.current.adSpendMinor, promotionActive: entity.promotionActive, holidayHint: entity.holidayHint },
      })
    }
    if (entity.entityType === 'SKU' && entity.baseline.salesUnits >= config.inventory.minimumBaselineSales) {
      const drop = (entity.baseline.salesUnits - entity.current.salesUnits) / entity.baseline.salesUnits
      if (drop >= config.inventory.salesDropRatio && entity.current.stockUnits <= config.inventory.lowStockUnits) detections.push({
        anomalyType: 'SALES_INVENTORY', entityType: entity.entityType, entityId: entity.entityId,
        severity: entity.current.stockUnits === 0 ? 'HIGH' : 'MEDIUM',
        reason: `Sales declined ${(drop * 100).toFixed(1)}% while stock is ${entity.current.stockUnits}; investigate before causal attribution`,
        metrics: { baselineSalesUnits: entity.baseline.salesUnits, currentSalesUnits: entity.current.salesUnits, salesDropRatio: drop, stockUnits: entity.current.stockUnits, promotionActive: entity.promotionActive, holidayHint: entity.holidayHint },
      })
    }
  }
  return { scan, config, detections }
}
