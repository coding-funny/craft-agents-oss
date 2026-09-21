import { createHash } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { CommerceError } from '../domain/errors.ts'
import type { IdentityRepository } from './repository.ts'
import { opaqueSecret, secretHash, sessionCookie } from './session.ts'

export type OidcConfig = {
  issuer: string
  audience: string
  clientId: string
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  redirectUri: string
  sessionTtlSeconds?: number
  flowTtlSeconds?: number
}

export type OidcCallbackResult = {
  principal: { actorId: string; subject: string; tenantId: string }
  csrfToken: string
  setCookie: string
}

function challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export class OidcService {
  readonly #repository: IdentityRepository
  readonly #config: OidcConfig
  readonly #fetch: typeof fetch
  readonly #now: () => Date

  constructor(options: {
    repository: IdentityRepository; config: OidcConfig; fetchImpl?: typeof fetch; now?: () => Date
  }) {
    this.#repository = options.repository
    this.#config = options.config
    this.#fetch = options.fetchImpl ?? fetch
    this.#now = options.now ?? (() => new Date())
  }

  begin(tenantHint?: string): { authorizationUrl: string } {
    const state = opaqueSecret()
    const nonce = opaqueSecret()
    const codeVerifier = opaqueSecret(48)
    const now = this.#now()
    const expiresAt = new Date(now.getTime() + (this.#config.flowTtlSeconds ?? 300) * 1_000).toISOString()
    this.#repository.createFlow({
      stateHash: secretHash(state), nonceHash: secretHash(nonce), codeVerifier,
      tenantHint, expiresAt, now: now.toISOString(),
    })
    const url = new URL(this.#config.authorizationEndpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.#config.clientId)
    url.searchParams.set('redirect_uri', this.#config.redirectUri)
    url.searchParams.set('scope', 'openid profile')
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', challenge(codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')
    return { authorizationUrl: url.toString() }
  }

  async callback(input: { code: string; state: string }): Promise<OidcCallbackResult> {
    if (!input.code || !input.state) throw new CommerceError('INVALID_ARGUMENT', 'OIDC code and state are required')
    const now = this.#now()
    const flow = this.#repository.consumeFlow(secretHash(input.state), now.toISOString())
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code: input.code, redirect_uri: this.#config.redirectUri,
      client_id: this.#config.clientId, code_verifier: flow.code_verifier,
    })
    const response = await this.#fetch(this.#config.tokenEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    })
    if (!response.ok) throw new CommerceError('SCOPE_DENIED', 'OIDC token exchange failed')
    const tokenResponse = await response.json() as { id_token?: string }
    if (!tokenResponse.id_token) throw new CommerceError('SCOPE_DENIED', 'OIDC response did not contain an ID token')
    let payload
    try {
      payload = (await jwtVerify(
        tokenResponse.id_token,
        createRemoteJWKSet(new URL(this.#config.jwksUri)),
        { issuer: this.#config.issuer, audience: this.#config.audience },
      )).payload
    } catch {
      throw new CommerceError('SCOPE_DENIED', 'OIDC token validation failed')
    }
    if (typeof payload.sub !== 'string' || typeof payload.nonce !== 'string' || secretHash(payload.nonce) !== flow.nonce_hash) {
      throw new CommerceError('SCOPE_DENIED', 'OIDC subject or nonce validation failed')
    }
    const membership = this.#repository.findActiveMembership(payload.sub, flow.tenant_hint ?? undefined)
    const sessionToken = opaqueSecret()
    const csrfToken = opaqueSecret()
    const ttl = this.#config.sessionTtlSeconds ?? 3_600
    const sessionId = this.#repository.createSession({
      tokenHash: secretHash(sessionToken), csrfHash: secretHash(csrfToken), subject: membership.subject,
      tenantId: membership.tenantId, membershipVersion: membership.version,
      expiresAt: new Date(now.getTime() + ttl * 1_000).toISOString(), now: now.toISOString(),
    })
    this.#repository.audit({
      traceId: sessionId, action: 'auth:login', decision: 'ALLOW', reasonCode: 'OIDC_VERIFIED',
      createdAt: now.toISOString(), principal: {
        actorId: membership.actorId, subject: membership.subject, tenantId: membership.tenantId,
      },
    })
    return {
      principal: { actorId: membership.actorId, subject: membership.subject, tenantId: membership.tenantId },
      csrfToken,
      setCookie: sessionCookie(sessionToken, ttl),
    }
  }
}
