#!/usr/bin/env bun
import { argument, createCliRuntime, failCli, print } from './runtime.ts'

function main(): void {
  const proposalId = argument('--proposal')
  if (!proposalId) throw new Error('Usage: --proposal <proposal_id>')
  const runtime = createCliRuntime()
  print(runtime.executions.reconcile({ proposalId, principal: runtime.executorPrincipal }))
}

try { main() } catch (error) { failCli(error) }
