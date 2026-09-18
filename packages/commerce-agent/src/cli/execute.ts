#!/usr/bin/env bun
import { argument, createCliRuntime, failCli, hasFlag, print } from './runtime.ts'

function main(): void {
  const proposalId = argument('--proposal')
  const actor = argument('--actor') ?? 'local-operator'
  if (!proposalId) throw new Error('Usage: --proposal <proposal_id> [--actor <id>] [--simulate-response-loss]')
  print(createCliRuntime().executions.execute({ proposalId, actor, simulateResponseLoss: hasFlag('--simulate-response-loss') }))
}

try { main() } catch (error) { failCli(error) }
