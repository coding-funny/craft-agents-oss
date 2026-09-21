# 03 acceptance record

Local CODE_READY verification on 2026-09-18:

- `bun run typecheck`: passed.
- `bun test`: 141 passed, 0 failed, 449 assertions.
- OIDC test starts a signed loopback IdP and uses actual HTTP authorize/token/JWKS requests; state replay is rejected.
- API tests cover unauthenticated access, CSRF/Origin denial, tenant hiding, same-tenant shop denial, idempotent replay/conflict and authorization revocation.
- Approval tests cover role matrix, self-approval, exact hash, review status, amount limit, approve/reject race, service execution identity and approver revocation before execution.
- PostgreSQL migration statically verifies forced RLS and transaction-local tenant/subject/shop context.

Not verified locally: real PostgreSQL with a non-owner/no-BYPASSRLS application role, pool reuse across tenants, or an external enterprise IdP. `COMMERCE_TEST_DATABASE_URL` remains required for the database integration command; absence is a non-zero external gate, not a skipped pass.
