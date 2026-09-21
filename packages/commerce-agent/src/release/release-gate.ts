import { z } from 'zod'

export const ReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  environment: z.enum(['sandbox', 'pilot']),
  commit: z.string().regex(/^[a-f0-9]{7,40}$/),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  schemaVersions: z.array(z.string()).min(1),
  versions: z.object({ model: z.string().min(1), prompt: z.string().min(1), tool: z.string().min(1), policy: z.string().min(1) }).strict(),
  evaluation: z.object({ decision: z.enum(['PASS', 'BLOCKED', 'FAIL']), evidenceMode: z.enum(['fixture', 'live']), datasetDigest: z.string().min(1), reviewComplete: z.boolean() }).strict(),
  tests: z.object({ commercePassed: z.boolean(), webuiBuildPassed: z.boolean(), postgresVerified: z.boolean(), browserE2ePassed: z.boolean(), telemetryVerified: z.boolean(), workerRuntimeVerified: z.boolean(), backupRestoreVerified: z.boolean(), soakHours: z.number().nonnegative() }).strict(),
  createdAt: z.string().datetime(),
}).strict()

export type ReleaseDecision = { decision: 'PASS' | 'BLOCKED' | 'FAIL'; reasons: string[] }

export function evaluateRelease(value: unknown): ReleaseDecision {
  const parsed = ReleaseManifestSchema.safeParse(value)
  if (!parsed.success) return { decision: 'FAIL', reasons: ['MANIFEST_SCHEMA_INVALID'] }
  const manifest = parsed.data
  const failed = [
    !manifest.tests.commercePassed && 'COMMERCE_TESTS_FAILED',
    !manifest.tests.webuiBuildPassed && 'WEBUI_BUILD_FAILED',
    manifest.evaluation.decision === 'FAIL' && 'EVALUATION_FAILED',
  ].filter((item): item is string => Boolean(item))
  if (failed.length) return { decision: 'FAIL', reasons: failed }
  const blockers: string[] = []
  if (manifest.evaluation.decision !== 'PASS') blockers.push('EVALUATION_NOT_PASSED')
  if (manifest.environment === 'pilot') {
    if (manifest.evaluation.evidenceMode !== 'live') blockers.push('LIVE_EVALUATION_REQUIRED')
    if (!manifest.evaluation.reviewComplete) blockers.push('EVALUATION_REVIEW_REQUIRED')
    if (!manifest.tests.postgresVerified) blockers.push('POSTGRES_NOT_VERIFIED')
    if (!manifest.tests.browserE2ePassed) blockers.push('BROWSER_E2E_NOT_VERIFIED')
    if (!manifest.tests.telemetryVerified) blockers.push('TELEMETRY_NOT_VERIFIED')
    if (!manifest.tests.workerRuntimeVerified) blockers.push('WORKER_RUNTIME_NOT_VERIFIED')
    if (!manifest.tests.backupRestoreVerified) blockers.push('BACKUP_RESTORE_NOT_VERIFIED')
    if (manifest.tests.soakHours < 24) blockers.push('SOAK_24H_NOT_VERIFIED')
  }
  return { decision: blockers.length ? 'BLOCKED' : 'PASS', reasons: blockers }
}
