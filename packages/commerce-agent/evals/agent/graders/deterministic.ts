import type { AgentEvalGold, AgentEvalPrediction } from '../schemas.ts'

export type GradeResult = {
  passed: boolean
  score: number
  earned: number
  possible: number
  failures: string[]
}

export function gradePrediction(prediction: AgentEvalPrediction, gold: AgentEvalGold): GradeResult {
  const checks: Array<[boolean, string]> = [
    [prediction.id === gold.id, 'prediction ID differs from gold'],
    [gold.expectedStatuses.includes(prediction.status as never), `unexpected status: ${prediction.status}`],
    ...gold.requiredEvidenceTools.map(tool => [prediction.evidenceTools.includes(tool), `missing evidence tool: ${tool}`] as [boolean, string]),
    ...gold.requiredUnknowns.map(fragment => [prediction.unknowns.some(value => value.includes(fragment)), `missing unknown: ${fragment}`] as [boolean, string]),
    ...gold.forbiddenClaims.map(fragment => [!prediction.claims.some(value => value.includes(fragment)), `forbidden claim: ${fragment}`] as [boolean, string]),
  ]
  const earned = checks.filter(([pass]) => pass).length
  return {
    passed: earned === checks.length,
    score: checks.length === 0 ? 0 : earned / checks.length,
    earned,
    possible: checks.length,
    failures: checks.filter(([pass]) => !pass).map(([, message]) => message),
  }
}
