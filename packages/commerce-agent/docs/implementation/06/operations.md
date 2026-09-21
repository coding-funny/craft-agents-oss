# Operations contract

- UI route: `/commerce`
- Browser proxy prefix: `/commerce-api`; Commerce service API prefix after rewrite: `/api/v1`.
- Poll interval: 3 seconds for a selected task, 10 seconds for the scoped list.
- Write authentication: HttpOnly session plus rotated CSRF header and allowlisted Origin.
- Browser OIDC callback redirects back to `/commerce`; JSON clients retain the structured callback response.
- Monitor outcomes: `CREATED`, `MERGED`, `DUPLICATE`, `ESCALATED`, `QUOTA_SUPPRESSED`.
- Feedback candidates: only incorrect conclusion, missing data, and correction enter `PENDING_REVIEW`.
- Frozen holdout data is never modified by this workflow.

Rollback is route-local: disabling `/commerce` leaves the authenticated API and CLI available. Disabling monitor invocation leaves persisted cases intact. A rule rollback must change `ruleVersion` rather than rewriting observations.
