# Reliable action execution boundaries

## Protocol

1. Revalidate the service principal, shop scope, proposal hash, latest approval, approval policy, approver membership/grant, expiry, and target version.
2. In one local transaction, create a stable `requestId`/`idempotencyKey` record in `PREPARED` and move the proposal to `EXECUTING`.
3. Commit, then mark the request `SENT` immediately before the HTTP call.
4. Let the remote platform atomically enforce idempotency-key payload equality and `expectedVersion`.
5. Persist `APPLIED` or `REJECTED`. Any ambiguous post-send failure becomes `UNKNOWN`.
6. Reconcile `UNKNOWN` by `requestId`. Eventual `NOT_FOUND` and `UNAVAILABLE` stay unknown with bounded backoff. Lookup exhaustion becomes `MANUAL_REVIEW`.

## Failure windows

| Window | Recovery rule |
| --- | --- |
| crash after PREPARED, before SENT | safe first send using persisted request |
| crash/error after SENT | lookup first; never infer “not applied” from a missing local response |
| remote commit, response lost | UNKNOWN then lookup APPLIED; no second business effect |
| response received, local commit lost | lookup by requestId/idempotency key |
| eventual lookup returns NOT_FOUND | remain UNKNOWN until visibility window/deadline |
| no remote idempotency and no lookup | immediate MANUAL_REVIEW; no automatic resend |
| stale expectedVersion | remote rejects atomically; no target mutation |

`HttpActionExecutor` performs no automatic write retry. Its base URL is server-side configuration, not a model-controlled URL.
