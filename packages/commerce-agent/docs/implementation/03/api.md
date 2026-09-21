# Commerce API v1

The independent entrypoint is `bun run api` in `packages/commerce-agent`. Required configuration is explicit: OIDC issuer/audience/client/endpoints/redirect, allowed origins, data digest and as-of timestamp. Missing values fail startup.

Routes use `/api/v1`: auth start/callback/logout, `me`, task create/read/events, report/evidence/proposal read, and proposal approve/reject. Responses include `traceId`. Scoped object reads return 404 for both missing and out-of-scope IDs.

Task creation requires `Idempotency-Key`. Its namespace is `(tenant, actor, operation, key)`: identical payloads replay the stored result, while a changed payload returns 409. Write requests require the opaque session, an allowlisted Origin and `x-csrf-token`.

Approval bodies contain only `reason` and `confirmHash`; actor, tenant, roles and shops come from the resolved session. The old CLIs fail closed unless `COMMERCE_AUTH_MODE=local-test`, and they no longer consume `--actor` as authority.
