# 01 Baseline Audit

Date: 2026-09-18. Branch: `codex/production-upgrade-01`. Starting HEAD: `e8963854`.

The target worktree initially did not contain the commerce package. B00 restored the previously tested commerce baseline from the local historical workspace at commit `0561730`, including `packages/commerce-agent`, the commerce workspace example, fixtures, deterministic evaluation, and root commands. No files were copied from `node_modules`.

Before the dynamic-agent changes, the restored baseline passed:

- `bun run commerce:typecheck`: exit 0.
- `bun run commerce:test`: 75 passed, 0 failed.
- `bun run commerce:test:mcp`: 49 passed, 0 failed.

The pre-existing staged change in `packages/core/src/types/index.ts` belongs to the user and is excluded from this chain's commit.
