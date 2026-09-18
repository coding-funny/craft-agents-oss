export type ConfidenceInput = {
  supportingEvidenceCount: number
  counterEvidenceCount: number
  hasConflict?: boolean
  missingCriticalData?: boolean
}

export type ConfidenceResult = {
  score: number
  level: 'LOW' | 'MEDIUM' | 'HIGH'
}

export function assessConfidence(input: ConfidenceInput): ConfidenceResult {
  let score = 0.35 + Math.min(input.supportingEvidenceCount, 3) * 0.18
  score -= Math.min(input.counterEvidenceCount, 2) * 0.12
  if (input.hasConflict) score -= 0.2
  if (input.missingCriticalData) score -= 0.25
  score = Math.max(0.05, Math.min(0.95, Math.round(score * 100) / 100))
  return { score, level: score >= 0.75 ? 'HIGH' : score >= 0.5 ? 'MEDIUM' : 'LOW' }
}
