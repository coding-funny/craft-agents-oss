import type { ActionExecutor, ActionOutcome, ActionRequest, ExecutorCapabilities, LookupOutcome } from './action-executor.ts'

async function parseOutcome(response: Response): Promise<ActionOutcome> {
  const body = await response.json() as ActionOutcome
  if (!['APPLIED', 'REJECTED', 'PENDING'].includes(body.status)) throw new Error('Platform returned an invalid action status')
  return body
}

export class HttpActionExecutor implements ActionExecutor {
  readonly #baseUrl: URL
  readonly #capabilities: ExecutorCapabilities
  readonly #fetch: typeof fetch

  constructor(options: { baseUrl: string; capabilities: ExecutorCapabilities; fetchImpl?: typeof fetch }) {
    this.#baseUrl = new URL(options.baseUrl)
    this.#capabilities = options.capabilities
    this.#fetch = options.fetchImpl ?? fetch
  }

  capabilities(): ExecutorCapabilities { return { ...this.#capabilities } }

  async execute(request: ActionRequest, signal?: AbortSignal): Promise<ActionOutcome> {
    const response = await this.#fetch(new URL('/operations', this.#baseUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal,
    })
    if (response.status === 409 || response.status === 422) return parseOutcome(response)
    if (!response.ok) throw new Error(`Platform write failed with HTTP ${response.status}`)
    return parseOutcome(response)
  }

  async lookup(requestId: string, signal?: AbortSignal): Promise<LookupOutcome> {
    if (this.#capabilities.lookup === 'UNAVAILABLE') return { status: 'UNAVAILABLE', reason: 'Executor does not support lookup' }
    let response: Response
    try {
      response = await this.#fetch(new URL(`/operations/${encodeURIComponent(requestId)}`, this.#baseUrl), { signal })
    } catch (error) {
      return { status: 'UNAVAILABLE', reason: error instanceof Error ? error.message : String(error) }
    }
    if (response.status === 404) return { status: 'NOT_FOUND' }
    if (!response.ok) return { status: 'UNAVAILABLE', reason: `Platform lookup failed with HTTP ${response.status}` }
    return response.json() as Promise<LookupOutcome>
  }
}
