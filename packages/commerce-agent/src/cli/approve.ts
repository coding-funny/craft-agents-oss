#!/usr/bin/env bun
import { argument, createCliRuntime, failCli, print } from './runtime.ts'

function main(): void {
  const proposalId = argument('--proposal')
  const actor = argument('--actor') ?? 'local-operator'
  const reason = argument('--reason') ?? 'Approved through the local operator CLI.'
  const confirmHash = argument('--confirm-hash')
  if (!proposalId) throw new Error('Usage: --proposal <proposal_id> --confirm-hash <content_hash> [--actor <id>] [--reason <text>]')
  const runtime = createCliRuntime()
  const proposal = runtime.repository.getOrThrow(proposalId)
  if (confirmHash !== proposal.contentHash) {
    print({ proposal, requiredConfirmation: proposal.contentHash })
    throw new Error('Explicit --confirm-hash matching the displayed proposal is required')
  }
  print(runtime.approvals.approve({ proposalId, actor, reason }))
}

try { main() } catch (error) { failCli(error) }
