#!/usr/bin/env bun
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { buildAblations, buildBaselines } from './baselines.ts'
import { runEvalCase } from './case-runner.ts'
import { aggregateScores, percentile } from './scorers.ts'
import { EvalCaseSchema, type EvaluationReport } from './types.ts'

export async function loadDataset(path: string) {
  const rows = (await readFile(path, 'utf8')).split('\n').map(line => line.trim()).filter(Boolean)
  const cases = rows.map((line, index) => {
    try { return EvalCaseSchema.parse(JSON.parse(line)) } catch (error) { throw new Error(`Invalid dataset row ${index + 1}: ${error}`) }
  })
  const ids = new Set(cases.map(item => item.id))
  if (ids.size !== cases.length) throw new Error('Evaluation dataset contains duplicate IDs')
  return cases
}

function markdown(report: EvaluationReport, baselines: ReturnType<typeof buildBaselines>, ablations: Awaited<ReturnType<typeof buildAblations>>): string {
  const scoreRows = Object.entries(report.scores).map(([name, score]) =>
    `| ${name} | ${score.passed}/${score.total} | ${score.rate === null ? 'N/A' : `${(score.rate * 100).toFixed(2)}%`} |`).join('\n')
  const failures = report.results.filter(item => !item.passed)
    .map(item => `- \`${item.id}\`: ${item.error ?? JSON.stringify(item.details)}`).join('\n') || '- 无'
  return `# Commerce Agent 确定性评测报告

> 本报告是固定 Fixture 上的离线确定性回归，不是线上业务效果，也不是外部 LLM 质量评测。

## 概览

- 数据集：${report.datasetSize} 条（dev ${report.splitCounts.dev} / holdout ${report.splitCounts.holdout}）
- 通过：${report.passed}；失败：${report.failed}；通过率：${(report.passRate * 100).toFixed(2)}%
- 延迟：平均 ${report.latencyMs.average.toFixed(2)}ms，P95 ${report.latencyMs.p95.toFixed(2)}ms

## 指标

| 指标 | 命中/样本 | 比率 |
| --- | ---: | ---: |
${scoreRows}

除 \`unsupportedClaimRate\` 表示错误声明命中率（越低越好）外，其余指标表示通过率（越高越好）。

## 基线

${baselines.map(item => `- **${item.name}**：${item.passed}/${item.sampleSize}，${item.description}`).join('\n')}

## 消融

${ablations.map(item => `- **${item.mechanism}**：保护路径=${item.protectedPassed ? '通过' : '失败'}；移除机制后的反事实结果=失败。${item.impact}`).join('\n')}

## 失败案例

${failures}

## 局限

${report.limitations.map(item => `- ${item}`).join('\n')}
`
}

export async function runEvaluation(options: { datasetPath?: string; outputDir?: string; runtimeRoot?: string } = {}) {
  const packageRoot = resolve(import.meta.dir, '..')
  const datasetPath = options.datasetPath ?? resolve(import.meta.dir, 'dataset.jsonl')
  const outputDir = options.outputDir ?? resolve(packageRoot, 'demo/results')
  const runtimeRoot = options.runtimeRoot ?? await mkdtemp(resolve(tmpdir(), 'commerce-eval-'))
  const fixtureDir = resolve(packageRoot, 'fixtures')
  const dataset = await loadDataset(datasetPath)
  const results = []
  for (const item of dataset) results.push(await runEvalCase(item, runtimeRoot, fixtureDir))
  const totalLatency = results.reduce((sum, item) => sum + item.latencyMs, 0)
  const passed = results.filter(item => item.passed).length
  const report: EvaluationReport = {
    mode: 'deterministic-offline',
    datasetSize: dataset.length,
    splitCounts: {
      dev: dataset.filter(item => item.split === 'dev').length,
      holdout: dataset.filter(item => item.split === 'holdout').length,
    },
    passed,
    failed: dataset.length - passed,
    passRate: Math.round((passed / dataset.length) * 10_000) / 10_000,
    latencyMs: {
      total: Math.round(totalLatency * 100) / 100,
      average: Math.round((totalLatency / dataset.length) * 100) / 100,
      p95: percentile(results.map(item => item.latencyMs), 0.95),
    },
    scores: aggregateScores(results),
    results,
    limitations: [
      'The 24 rows are synthetic deterministic regression cases over fixed fixtures, not 24 production merchant incidents.',
      'No external LLM is invoked, so prompt robustness, token cost, and model variance are not measured.',
      'Counterfactual baselines and ablations isolate engineering safeguards; they are not claims of model-quality uplift.',
    ],
  }
  const baselines = buildBaselines(results)
  const ablations = await buildAblations(results)
  await mkdir(outputDir, { recursive: true })
  await writeFile(resolve(outputDir, 'evaluation-results.json'), `${JSON.stringify({ report, baselines, ablations }, null, 2)}\n`)
  await writeFile(resolve(outputDir, 'evaluation-report.md'), markdown(report, baselines, ablations))
  return { report, baselines, ablations, outputDir }
}

if (import.meta.main) {
  runEvaluation().then(result => {
    console.log(JSON.stringify({
      dataset_size: result.report.datasetSize,
      passed: result.report.passed,
      failed: result.report.failed,
      pass_rate: result.report.passRate,
      output_dir: result.outputDir,
    }, null, 2))
    if (result.report.failed > 0) process.exitCode = 1
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
