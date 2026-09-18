#!/usr/bin/env bun
import { argument, createCliRuntime, failCli, print } from './runtime.ts'

function main(): void {
  const proposalId = argument('--proposal')
  const reason = argument('--reason')
  const actor = argument('--actor') ?? 'local-operator'
  if (!proposalId || !reason) throw new Error('Usage: --proposal <proposal_id> --reason <text> [--actor <id>]')
  print(createCliRuntime().approvals.reject({ proposalId, actor, reason }))
}

try { main() } catch (error) { failCli(error) }
