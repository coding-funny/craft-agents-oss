import { readFile } from 'node:fs/promises'
import { evaluateRelease } from '../src/release/release-gate.ts'

function option(argv: string[], name: string): string {
  const index = argv.indexOf(name); const value = index >= 0 ? argv[index + 1] : undefined
  if (!value) throw new Error(`${name} is required`)
  return value
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const manifest = JSON.parse(await readFile(option(argv, '--manifest'), 'utf8'))
  const result = evaluateRelease(manifest)
  console.log(JSON.stringify(result, null, 2))
  if (result.decision !== 'PASS') process.exitCode = result.decision === 'BLOCKED' ? 2 : 1
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
