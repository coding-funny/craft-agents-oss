-- Operations workbench, deterministic monitor, feedback, and reviewed memory. PostgreSQL 15+.
CREATE TABLE IF NOT EXISTS commerce_detected_cases (
  case_id text PRIMARY KEY, tenant_id text NOT NULL, shop_id text NOT NULL,
  entity_type text NOT NULL, entity_id text NOT NULL, anomaly_type text NOT NULL,
  rule_version text NOT NULL, severity text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  status text NOT NULL CHECK (status IN ('OPEN','INVESTIGATING','RESOLVED','DEFERRED')),
  task_id text, first_window_start timestamptz NOT NULL, latest_window_end timestamptz NOT NULL,
  cooldown_until timestamptz NOT NULL, notification_count integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_detected_cases_scope ON commerce_detected_cases
  (tenant_id, shop_id, anomaly_type, entity_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS commerce_case_observations (
  observation_id text PRIMARY KEY, case_id text NOT NULL REFERENCES commerce_detected_cases(case_id),
  tenant_id text NOT NULL, shop_id text NOT NULL, snapshot_id text NOT NULL,
  window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
  severity text NOT NULL, reason text NOT NULL, metrics_json jsonb NOT NULL,
  created_at timestamptz NOT NULL, UNIQUE(case_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS commerce_feedback (
  feedback_id text PRIMARY KEY, tenant_id text NOT NULL, shop_id text NOT NULL,
  task_id text NOT NULL, report_id text NOT NULL, report_version char(64) NOT NULL,
  claim_id text, evidence_id text, kind text NOT NULL, notes text NOT NULL,
  actor_id text NOT NULL, actor_role text NOT NULL, idempotency_key text NOT NULL,
  payload_hash char(64) NOT NULL, created_at timestamptz NOT NULL,
  UNIQUE(tenant_id, actor_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_feedback_scope ON commerce_feedback (tenant_id, shop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_eval_candidates (
  candidate_id text PRIMARY KEY, feedback_id text NOT NULL UNIQUE REFERENCES commerce_feedback(feedback_id),
  tenant_id text NOT NULL, shop_id text NOT NULL, source_task_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_REVIEW','ACCEPTED_DEV','REJECTED')),
  sanitized_payload_json jsonb NOT NULL, created_at timestamptz NOT NULL, reviewed_at timestamptz
);

CREATE TABLE IF NOT EXISTS commerce_case_memory (
  memory_id text PRIMARY KEY, tenant_id text NOT NULL, shop_id text NOT NULL,
  entity_type text NOT NULL, entity_id text NOT NULL, anomaly_type text NOT NULL,
  outcome text NOT NULL, report_id text NOT NULL, evidence_ids_json jsonb NOT NULL,
  reviewed_by text NOT NULL, reviewed_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_memory_scope ON commerce_case_memory
  (tenant_id, shop_id, anomaly_type, entity_id, reviewed_at DESC);

ALTER TABLE commerce_detected_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_detected_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_case_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_case_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_eval_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_eval_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_case_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_case_memory FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operations_case_scope ON commerce_detected_cases;
CREATE POLICY operations_case_scope ON commerce_detected_cases USING (
  tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),','))
) WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),',')));
DROP POLICY IF EXISTS operations_observation_scope ON commerce_case_observations;
CREATE POLICY operations_observation_scope ON commerce_case_observations USING (
  tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),','))
) WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),',')));
DROP POLICY IF EXISTS operations_feedback_scope ON commerce_feedback;
CREATE POLICY operations_feedback_scope ON commerce_feedback USING (
  tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),','))
) WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),',')));
DROP POLICY IF EXISTS operations_candidate_scope ON commerce_eval_candidates;
CREATE POLICY operations_candidate_scope ON commerce_eval_candidates USING (
  tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),','))
) WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),',')));
DROP POLICY IF EXISTS operations_memory_scope ON commerce_case_memory;
CREATE POLICY operations_memory_scope ON commerce_case_memory USING (
  tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),','))
) WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND shop_id=ANY(string_to_array(current_setting('app.shop_ids',true),',')));
