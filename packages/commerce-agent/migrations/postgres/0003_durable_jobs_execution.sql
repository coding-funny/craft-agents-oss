-- Durable jobs and reliable side-effect ledger. PostgreSQL 15+.
-- 03 introduced the governed proposal contract in SQLite. Define its PostgreSQL
-- persistence here before the reliable-execution foreign keys are installed.
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id text PRIMARY KEY,
  report_id text NOT NULL,
  recommendation_id text NOT NULL,
  trace_id text NOT NULL,
  tenant_id text NOT NULL,
  shop_id text NOT NULL,
  requested_by text NOT NULL,
  snapshot_id text NOT NULL,
  review_status text NOT NULL,
  policy_version text NOT NULL,
  target_version integer NOT NULL CHECK (target_version > 0),
  evidence_ids_json jsonb NOT NULL,
  action_type text NOT NULL,
  target_id text NOT NULL,
  params_json jsonb NOT NULL,
  risk_level text NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  expected_impact text NOT NULL,
  rollback_plan text NOT NULL,
  content_hash char(64) NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN (
    'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED',
    'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'MANUAL_REVIEW'
  )),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (report_id, recommendation_id)
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id text PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES proposals(proposal_id),
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  actor text NOT NULL,
  subject text NOT NULL,
  session_id text,
  reason text NOT NULL,
  content_hash char(64) NOT NULL,
  policy_version text NOT NULL,
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES proposals(proposal_id),
  trace_id text NOT NULL,
  actor text NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  details_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS commerce_jobs (
  job_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('INVESTIGATE', 'EXECUTE', 'RECONCILE')),
  tenant_id text NOT NULL,
  shop_id text NOT NULL,
  business_key text NOT NULL,
  payload_json jsonb NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN (
    'READY', 'LEASED', 'RETRY_WAIT', 'WAITING_INPUT',
    'SUCCEEDED', 'FAILED', 'CANCELLED', 'MANUAL_REVIEW'
  )),
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  lease_owner text,
  lease_until timestamptz,
  lease_epoch bigint NOT NULL DEFAULT 0,
  cancel_requested_at timestamptz,
  last_error_json jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (kind, tenant_id, business_key)
);

CREATE INDEX IF NOT EXISTS idx_commerce_jobs_claim
  ON commerce_jobs (status, available_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_commerce_jobs_tenant_lease
  ON commerce_jobs (tenant_id, status, lease_until);

CREATE TABLE IF NOT EXISTS commerce_job_checkpoints (
  job_id text NOT NULL REFERENCES commerce_jobs(job_id),
  checkpoint_key text NOT NULL,
  lease_epoch bigint NOT NULL,
  state_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (job_id, checkpoint_key)
);

CREATE TABLE IF NOT EXISTS commerce_outbox (
  event_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  shop_id text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'LEASED', 'PUBLISHED')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL,
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_commerce_outbox_claim
  ON commerce_outbox (status, available_at, created_at);

CREATE TABLE IF NOT EXISTS commerce_execution_requests (
  request_id text PRIMARY KEY,
  proposal_id text NOT NULL UNIQUE REFERENCES proposals(proposal_id),
  tenant_id text NOT NULL,
  shop_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  payload_hash text NOT NULL,
  request_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN (
    'PREPARED', 'SENT', 'APPLIED', 'REJECTED', 'UNKNOWN', 'MANUAL_REVIEW', 'CANCELLED'
  )),
  external_operation_id text,
  result_json jsonb,
  lookup_attempts integer NOT NULL DEFAULT 0,
  next_lookup_at timestamptz,
  uncertainty_deadline timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_requests_reconcile
  ON commerce_execution_requests (status, next_lookup_at);

ALTER TABLE commerce_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_job_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_job_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_execution_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_execution_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commerce_proposals_scope ON proposals;
CREATE POLICY commerce_proposals_scope ON proposals
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));

DROP POLICY IF EXISTS commerce_approvals_scope ON approvals;
CREATE POLICY commerce_approvals_scope ON approvals
  USING (EXISTS (
    SELECT 1 FROM proposals p WHERE p.proposal_id = approvals.proposal_id
      AND p.tenant_id = current_setting('app.tenant_id', true)
      AND p.shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ','))
  ));

DROP POLICY IF EXISTS commerce_audit_scope ON audit_events;
CREATE POLICY commerce_audit_scope ON audit_events
  USING (EXISTS (
    SELECT 1 FROM proposals p WHERE p.proposal_id = audit_events.proposal_id
      AND p.tenant_id = current_setting('app.tenant_id', true)
      AND p.shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ','))
  ));

DROP POLICY IF EXISTS commerce_jobs_tenant_policy ON commerce_jobs;
CREATE POLICY commerce_jobs_tenant_policy ON commerce_jobs
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));
DROP POLICY IF EXISTS commerce_job_checkpoints_scope ON commerce_job_checkpoints;
CREATE POLICY commerce_job_checkpoints_scope ON commerce_job_checkpoints
  USING (EXISTS (
    SELECT 1 FROM commerce_jobs j WHERE j.job_id = commerce_job_checkpoints.job_id
      AND j.tenant_id = current_setting('app.tenant_id', true)
      AND j.shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ','))
  ));
DROP POLICY IF EXISTS commerce_outbox_tenant_policy ON commerce_outbox;
CREATE POLICY commerce_outbox_tenant_policy ON commerce_outbox
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));
DROP POLICY IF EXISTS commerce_execution_requests_tenant_policy ON commerce_execution_requests;
CREATE POLICY commerce_execution_requests_tenant_policy ON commerce_execution_requests
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));

-- Call in a short transaction. The epoch is the fencing token used by heartbeat
-- and terminal updates. The HTTP/model work starts only after COMMIT.
CREATE OR REPLACE FUNCTION claim_commerce_job(
  p_worker_id text,
  p_kinds text[],
  p_lease_seconds integer,
  p_max_active_per_tenant integer
) RETURNS SETOF commerce_jobs LANGUAGE sql AS $$
  WITH candidate AS (
    SELECT j.job_id
    FROM commerce_jobs j
    WHERE j.kind = ANY(p_kinds)
      AND j.status IN ('READY', 'RETRY_WAIT')
      AND j.available_at <= clock_timestamp()
      AND j.cancel_requested_at IS NULL
      AND (
        SELECT count(*) FROM commerce_jobs active
        WHERE active.tenant_id = j.tenant_id
          AND active.status = 'LEASED'
          AND active.lease_until > clock_timestamp()
      ) < p_max_active_per_tenant
    ORDER BY j.priority DESC, j.available_at, j.created_at, j.job_id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE commerce_jobs j
  SET status = 'LEASED', lease_owner = p_worker_id,
      lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
      lease_epoch = j.lease_epoch + 1, attempts = j.attempts + 1,
      updated_at = clock_timestamp()
  FROM candidate
  WHERE j.job_id = candidate.job_id
  RETURNING j.*;
$$;
