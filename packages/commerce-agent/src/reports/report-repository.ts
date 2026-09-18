import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CommerceError } from '../domain/errors.ts'
import { DiagnosisReportSchema, type DiagnosisReport, type DiagnosisReportDraft } from './schema.ts'

export type ReportStore = {
  saveReport(report: DiagnosisReport, contentHash: string): void
  getReport(reportId: string): { report: DiagnosisReport; contentHash: string } | undefined
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]))
  }
  return value
}

export function createReportId(draft: DiagnosisReportDraft): string {
  const digest = createHash('sha256').update(JSON.stringify(canonicalize(draft))).digest('hex')
  return `report_${digest.slice(0, 24)}`
}

export function reportContentHash(report: DiagnosisReport): string {
  const { reportId: _reportId, ...draft } = report
  return createHash('sha256').update(JSON.stringify(canonicalize(draft))).digest('hex')
}

export type PersistedReport = {
  report: DiagnosisReport
  jsonPath: string
  markdownPath: string
}

export class ReportRepository {
  readonly #root: string
  readonly #store?: ReportStore

  constructor(root: string, store?: ReportStore) {
    this.#root = resolve(root)
    this.#store = store
  }

  async save(draft: DiagnosisReportDraft, markdown: string): Promise<PersistedReport> {
    const report = DiagnosisReportSchema.parse({ ...draft, reportId: createReportId(draft) })
    // The database is the primary record. Markdown/JSON files are reproducible projections.
    this.#store?.saveReport(report, reportContentHash(report))
    await mkdir(this.#root, { recursive: true })
    const jsonPath = resolve(this.#root, `${report.reportId}.json`)
    const markdownPath = resolve(this.#root, `${report.reportId}.md`)
    await this.#atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
    await this.#atomicWrite(markdownPath, markdown)
    const reread = await this.get(report.reportId)
    if (JSON.stringify(reread) !== JSON.stringify(report)) {
      throw new CommerceError('INTERNAL', `Persisted report failed read-back verification: ${report.reportId}`)
    }
    return { report, jsonPath, markdownPath }
  }

  async get(reportId: string): Promise<DiagnosisReport> {
    const parsed = DiagnosisReportSchema.shape.reportId.safeParse(reportId)
    if (!parsed.success) throw new CommerceError('INVALID_ARGUMENT', 'Invalid report ID')
    const persisted = this.#store?.getReport(reportId)
    if (persisted) return this.#assertIntegrity(persisted.report, reportId, persisted.contentHash)
    const path = resolve(this.#root, `${reportId}.json`)
    try {
      const report = DiagnosisReportSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      return this.#assertIntegrity(report, reportId, reportContentHash(report))
    } catch (error) {
      if (error instanceof CommerceError) throw error
      throw new CommerceError('NOT_FOUND', `Report not found or unreadable: ${reportId}`)
    }
  }

  #assertIntegrity(report: DiagnosisReport, requestedId: string, storedHash: string): DiagnosisReport {
    const { reportId: _reportId, ...draft } = report
    const expectedId = createReportId(draft)
    const actualHash = reportContentHash(report)
    if (report.reportId !== requestedId || expectedId !== requestedId || actualHash !== storedHash) {
      throw new CommerceError('INVALID_ARGUMENT', `Report integrity check failed: ${requestedId}`)
    }
    return report
  }

  async #atomicWrite(path: string, content: string): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'w' })
    await rename(temporary, path)
  }
}
