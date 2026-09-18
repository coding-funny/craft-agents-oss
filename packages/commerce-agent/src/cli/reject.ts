#!/usr/bin/env bun
import { argument, createCliRuntime, failCli, print } from './runtime.ts'

function main(): void {
  const proposalId = argument('--proposal')
  const reason = argument('--reason')
  const confirmHash = argument('--confirm-hash')
  if (!proposalId || !reason || !confirmHash) throw new Error('Usage: --proposal <proposal_id> --reason <text> --confirm-hash <content_hash>')
  const runtime = createCliRuntime()
  print(runtime.approvals.reject({ proposalId, principal: runtime.approverPrincipal, reason, confirmHash }))
}

try { main() } catch (error) { failCli(error) }
