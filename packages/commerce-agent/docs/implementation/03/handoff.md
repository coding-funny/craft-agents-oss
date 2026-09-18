# 03 handoff

04 may trust `AuthenticatedPrincipal` only when produced by the session resolver or a provisioned service identity. Durable workers must use an EXECUTOR service principal and wire `IdentityRepository.assertApprovalStillAuthorized` into `ExecutionService.approvalGuard` before a remote side effect.

Proposal v2 binds tenant, shop, requester, snapshot/review state, policy version and target version into `contentHash`. Approval records bind actor, subject, session, proposal hash, policy version and reason code. Do not downgrade these fields or reintroduce arbitrary actor strings.

04 should persist work leases, attempts and outbox transitions without weakening the current conditional status updates. 05 should reuse the negative authorization cases. 06 may mount or call the API but must preserve opaque sessions, CSRF and not-found scope hiding.

External follow-up: run PostgreSQL migration and RLS tests with separated migration/application roles, then perform an authorized enterprise IdP login/logout/JWKS-rotation exercise. Until then the honest state is CODE_READY, not RLS_VERIFIED or EXTERNAL_IDP_VERIFIED.
