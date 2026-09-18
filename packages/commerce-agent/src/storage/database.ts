import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import type { EvidenceRecord } from '../domain/contracts.ts'
import type { DiagnosisReport } from '../reports/schema.ts'

type JsonRow = { json: string }

function ensureColumn(database: Database, table: string, column: string, definition: string): void {
  const columns = database.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
  if (!columns.some(item => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

export class CommerceDatabase {
  readonly database: Database

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.database = new Database(path)
    this.database.exec('PRAGMA busy_timeout = 5000;')
    this.database.exec('PRAGMA journal_mode = WAL;')
    this.database.exec('PRAGMA foreign_keys = ON;')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        report_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        proposal_id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        recommendation_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        params_json TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        expected_impact TEXT NOT NULL,
        rollback_plan TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(report_id, recommendation_id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES proposals(proposal_id)
      );
      CREATE TABLE IF NOT EXISTS execution_attempts (
        attempt_id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        external_operation_id TEXT,
        before_json TEXT,
        after_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES proposals(proposal_id)
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        event_type TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mock_state (
        state_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mock_operations (
        operation_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        action_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS case_runs (
        session_id TEXT PRIMARY KEY,
        case_name TEXT NOT NULL,
        state TEXT NOT NULL,
        report_id TEXT,
        proposal_id TEXT,
        trace_id TEXT NOT NULL,
        parent_trace_id TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS case_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        parent_trace_id TEXT,
        event_type TEXT NOT NULL,
        state TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES case_runs(session_id)
      );
      CREATE TABLE IF NOT EXISTS investigation_tasks (
        task_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        tenant_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        input_json TEXT NOT NULL,
        resolved_scope_json TEXT,
        as_of TEXT NOT NULL,
        fixture_digest TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        parent_run_id TEXT,
        trace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        report_id TEXT,
        clarification_json TEXT,
        error_json TEXT,
        completion_reason TEXT,
        manifest_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, attempt),
        FOREIGN KEY(task_id) REFERENCES investigation_tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS investigation_task_versions (
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        resolved_scope_json TEXT,
        as_of TEXT NOT NULL,
        fixture_digest TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, version),
        FOREIGN KEY(task_id) REFERENCES investigation_tasks(task_id)
      );
      CREATE TABLE IF NOT EXISTS investigation_run_versions (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_version INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES investigation_runs(run_id),
        FOREIGN KEY(task_id, task_version) REFERENCES investigation_task_versions(task_id, version)
      );
      CREATE TABLE IF NOT EXISTS investigation_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, sequence),
        FOREIGN KEY(run_id) REFERENCES investigation_runs(run_id)
      );
      CREATE TABLE IF NOT EXISTS investigation_checkpoints (
        run_id TEXT NOT NULL,
        checkpoint_no INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, checkpoint_no),
        FOREIGN KEY(run_id) REFERENCES investigation_runs(run_id)
      );
      CREATE TABLE IF NOT EXISTS commerce_schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commerce_imports (
        import_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL,
        manifest_hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(import_id, tenant_id, shop_id)
      );
      CREATE INDEX IF NOT EXISTS idx_commerce_imports_scope
        ON commerce_imports(tenant_id, shop_id, created_at);
      CREATE TABLE IF NOT EXISTS commerce_record_versions (
        record_version_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        business_time TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        import_id TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        UNIQUE(tenant_id, shop_id, kind, source_id, source_record_id, version),
        UNIQUE(tenant_id, shop_id, kind, source_id, source_record_id, content_hash),
        UNIQUE(record_version_id, tenant_id, shop_id),
        FOREIGN KEY(import_id, tenant_id, shop_id)
          REFERENCES commerce_imports(import_id, tenant_id, shop_id)
      );
      CREATE INDEX IF NOT EXISTS idx_commerce_records_scope_kind_time
        ON commerce_record_versions(tenant_id, shop_id, kind, source_id, business_time);
      CREATE TABLE IF NOT EXISTS commerce_quarantine (
        quarantine_id TEXT PRIMARY KEY,
        import_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        row_number INTEGER NOT NULL,
        code TEXT NOT NULL,
        message TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(import_id, kind, row_number),
        FOREIGN KEY(import_id, tenant_id, shop_id)
          REFERENCES commerce_imports(import_id, tenant_id, shop_id)
      );
      CREATE TABLE IF NOT EXISTS commerce_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        import_id TEXT NOT NULL,
        as_of TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(snapshot_id, tenant_id, shop_id),
        UNIQUE(import_id),
        FOREIGN KEY(import_id, tenant_id, shop_id)
          REFERENCES commerce_imports(import_id, tenant_id, shop_id)
      );
      CREATE INDEX IF NOT EXISTS idx_commerce_snapshots_scope_asof
        ON commerce_snapshots(tenant_id, shop_id, as_of DESC);
      CREATE TABLE IF NOT EXISTS commerce_snapshot_records (
        snapshot_id TEXT NOT NULL,
        record_version_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, record_version_id),
        FOREIGN KEY(snapshot_id, tenant_id, shop_id)
          REFERENCES commerce_snapshots(snapshot_id, tenant_id, shop_id),
        FOREIGN KEY(record_version_id, tenant_id, shop_id)
          REFERENCES commerce_record_versions(record_version_id, tenant_id, shop_id)
      );
      CREATE TABLE IF NOT EXISTS commerce_report_reviews (
        review_id TEXT PRIMARY KEY,
        report_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reviews_json TEXT NOT NULL,
        reviewer_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(snapshot_id, tenant_id, shop_id)
          REFERENCES commerce_snapshots(snapshot_id, tenant_id, shop_id)
      );
      CREATE TABLE IF NOT EXISTS commerce_memberships (
        subject TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(subject, tenant_id)
      );
      CREATE TABLE IF NOT EXISTS commerce_shop_grants (
        subject TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(subject, tenant_id, shop_id),
        FOREIGN KEY(subject, tenant_id) REFERENCES commerce_memberships(subject, tenant_id)
      );
      CREATE TABLE IF NOT EXISTS commerce_oidc_flows (
        state_hash TEXT PRIMARY KEY,
        nonce_hash TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        tenant_hint TEXT,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commerce_sessions (
        session_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        subject TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        membership_version INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(subject, tenant_id) REFERENCES commerce_memberships(subject, tenant_id)
      );
      CREATE INDEX IF NOT EXISTS idx_commerce_sessions_subject
        ON commerce_sessions(subject, tenant_id, expires_at);
      CREATE TABLE IF NOT EXISTS commerce_authz_audit (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        actor_id TEXT,
        subject TEXT,
        tenant_id TEXT,
        shop_id TEXT,
        action TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commerce_request_idempotency (
        tenant_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, actor_id, operation, request_key)
      );
    `)
    ensureColumn(this.database, 'reports', 'tenant_id', 'TEXT')
    ensureColumn(this.database, 'reports', 'shop_id', 'TEXT')
    ensureColumn(this.database, 'reports', 'snapshot_id', 'TEXT')
    ensureColumn(this.database, 'proposals', 'tenant_id', "TEXT NOT NULL DEFAULT 'local-tenant'")
    ensureColumn(this.database, 'proposals', 'shop_id', "TEXT NOT NULL DEFAULT 'demo-shop'")
    ensureColumn(this.database, 'proposals', 'requested_by', "TEXT NOT NULL DEFAULT 'local-agent'")
    ensureColumn(this.database, 'proposals', 'snapshot_id', "TEXT NOT NULL DEFAULT 'LEGACY_DEMO'")
    ensureColumn(this.database, 'proposals', 'review_status', "TEXT NOT NULL DEFAULT 'LEGACY_DEMO'")
    ensureColumn(this.database, 'proposals', 'policy_version', "TEXT NOT NULL DEFAULT 'approval-policy-v1'")
    ensureColumn(this.database, 'proposals', 'target_version', 'INTEGER NOT NULL DEFAULT 1')
    ensureColumn(this.database, 'approvals', 'subject', "TEXT NOT NULL DEFAULT 'local-subject'")
    ensureColumn(this.database, 'approvals', 'session_id', 'TEXT')
    ensureColumn(this.database, 'approvals', 'policy_version', "TEXT NOT NULL DEFAULT 'approval-policy-v1'")
    ensureColumn(this.database, 'approvals', 'reason_code', "TEXT NOT NULL DEFAULT 'ALLOW_LEGACY_TEST'")
  }

  saveEvidence(record: EvidenceRecord): void {
    this.database.query(`
      INSERT INTO evidence (evidence_id, json, created_at) VALUES (?1, ?2, ?3)
      ON CONFLICT(evidence_id) DO NOTHING
    `).run(record.evidenceId, JSON.stringify(record), record.createdAt)
  }

  getEvidence(evidenceId: string): EvidenceRecord | undefined {
    const row = this.database.query<JsonRow, [string]>('SELECT json FROM evidence WHERE evidence_id = ?1').get(evidenceId)
    return row ? JSON.parse(row.json) as EvidenceRecord : undefined
  }

  saveReport(report: DiagnosisReport, contentHash: string): void {
    this.database.query(`
      INSERT INTO reports (report_id, case_id, trace_id, content_hash, json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(report_id) DO UPDATE SET json = excluded.json, content_hash = excluded.content_hash
    `).run(report.reportId, report.caseId, report.traceId, contentHash, JSON.stringify(report), report.generatedAt)
  }

  getReport(reportId: string): { report: DiagnosisReport; contentHash: string } | undefined {
    const row = this.database.query<{ json: string; content_hash: string }, [string]>(
      'SELECT json, content_hash FROM reports WHERE report_id = ?1',
    ).get(reportId)
    return row ? { report: JSON.parse(row.json) as DiagnosisReport, contentHash: row.content_hash } : undefined
  }

  close(): void {
    this.database.close()
  }
}
