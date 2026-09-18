#!/usr/bin/env bun
import {
  defaultWorkflowPaths,
  DIAGNOSIS_CASES,
  DIAGNOSIS_SKILL_SLUG,
  DIAGNOSIS_SOURCE_SLUG,
  runDiagnosisCase,
  type DiagnosisCaseName,
} from '../diagnosis/workflow.ts'
import { JsonlTraceRecorder } from '../mcp/trace.ts'

function parseCase(): DiagnosisCaseName {
  const index = process.argv.indexOf('--case')
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || !(value in DIAGNOSIS_CASES)) {
    throw new Error(`Usage: bun run diagnose --case ${Object.keys(DIAGNOSIS_CASES).join('|')}`)
  }
  return value as DiagnosisCaseName
}

async function main(): Promise<void> {
  const caseName = parseCase()
  const paths = defaultWorkflowPaths()
  const persisted = await runDiagnosisCase(caseName, {
    ...paths,
    skillSlugs: [DIAGNOSIS_SKILL_SLUG],
    sourceSlugs: [DIAGNOSIS_SOURCE_SLUG],
    traceRecorder: new JsonlTraceRecorder(`${paths.reportDir}/${caseName}.trace.jsonl`),
  })
  console.log(JSON.stringify({
    status: persisted.report.status,
    report_id: persisted.report.reportId,
    trace_id: persisted.report.traceId,
    json_path: persisted.jsonPath,
    markdown_path: persisted.markdownPath,
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
