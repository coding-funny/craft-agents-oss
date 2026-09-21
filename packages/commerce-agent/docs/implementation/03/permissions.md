# Commerce role and permission matrix

| Role | Granted capabilities | Deliberate exclusions |
| --- | --- | --- |
| OPERATOR | create/read task; read evidence/report/proposal; create proposal | approve, reject, execute, manage access |
| APPROVER | read scoped artifacts; approve/reject proposal; read audit | create task/proposal, execute, manage access |
| ADMIN | read scoped artifacts/audit; manage access | approve/reject and execute are not implicit |
| EXECUTOR | read proposal/audit; execute | human approval and access management |
| AUDITOR | read scoped artifacts and audit | all writes |

Every principal is tenant-bound and carries an explicit shop grant list. Roles are expanded by server code; token/body/header claims cannot add permissions. Approval additionally checks scope, separation of duties, exact content hash, expiration, policy version, target version, review status and action limit. Execution requires `service-identity` plus `proposal:execute` and can recheck the original approver through `IdentityRepository.assertApprovalStillAuthorized`.
