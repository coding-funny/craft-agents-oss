import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  defaultWorkflowPaths,
  DIAGNOSIS_CASES,
  DIAGNOSIS_SKILL_SLUG,
  DIAGNOSIS_SOURCE_SLUG,
  runDiagnosisCase,
  type DiagnosisCaseName,
} from '../src/diagnosis/workflow.ts'
import { ReportRepository } from '../src/reports/report-repository.ts'

const temporaryDirectories: string[] = []

function outputDir(): string {
  const path = mkdtempSync(resolve(tmpdir(), 'commerce-diagnosis-'))
  temporaryDirectories.push(path)
  return path
}

function options(reportDir: string) {
  return {
    fixtureDir: defaultWorkflowPaths().fixtureDir,
    reportDir,
    dbPath: resolve(reportDir, 'commerce.sqlite'),
    skillSlugs: [DIAGNOSIS_SKILL_SLUG],
    sourceSlugs: [DIAGNOSIS_SOURCE_SLUG],
  }
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('commerce diagnosis workflow', () => {
  for (const caseName of Object.keys(DIAGNOSIS_CASES) as DiagnosisCaseName[]) {
    it(`generates a readable schema-valid report for ${caseName}`, async () => {
      const reportDir = outputDir()
      const persisted = await runDiagnosisCase(caseName, options(reportDir))
      const reread = await new ReportRepository(reportDir).get(persisted.report.reportId)
      expect(reread.reportId).toBe(persisted.report.reportId)
      expect(reread.traceId).toBe(DIAGNOSIS_CASES[caseName].traceId)
      expect(reread.evidence.length).toBeGreaterThan(0)
      expect(reread.recommendations.every(item => item.kind === 'RECOMMENDATION')).toBe(true)
    })
  }

  it('keeps fixed-input metrics and evidence references stable', async () => {
    const first = await runDiagnosisCase('ads-conversion', options(outputDir()))
    const second = await runDiagnosisCase('ads-conversion', options(outputDir()))
    expect(second.report.reportId).toBe(first.report.reportId)
    expect(second.report.kpis).toEqual(first.report.kpis)
    expect(second.report.evidence.map(item => item.evidenceId)).toEqual(first.report.evidence.map(item => item.evidenceId))
  })

  it('marks missing advertising attribution as data needed', async () => {
    const result = await runDiagnosisCase('inventory-shortage', options(outputDir()))
    expect(result.report.status).toBe('NEEDS_DATA')
    expect(result.report.unknowns.some(item => item.statement.includes('Advertising attribution'))).toBe(true)
  })

  it('fails explicitly when the Skill or Source binding is missing', async () => {
    await expect(runDiagnosisCase('inventory-shortage', {
      ...options(outputDir()),
      skillSlugs: [],
    })).rejects.toThrow('Required Skill is not loaded')
    await expect(runDiagnosisCase('inventory-shortage', {
      ...options(outputDir()),
      sourceSlugs: [],
    })).rejects.toThrow('Required Source is not enabled')
  })

  it('enforces a hard diagnosis tool-call budget', async () => {
    await expect(runDiagnosisCase('ads-conversion', {
      ...options(outputDir()),
      maxToolCalls: 8,
    })).rejects.toThrow('tool-call budget exceeded')
  })
})
