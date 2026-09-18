export type ApiEnvelope<T> = { ok: true; data: T; traceId: string } | { ok: false; error: { code: string; message: string }; traceId: string }

export const COMMERCE_API_BASE = (import.meta.env.VITE_COMMERCE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '/commerce-api'

export class CommerceClient {
  #csrf?: string

  async get<T>(path: string): Promise<T> { return this.#request<T>(path) }
  async post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    if (!this.#csrf) this.#csrf = (await this.get<{ csrfToken: string }>('/api/v1/csrf-token')).csrfToken
    return this.#request<T>(path, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-csrf-token': this.#csrf,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    }, body: JSON.stringify(body) })
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${COMMERCE_API_BASE}${path}`, { ...init, credentials: 'same-origin' })
    const envelope = await response.json() as ApiEnvelope<T>
    if (!response.ok || !envelope.ok) {
      const error = envelope.ok ? `HTTP ${response.status}` : `${envelope.error.code}: ${envelope.error.message}`
      if (response.status === 401) window.location.assign(`${COMMERCE_API_BASE}/api/v1/auth/start`)
      throw new Error(error)
    }
    return envelope.data
  }
}

export const commerceClient = new CommerceClient()
