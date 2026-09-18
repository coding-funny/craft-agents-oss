#!/usr/bin/env bun
import { argument, createCliRuntime, failCli, print } from './runtime.ts'

async function main(): Promise<void> {
  const reportId = argument('--from-report')
  if (!reportId) throw new Error('Usage: --from-report <report_id> [--recommendation <id>] [--expires-at <ISO>]')
  const runtime = createCliRuntime()
  const report = await runtime.reports.get(reportId)
  const recommendationId = argument('--recommendation') ?? report.recommendations[0]?.recommendationId
  if (!recommendationId) throw new Error('Report has no recommendation')
  const expiresAt = argument('--expires-at') ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  print(await runtime.proposals.create({ reportId, recommendationId, expiresAt }))
}

main().catch(failCli)
