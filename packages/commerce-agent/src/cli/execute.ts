#!/usr/bin/env bun
import { argument, createCliRuntime, failCli, hasFlag, print } from './runtime.ts'

function main(): void {
  const proposalId = argument('--proposal')
  if (!proposalId) throw new Error('Usage: --proposal <proposal_id> [--simulate-response-loss]')
  const runtime = createCliRuntime()
  print(runtime.executions.execute({ proposalId, principal: runtime.executorPrincipal, simulateResponseLoss: hasFlag('--simulate-response-loss') }))
}

try { main() } catch (error) { failCli(error) }
