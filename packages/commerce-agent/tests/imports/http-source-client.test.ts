import { afterEach, describe, expect, it } from 'bun:test'
import { HttpSourceClient } from '../../src/imports/http-source-client.ts'

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe('HttpSourceClient', () => {
  it('retries bounded 429 responses and preserves one snapshot token across pages', async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests += 1
        const cursor = new URL(request.url).searchParams.get('cursor')
        if (requests === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } })
        if (!cursor) return Response.json({ records: [{ id: 1 }], cursor: 'page-2', snapshotToken: 'snapshot-a' })
        return Response.json({ records: [{ id: 2 }], cursor: null, snapshotToken: 'snapshot-a' })
      },
    })
    servers.push(server)
    const delays: number[] = []
    const client = new HttpSourceClient({
      endpoint: new URL('/records', server.url).toString(),
      sleep: async milliseconds => { delays.push(milliseconds) },
    })
    expect(await client.fetchAll()).toEqual({ records: [{ id: 1 }, { id: 2 }], snapshotToken: 'snapshot-a', pages: 2 })
    expect(requests).toBe(3)
    expect(delays).toEqual([0])
  })

  it('rejects snapshot drift and expired cursors instead of mixing pages', async () => {
    const drifting = Bun.serve({
      port: 0,
      fetch(request) {
        const cursor = new URL(request.url).searchParams.get('cursor')
        return cursor
          ? Response.json({ records: [{ id: 2 }], cursor: null, snapshotToken: 'snapshot-b' })
          : Response.json({ records: [{ id: 1 }], cursor: 'next', snapshotToken: 'snapshot-a' })
      },
    })
    servers.push(drifting)
    await expect(new HttpSourceClient({ endpoint: drifting.url.toString() }).fetchAll())
      .rejects.toThrow('changed snapshot token')

    const expired = Bun.serve({ port: 0, fetch: () => new Response('expired', { status: 410 }) })
    servers.push(expired)
    await expect(new HttpSourceClient({ endpoint: expired.url.toString() }).fetchAll())
      .rejects.toThrow('cursor expired')
  })

  it('propagates cancellation without consuming more pages', async () => {
    const controller = new AbortController()
    let requests = 0
    const client = new HttpSourceClient({
      endpoint: 'https://controlled.invalid/records',
      fetch: (async () => {
        requests += 1
        controller.abort(new Error('cancelled by host'))
        return Response.json({ records: [], cursor: 'next', snapshotToken: 'snapshot-a' })
      }) as unknown as typeof fetch,
    })
    await expect(client.fetchAll(controller.signal)).rejects.toThrow('cancelled by host')
    expect(requests).toBe(1)
  })
})
