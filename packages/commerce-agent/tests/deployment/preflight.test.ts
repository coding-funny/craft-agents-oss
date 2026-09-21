import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validateDeploymentConfig } from '../../src/config/deployment.ts'

const sandbox = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../deploy/commerce/config/sandbox.json'), 'utf8'))
const env = Object.fromEntries(['COMMERCE_OIDC_ISSUER', 'COMMERCE_OIDC_AUDIENCE', 'COMMERCE_OIDC_CLIENT_ID', 'COMMERCE_OIDC_AUTHORIZATION_ENDPOINT', 'COMMERCE_OIDC_TOKEN_ENDPOINT', 'COMMERCE_OIDC_JWKS_URI'].map(key => [key, 'configured']))

describe('deployment preflight', () => {
  test('accepts a complete sandbox config and reports fake model mode', () => {
    const result = validateDeploymentConfig(sandbox, env).result
    expect(result.decision).toBe('PASS')
    expect(result.warnings).toContain('FAKE_MODEL_MODE')
  })

  test('rejects inline secrets', () => {
    const result = validateDeploymentConfig({ ...sandbox, model: { ...sandbox.model, apiKey: 'do-not-inline' } }, env).result
    expect(result.decision).toBe('FAIL')
  })

  test('blocks pilot while PostgreSQL is not wired into runtime', () => {
    const pilot = { ...sandbox, environment: 'pilot', publicOrigin: 'https://commerce.example.test', allowedOrigins: ['https://commerce.example.test'], database: { kind: 'postgres', urlEnv: 'COMMERCE_DATABASE_URL' }, oidc: { ...sandbox.oidc, callbackUrl: 'https://commerce.example.test/callback' }, model: { mode: 'live', apiKeyEnv: 'COMMERCE_MODEL_API_KEY', maximumDailyCostMicros: 1 }, telemetry: { enabled: true, endpointEnv: 'OTEL_EXPORTER_OTLP_ENDPOINT', logRetentionDays: 30 } }
    const result = validateDeploymentConfig(pilot, { ...env, COMMERCE_DATABASE_URL: 'configured', COMMERCE_MODEL_API_KEY: 'configured', OTEL_EXPORTER_OTLP_ENDPOINT: 'configured' }).result
    expect(result.decision).toBe('BLOCKED')
    expect(result.errors).toContain('PILOT_STORAGE_ADAPTER')
  })
})
