CREATE TABLE IF NOT EXISTS commerce_memberships (
  subject TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  roles_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (subject, tenant_id)
);

CREATE TABLE IF NOT EXISTS commerce_shop_grants (
  subject TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (subject, tenant_id, shop_id),
  FOREIGN KEY (subject, tenant_id) REFERENCES commerce_memberships (subject, tenant_id)
);

CREATE TABLE IF NOT EXISTS commerce_oidc_flows (
  state_hash CHAR(64) PRIMARY KEY,
  nonce_hash CHAR(64) NOT NULL,
  code_verifier TEXT NOT NULL,
  tenant_hint TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS commerce_sessions (
  session_id TEXT PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  csrf_hash CHAR(64) NOT NULL,
  subject TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  membership_version INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (subject, tenant_id) REFERENCES commerce_memberships (subject, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_sessions_subject
  ON commerce_sessions (subject, tenant_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS commerce_authz_audit (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trace_id TEXT NOT NULL,
  actor_id TEXT,
  subject TEXT,
  tenant_id TEXT,
  shop_id TEXT,
  action TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('ALLOW', 'DENY')),
  reason_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS commerce_request_idempotency (
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_key TEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, actor_id, operation, request_key)
);

ALTER TABLE commerce_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_record_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_record_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_quarantine FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_snapshot_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_snapshot_records FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_report_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_report_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE commerce_shop_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_shop_grants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commerce_scope_imports ON commerce_imports;
CREATE POLICY commerce_scope_imports ON commerce_imports
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));

DROP POLICY IF EXISTS commerce_scope_records ON commerce_record_versions;
CREATE POLICY commerce_scope_records ON commerce_record_versions
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));

DROP POLICY IF EXISTS commerce_scope_quarantine ON commerce_quarantine;
CREATE POLICY commerce_scope_quarantine ON commerce_quarantine
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));

DROP POLICY IF EXISTS commerce_scope_snapshots ON commerce_snapshots;
CREATE POLICY commerce_scope_snapshots ON commerce_snapshots
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));

DROP POLICY IF EXISTS commerce_scope_snapshot_records ON commerce_snapshot_records;
CREATE POLICY commerce_scope_snapshot_records ON commerce_snapshot_records
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));

DROP POLICY IF EXISTS commerce_scope_reviews ON commerce_report_reviews;
CREATE POLICY commerce_scope_reviews ON commerce_report_reviews
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));

DROP POLICY IF EXISTS commerce_own_membership ON commerce_memberships;
CREATE POLICY commerce_own_membership ON commerce_memberships
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND subject = current_setting('app.subject', true));

DROP POLICY IF EXISTS commerce_own_grants ON commerce_shop_grants;
CREATE POLICY commerce_own_grants ON commerce_shop_grants
  USING (tenant_id = current_setting('app.tenant_id', true)
    AND subject = current_setting('app.subject', true)
    AND shop_id = ANY (string_to_array(current_setting('app.shop_ids', true), ',')));
