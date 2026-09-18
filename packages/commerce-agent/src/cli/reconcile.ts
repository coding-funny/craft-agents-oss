#!/usr/bin/env bun
import { argument, createCliRuntime, failCli, print } from './runtime.ts'

function main(): void {
  const proposalId = argument('--proposal')
  const actor = argument('--actor') ?? 'local-operator'
  if (!proposalId) throw new Error('Usage: --proposal <proposal_id> [--actor <id>]')
  print(createCliRuntime().executions.reconcile({ proposalId, actor }))
}

try { main() } catch (error) { failCli(error) }
