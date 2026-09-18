import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { CommerceDatabase } from '../../src/storage/database.ts'
import { IdentityRepository } from '../../src/auth/repository.ts'
import { OidcService } from '../../src/auth/oidc.ts'

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => { for (const server of servers.splice(0)) server.stop(true) })

describe('OIDC authorization code + PKCE', () => {
  it('completes a real loopback HTTP login and rejects state replay', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwk = await exportJWK(publicKey)
    Object.assign(jwk, { kid: 'test-key', alg: 'RS256', use: 'sig' })
    const codes = new Map<string, { nonce: string; challenge: string }>()
    let issuer = ''
    const idp = Bun.serve({ hostname: '127.0.0.1', port: 41_000 + Math.floor(Math.random() * 10_000), async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/authorize') {
        const code = `code-${codes.size + 1}`
        codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')! })
        const redirect = new URL(url.searchParams.get('redirect_uri')!)
        redirect.searchParams.set('code', code)
        redirect.searchParams.set('state', url.searchParams.get('state')!)
        return Response.redirect(redirect.toString())
      }
      if (url.pathname === '/token') {
        const body = new URLSearchParams(await request.text())
        const code = body.get('code')!
        const saved = codes.get(code)
        const actual = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')
        if (!saved || saved.challenge !== actual) return new Response('bad verifier', { status: 400 })
        codes.delete(code)
        const idToken = await new SignJWT({ nonce: saved.nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(issuer).setAudience('commerce-api').setSubject('oidc|approver-1')
          .setIssuedAt().setExpirationTime('5m').sign(privateKey)
        return Response.json({ id_token: idToken })
      }
      if (url.pathname === '/jwks') return Response.json({ keys: [jwk] })
      return new Response('not found', { status: 404 })
    } })
    servers.push(idp)
    issuer = `http://127.0.0.1:${idp.port}`
    const store = new CommerceDatabase(':memory:')
    const identity = new IdentityRepository(store)
    identity.upsertMembership({
      subject: 'oidc|approver-1', actorId: 'approver-1', tenantId: 'tenant-a', roles: ['APPROVER'], now: new Date().toISOString(),
    })
    identity.setShopGrant({ subject: 'oidc|approver-1', tenantId: 'tenant-a', shopId: 'shop-a', now: new Date().toISOString() })
    const oidc = new OidcService({ repository: identity, config: {
      issuer, audience: 'commerce-api', clientId: 'commerce-client',
      authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`,
      redirectUri: 'https://ops.example.test/api/v1/auth/callback',
    } })
    const start = oidc.begin('tenant-a')
    const redirect = await fetch(start.authorizationUrl, { redirect: 'manual' })
    const callback = new URL(redirect.headers.get('location')!)
    const input = { code: callback.searchParams.get('code')!, state: callback.searchParams.get('state')! }
    const result = await oidc.callback(input)
    expect(result.principal).toEqual({ actorId: 'approver-1', subject: 'oidc|approver-1', tenantId: 'tenant-a' })
    expect(result.setCookie).toContain('HttpOnly; Secure; SameSite=Strict')
    await expect(oidc.callback(input)).rejects.toThrow('already consumed')
  })
})
