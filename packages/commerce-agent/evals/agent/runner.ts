#!/usr/bin/env bun
import { loadAgentEval } from './dataset.ts'

function valueFor(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const suite = valueFor('--suite') ?? 'dev'
if (suite !== 'dev' && suite !== 'smoke') throw new Error('--suite must be dev or smoke')
const dataset = await loadAgentEval()
const ids = dataset.splits[suite]
const selected = dataset.cases.filter(item => ids.includes(item.id))
process.stdout.write(`${JSON.stringify({
  status: 'dataset_ready',
  suite,
  cases: selected.length,
  categories: Object.fromEntries([...new Set(selected.map(item => item.category))].map(category => [category, selected.filter(item => item.category === category).length])),
  note: 'This command validates the development dataset; it does not claim live-model accuracy.',
})}\n`)
