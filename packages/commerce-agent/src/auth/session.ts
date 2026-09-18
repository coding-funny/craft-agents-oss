import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { CommerceError } from '../domain/errors.ts'
import type { IdentityRepository } from './repository.ts'

export const SESSION_COOKIE = '__Host-commerce_session'

export function opaqueSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function secretsMatch(rawValue: string, expectedHash: string): boolean {
  const actual = Buffer.from(secretHash(rawValue))
  const expected = Buffer.from(expectedHash)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`
}

export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

export function cookieValue(header: string | null, name: string): string | undefined {
  return header?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1)
}

export function authenticateSession(repository: IdentityRepository, request: Request, now: string) {
  const token = cookieValue(request.headers.get('cookie'), SESSION_COOKIE)
  if (!token) throw new CommerceError('SCOPE_DENIED', 'Authentication is required')
  return { token, ...repository.resolveSession(secretHash(token), now) }
}

export function assertCsrf(request: Request, csrfHash: string, allowedOrigins: readonly string[]): void {
  const origin = request.headers.get('origin')
  if (!origin || !allowedOrigins.includes(origin)) throw new CommerceError('SCOPE_DENIED', 'Origin is not allowed')
  const token = request.headers.get('x-csrf-token')
  if (!token || !secretsMatch(token, csrfHash)) throw new CommerceError('SCOPE_DENIED', 'CSRF validation failed')
}
