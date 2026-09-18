import { z } from 'zod'

export const DeploymentConfigSchema = z.object({
  schemaVersion: z.literal(1),
  environment: z.enum(['fixture', 'sandbox', 'pilot']),
  publicOrigin: z.string().url(),
  bindHost: z.string().min(1),
  apiPort: z.number().int().min(1).max(65_535),
  allowedOrigins: z.array(z.string().url()).min(1),
  database: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('sqlite'), path: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('postgres'), urlEnv: z.string().regex(/^[A-Z][A-Z0-9_]+$/) }).strict(),
  ]),
  oidc: z.object({ issuerEnv: z.string(), audienceEnv: z.string(), clientIdEnv: z.string(), authorizationEndpointEnv: z.string(), tokenEndpointEnv: z.string(), jwksUriEnv: z.string(), callbackUrl: z.string().url() }).strict(),
  model: z.object({ mode: z.enum(['fake', 'live']), apiKeyEnv: z.string().optional(), maximumDailyCostMicros: z.number().int().positive() }).strict(),
  actions: z.object({ mode: z.enum(['disabled', 'test-platform', 'remote']), enabled: z.boolean(), credentialEnv: z.string().optional() }).strict(),
  workers: z.object({ requiredKinds: z.array(z.enum(['INVESTIGATE', 'EXECUTE', 'RECONCILE'])), heartbeatStaleMs: z.number().int().min(1_000) }).strict(),
  telemetry: z.object({ enabled: z.boolean(), endpointEnv: z.string().optional(), logRetentionDays: z.number().int().min(1).max(365) }).strict(),
  backup: z.object({ directory: z.string().min(1), rpoHours: z.number().positive().max(168) }).strict(),
}).strict()

export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>

export type PreflightResult = { decision: 'PASS' | 'BLOCKED' | 'FAIL'; errors: string[]; warnings: string[]; checks: Array<{ id: string; passed: boolean; detail: string }> }
export const IMPLEMENTED_RUNTIME_ADAPTERS = ['sqlite'] as const

const forbiddenKey = /(password|secret|token|api.?key|credential)$/i

export function validateDeploymentConfig(value: unknown, environment: NodeJS.ProcessEnv = process.env): { config?: DeploymentConfig; result: PreflightResult } {
  const parsed = DeploymentConfigSchema.safeParse(value)
  if (!parsed.success) return { result: { decision: 'FAIL', errors: ['CONFIG_SCHEMA_INVALID'], warnings: [], checks: [{ id: 'schema', passed: false, detail: 'Configuration does not match schema' }] } }
  const config = parsed.data
  const errors: string[] = []; const warnings: string[] = []; const checks: PreflightResult['checks'] = []
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); if (!passed) errors.push(id) }
  const serialized = JSON.stringify(value)
  const secretKeys: string[] = []
  const visit = (item: unknown, path = ''): void => { if (!item || typeof item !== 'object') return; for (const [key, child] of Object.entries(item as Record<string, unknown>)) { const next = path ? `${path}.${key}` : key; if (forbiddenKey.test(key) && typeof child === 'string' && !key.endsWith('Env')) secretKeys.push(next); visit(child, next) } }
  visit(value)
  check('NO_INLINE_SECRETS', secretKeys.length === 0 && !/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(serialized), 'Secrets must be referenced by environment variable name')
  const requiredEnv = [config.oidc.issuerEnv, config.oidc.audienceEnv, config.oidc.clientIdEnv, config.oidc.authorizationEndpointEnv, config.oidc.tokenEndpointEnv, config.oidc.jwksUriEnv,
    ...(config.database.kind === 'postgres' ? [config.database.urlEnv] : []),
    ...(config.model.mode === 'live' && config.model.apiKeyEnv ? [config.model.apiKeyEnv] : []),
    ...(config.actions.mode === 'remote' && config.actions.credentialEnv ? [config.actions.credentialEnv] : []),
    ...(config.telemetry.enabled && config.telemetry.endpointEnv ? [config.telemetry.endpointEnv] : [])]
  const missing = requiredEnv.filter(name => !name || !environment[name])
  check('REQUIRED_ENV_PRESENT', missing.length === 0, missing.length ? `Missing environment references: ${missing.join(', ')}` : 'All environment references are present')
  check('ORIGIN_ALLOWLIST', config.allowedOrigins.includes(config.publicOrigin), 'Public origin must be explicitly allowlisted')
  if (config.environment === 'pilot') {
    check('PILOT_HTTPS', config.publicOrigin.startsWith('https://') && config.oidc.callbackUrl.startsWith('https://'), 'Pilot requires HTTPS origins and callback')
    check('PILOT_POSTGRES', config.database.kind === 'postgres', 'Pilot requires PostgreSQL runtime storage')
    check('PILOT_STORAGE_ADAPTER', (IMPLEMENTED_RUNTIME_ADAPTERS as readonly string[]).includes(config.database.kind), 'Selected database must be wired into the API and worker runtime')
    check('PILOT_LIVE_MODEL', config.model.mode === 'live', 'Pilot requires explicit live model configuration')
    check('PILOT_TELEMETRY', config.telemetry.enabled, 'Pilot requires telemetry')
    check('PILOT_TELEMETRY_ADAPTER', false, 'Pilot requires an exercised OTLP exporter and alert route; endpoint configuration alone is insufficient')
    check('PILOT_LOOPBACK_BIND', !['0.0.0.0', '::'].includes(config.bindHost), 'Direct API bind must remain private behind the TLS proxy')
  } else if (!['127.0.0.1', 'localhost', '::1'].includes(config.bindHost)) warnings.push('NON_PILOT_NON_LOOPBACK_BIND')
  check('REMOTE_ACTION_GUARD', config.actions.mode !== 'remote' || (config.actions.enabled && Boolean(config.actions.credentialEnv)), 'Remote actions require explicit enablement and credential reference')
  if (config.model.mode === 'fake') warnings.push('FAKE_MODEL_MODE')
  const blockers = errors.filter(code => code.startsWith('PILOT_') || code === 'REQUIRED_ENV_PRESENT')
  return { config, result: { decision: errors.length === 0 ? 'PASS' : blockers.length > 0 ? 'BLOCKED' : 'FAIL', errors, warnings, checks } }
}
