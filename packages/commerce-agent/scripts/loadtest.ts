import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const Config = z.object({
  environment: z.enum(['fixture', 'sandbox']),
  baseUrl: z.string().url(),
  endpoint: z.enum(['/health/live', '/health/ready']),
  durationSeconds: z.number().int().min(1).max(600),
  requestsPerSecond: z.number().int().min(1).max(100),
  confirmation: z.literal('LOAD_TEST_NON_PRODUCTION'),
}).strict()

export async function runLoadTest(raw: unknown): Promise<{ requests: number; errors: number; errorRate: number; p95Ms: number; durationSeconds: number }> {
  const config = Config.parse(raw); const url = new URL(config.baseUrl)
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('Load test target must be loopback; run remote tests from a controlled runner with a reviewed adapter')
  const samples: number[] = []; let errors = 0
  const intervalMs = 1_000 / config.requestsPerSecond; const deadline = performance.now() + config.durationSeconds * 1_000
  while (performance.now() < deadline) {
    const started = performance.now()
    try { const response = await fetch(new URL(config.endpoint, url)); if (!response.ok) errors += 1 } catch { errors += 1 }
    samples.push(performance.now() - started)
    const remaining = intervalMs - (performance.now() - started); if (remaining > 0) await Bun.sleep(remaining)
  }
  samples.sort((a, b) => a - b); const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? 0
  return { requests: samples.length, errors, errorRate: samples.length ? errors / samples.length : 0, p95Ms: Math.round(p95 * 100) / 100, durationSeconds: config.durationSeconds }
}

if (import.meta.main) {
  const index = process.argv.indexOf('--config'); const path = index >= 0 ? process.argv[index + 1] : undefined
  if (!path) throw new Error('--config is required')
  console.log(JSON.stringify(await runLoadTest(JSON.parse(await readFile(path, 'utf8'))), null, 2))
}
