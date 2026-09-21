CREATE TABLE IF NOT EXISTS commerce_imports (
  import_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('AUTHORIZED_EXPORT', 'SYNTHETIC_FIXTURE', 'HTTP_TEST_SOURCE')),
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'VALIDATING', 'APPLIED', 'PARTIAL', 'REJECTED', 'ROLLED_BACK')),
  manifest_hash CHAR(64) NOT NULL,
  manifest_json JSONB NOT NULL,
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (import_id, tenant_id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_imports_scope
  ON commerce_imports (tenant_id, shop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_record_versions (
  record_version_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sales', 'inventory', 'promotions', 'products', 'ads')),
  source_record_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('AUTHORIZED_EXPORT', 'SYNTHETIC_FIXTURE', 'HTTP_TEST_SOURCE')),
  source_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_hash CHAR(64) NOT NULL,
  business_time TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL,
  import_id TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, shop_id, kind, source_id, source_record_id, version),
  UNIQUE (tenant_id, shop_id, kind, source_id, source_record_id, content_hash),
  UNIQUE (record_version_id, tenant_id, shop_id),
  FOREIGN KEY (import_id, tenant_id, shop_id)
    REFERENCES commerce_imports (import_id, tenant_id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_records_scope_kind_time
  ON commerce_record_versions (tenant_id, shop_id, kind, source_id, business_time DESC);

CREATE TABLE IF NOT EXISTS commerce_quarantine (
  quarantine_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  raw_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (import_id, kind, row_number),
  FOREIGN KEY (import_id, tenant_id, shop_id)
    REFERENCES commerce_imports (import_id, tenant_id, shop_id)
);

CREATE TABLE IF NOT EXISTS commerce_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  import_id TEXT NOT NULL UNIQUE,
  as_of TIMESTAMPTZ NOT NULL,
  snapshot_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (snapshot_id, tenant_id, shop_id),
  FOREIGN KEY (import_id, tenant_id, shop_id)
    REFERENCES commerce_imports (import_id, tenant_id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_snapshots_scope_asof
  ON commerce_snapshots (tenant_id, shop_id, as_of DESC);

CREATE TABLE IF NOT EXISTS commerce_snapshot_records (
  snapshot_id TEXT NOT NULL,
  record_version_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, record_version_id),
  FOREIGN KEY (snapshot_id, tenant_id, shop_id)
    REFERENCES commerce_snapshots (snapshot_id, tenant_id, shop_id),
  FOREIGN KEY (record_version_id, tenant_id, shop_id)
    REFERENCES commerce_record_versions (record_version_id, tenant_id, shop_id)
);

CREATE TABLE IF NOT EXISTS commerce_report_reviews (
  review_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('REVIEWED', 'PENDING_REVIEW')),
  reviews_json JSONB NOT NULL,
  reviewer_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (snapshot_id, tenant_id, shop_id)
    REFERENCES commerce_snapshots (snapshot_id, tenant_id, shop_id)
);
