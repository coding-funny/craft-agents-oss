#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadAgentEval } from './dataset.ts'
import { ReleasePolicySchema } from './schemas.ts'

export async function validateDevelopmentDataset(root = import.meta.dir) {
  const dataset = await loadAgentEval(root)
  const policy = ReleasePolicySchema.parse(JSON.parse(await readFile(resolve(root, 'release-policy.json'), 'utf8')))
  const serializedCases = JSON.stringify(dataset.cases)
  const forbidden = ['expectedStatuses', 'requiredEvidenceTools', 'requiredUnknowns', 'forbiddenClaims']
  const leakedFields = forbidden.filter(field => serializedCases.includes(field))
  if (leakedFields.length) throw new Error(`Model-visible cases contain gold fields: ${leakedFields.join(', ')}`)
  return {
    status: 'development_seed_ready' as const,
    devCases: dataset.cases.length,
    smokeCases: dataset.splits.smoke.length,
    datasetDigest: dataset.digest,
    policyId: policy.policyId,
    releaseBlockers: [
      `Holdout target is ${policy.requiredTaskCount}; no frozen holdout dataset is present.`,
      'No live-model repeated run evidence is present.',
      'No human holdout review evidence is present.',
    ],
  }
}

if (import.meta.main) console.log(JSON.stringify(await validateDevelopmentDataset(), null, 2))
