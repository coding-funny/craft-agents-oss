#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises'
import { aggregateRunEvidence } from './aggregate.ts'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const input = argument('--evidence')
const output = argument('--output')
const repeats = Number(argument('--repeats') ?? 3)
if (!input) throw new Error('--evidence is required')
const text = await readFile(input, 'utf8')
const evidence = text.trim().startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map(line => JSON.parse(line))
const report = aggregateRunEvidence(evidence, repeats)
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
