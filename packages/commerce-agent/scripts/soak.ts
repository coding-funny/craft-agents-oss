import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

const Config = z.object({ environment: z.enum(['fixture', 'sandbox']), baseUrl: z.string().url(), durationHours: z.number().positive().max(48), intervalSeconds: z.number().int().min(5).max(300), outputPath: z.string().min(1), confirmation: z.literal('SOAK_NON_PRODUCTION') }).strict()

export async function runSoak(raw: unknown, signal?: AbortSignal): Promise<{ samples: number; failures: number; actualHours: number }> {
  const config = Config.parse(raw); const base = new URL(config.baseUrl)
  if (!['127.0.0.1', 'localhost', '::1'].includes(base.hostname)) throw new Error('Soak target must be loopback; use a reviewed dedicated runner for remote environments')
  await mkdir(dirname(config.outputPath), { recursive: true })
  const started = Date.now(); const deadline = started + config.durationHours * 3_600_000; let samples = 0; let failures = 0
  while (Date.now() < deadline && !signal?.aborted) {
    const checkedAt = new Date().toISOString(); let status = 0; let error: string | undefined
    try { const response = await fetch(new URL('/health/ready', base)); status = response.status; if (!response.ok) failures += 1 } catch (caught) { failures += 1; error = caught instanceof Error ? caught.name : 'Error' }
    samples += 1
    await appendFile(config.outputPath, `${JSON.stringify({ checkedAt, status, error })}\n`)
    if (Date.now() < deadline && !signal?.aborted) await Bun.sleep(config.intervalSeconds * 1_000)
  }
  return { samples, failures, actualHours: (Date.now() - started) / 3_600_000 }
}

if (import.meta.main) {
  const index = process.argv.indexOf('--config'); const path = index >= 0 ? process.argv[index + 1] : undefined
  if (!path) throw new Error('--config is required')
  console.log(JSON.stringify(await runSoak(JSON.parse(await readFile(path, 'utf8'))), null, 2))
}
