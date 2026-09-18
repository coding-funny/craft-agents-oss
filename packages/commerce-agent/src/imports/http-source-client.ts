import { z } from 'zod'
import { CommerceError } from '../domain/errors.ts'

const HttpPageSchema = z.object({
  records: z.array(z.unknown()),
  cursor: z.string().min(1).nullable().optional(),
  snapshotToken: z.string().min(1),
}).strict()

export type HttpSourcePage = z.infer<typeof HttpPageSchema>

type FetchLike = typeof fetch

export class HttpSourceClient {
  readonly #endpoint: URL
  readonly #fetch: FetchLike
  readonly #maxRetries: number
  readonly #maxPages: number
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>

  constructor(options: {
    endpoint: string
    fetch?: FetchLike
    maxRetries?: number
    maxPages?: number
    sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  }) {
    this.#endpoint = new URL(options.endpoint)
    if (!['http:', 'https:'].includes(this.#endpoint.protocol)) {
      throw new CommerceError('INVALID_ARGUMENT', 'HTTP source endpoint must use http or https')
    }
    this.#fetch = options.fetch ?? fetch
    this.#maxRetries = options.maxRetries ?? 3
    this.#maxPages = options.maxPages ?? 100
    this.#sleep = options.sleep ?? ((milliseconds, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    }))
  }

  async fetchAll(signal?: AbortSignal): Promise<{ records: unknown[]; snapshotToken: string; pages: number }> {
    const records: unknown[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    let snapshotToken: string | undefined
    for (let pageNumber = 1; pageNumber <= this.#maxPages; pageNumber += 1) {
      signal?.throwIfAborted()
      const page = await this.#fetchPage(cursor, signal)
      if (snapshotToken && page.snapshotToken !== snapshotToken) {
        throw new CommerceError('INVALID_ARGUMENT', 'HTTP source changed snapshot token during pagination')
      }
      snapshotToken ??= page.snapshotToken
      records.push(...page.records)
      if (!page.cursor) return { records, snapshotToken, pages: pageNumber }
      if (seenCursors.has(page.cursor)) {
        throw new CommerceError('INVALID_ARGUMENT', 'HTTP source returned a cursor cycle')
      }
      seenCursors.add(page.cursor)
      cursor = page.cursor
    }
    throw new CommerceError('INVALID_ARGUMENT', `HTTP source exceeded ${this.#maxPages} pages`)
  }

  async #fetchPage(cursor: string | undefined, signal?: AbortSignal): Promise<HttpSourcePage> {
    const url = new URL(this.#endpoint)
    if (cursor) url.searchParams.set('cursor', cursor)
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      signal?.throwIfAborted()
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
        redirect: 'error',
      }).catch(error => {
        if (signal?.aborted) throw signal.reason ?? error
        throw new CommerceError('PROVIDER_UNAVAILABLE', 'HTTP source request failed', {
          cause: error instanceof Error ? error.message : String(error),
        })
      })
      if (response.status === 410) {
        throw new CommerceError('INVALID_ARGUMENT', 'HTTP source cursor expired; the import must restart from a bound snapshot')
      }
      if (response.status === 429) {
        if (attempt === this.#maxRetries) {
          throw new CommerceError('RATE_LIMITED', 'HTTP source retry budget exhausted')
        }
        const retryAfterSeconds = Number(response.headers.get('retry-after') ?? '0')
        const milliseconds = Number.isFinite(retryAfterSeconds)
          ? Math.min(Math.max(retryAfterSeconds * 1000, 0), 30_000)
          : 0
        await this.#sleep(milliseconds, signal)
        continue
      }
      if (!response.ok) {
        throw new CommerceError('PROVIDER_UNAVAILABLE', `HTTP source returned status ${response.status}`)
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new CommerceError('INVALID_ARGUMENT', 'HTTP source returned invalid JSON')
      }
      return HttpPageSchema.parse(body)
    }
    throw new CommerceError('INTERNAL', 'Unreachable HTTP source retry state')
  }
}
