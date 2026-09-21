# 01 Handoff

## Stable interfaces

- `InvestigationInput`, `PrincipalContext`, `InvestigationTask`, and `InvestigationResult` are in `src/contracts` and parsed with strict Zod schemas.
- `ModelTurnPort` separates one model generation from tool execution; `PiModelTurnPort` is live-only and `FakeModelTurnPort` is explicitly scripted.
- `CommerceAdapter` is the read-only domain boundary. `FixtureAdapter` remains the chain-01 implementation.
- `ScopedToolDispatcher` publishes and executes only the commerce allowlist and injects task scope server-side.
- `InvestigationRepository` stores task versions, Run parentage, manifests, ordered events, and checkpoints in SQLite.

## Commands

```bash
bun run commerce:typecheck
bun run commerce:test:agent
bun run commerce:test
bun run commerce:investigate -- --input examples/investigation/input.missing-scope.json --config examples/investigation/local.fake.json
bun run commerce:investigation:status -- --run <run-id> --config examples/investigation/local.fake.json
bun run commerce:eval:agent -- --suite smoke
```

Continuation uses `--continue-task <task-id> --answers <answers.json>`. The answers document has an `expectedTaskVersion` and a strict partial `scope`; identity and budget cannot be supplied by the answer.

## Next-chain boundaries

Chain 02 can replace `CommerceAdapter` and extend evidence snapshot metadata without changing the model driver. Chain 05 can reuse the 20-case case/gold split and manifest model-mode field. Chain 04 owns worker leases, crash recovery, and external-write reconciliation; this chain only provides immutable terminal Runs and explicit parent-child continuation.

Remaining external work is the five-task live smoke. Remaining local hardening is an OS-level SIGINT subprocess test and a second-fixture dynamic-branch test. These do not authorize using unconfigured credentials or representing fake runs as live results.
