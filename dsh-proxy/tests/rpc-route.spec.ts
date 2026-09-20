import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { channelEndpoint, createChannelRoute, type ChannelRpcHandler } from '../src/rpc-route.ts'

/**
 * These tests drive the route through a real listener: the channel is the
 * plugin's only mount into the harness web server, and the crash that
 * motivated this module (a dedicated-channel mount failing under a real
 * fiber) was invisible to every fake-ctx harness.
 */
const CHANNEL = '/dsh-proxy'

let server: http.Server | undefined

afterEach(async () => {
  if (server === undefined) return
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = undefined
})

interface World {
  origin: string
  seen: { fenceCalls: number; endpoints: string[]; payloads: unknown[]; fenceErrors: unknown[] }
}

async function mount(
  handler: ChannelRpcHandler,
  fence?: (request: http.IncomingMessage) => number | undefined,
): Promise<World> {
  const seen: World['seen'] = { fenceCalls: 0, endpoints: [], payloads: [], fenceErrors: [] }
  server = http.createServer(createChannelRoute({
    channel: CHANNEL,
    fence: (request) => {
      seen.fenceCalls += 1
      return fence?.(request)
    },
    onFenceError: (error) => seen.fenceErrors.push(error),
    handler: async (endpoint, payload) => {
      seen.endpoints.push(endpoint)
      seen.payloads.push(payload)
      return handler(endpoint, payload, new AbortController().signal)
    },
  }).handler)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server!.address() as AddressInfo
  return { origin: `http://127.0.0.1:${String(port)}`, seen }
}

interface Envelope {
  type: string
  rpcId: string
  result: { ok: boolean; value?: unknown; error?: { code: string; message: string; details: unknown } }
}

const call = async (
  world: World,
  endpoint: string,
  body: unknown,
  init?: { method?: string; contentType?: string | null; raw?: string },
): Promise<{ status: number; text: string; json?: Envelope }> => {
  const headers: Record<string, string> = {}
  if (init?.contentType !== null) headers['content-type'] = init?.contentType ?? 'application/json'
  const response = await fetch(`${world.origin}${CHANNEL}/${endpoint}`, {
    method: init?.method ?? 'POST',
    ...Object.keys(headers).length > 0 ? { headers } : {},
    ...init?.raw === undefined && body !== undefined ? { body: JSON.stringify(body) } : {},
  })
  const text = await response.text()
  try {
    return { status: response.status, text, json: JSON.parse(text) }
  } catch {
    return { status: response.status, text }
  }
}

const request = (rpcId: string, method: string, payload?: unknown): unknown => ({
  type: 'client-request',
  rpcId,
  method,
  ...payload === undefined ? {} : { payload },
})

describe('channelEndpoint', () => {
  it('routes endpoints below the channel, including multi-segment ones', () => {
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxy/status')).toBe('status')
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxy/update')).toBe('update')
    // The Connection grammar allows multi-segment endpoints (e.g. /api/goals/create).
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxy/a/b')).toBe('a/b')
  })

  it('refuses anything outside the channel or malformed', () => {
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxy')).toBeUndefined()
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxy/')).toBeUndefined()
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxy/a//b')).toBeUndefined()
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxy/../api')).toBeUndefined()
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxyx/status')).toBeUndefined()
    expect(channelEndpoint('/dsh-proxy', '/other/status')).toBeUndefined()
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxy/sta tus')).toBeUndefined()
    expect(channelEndpoint('/dsh-proxy', '/dsh-proxy/status?x=1')).toBeUndefined()
  })
})

describe('createChannelRoute', () => {
  it('answers a valid envelope with the handler result', async () => {
    const world = await mount(async (endpoint) => ({ ok: true, value: { endpoint } }))
    const response = await call(world, 'status', request('rpc-1', 'status'))
    expect(response.status).toBe(200)
    expect(response.json).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { endpoint: 'status' } },
    })
    expect(world.seen.endpoints).toEqual(['status'])
    // payload is optional on the wire (JSON.stringify drops explicit undefined)
    expect(world.seen.payloads).toEqual([undefined])
  })

  it('passes the payload through and correlates failures by rpcId', async () => {
    const world = await mount(async (_endpoint, payload) => ({
      ok: true,
      value: payload,
    }))
    const response = await call(world, 'update', request('rpc-2', 'update', { listenPort: 3082 }))
    expect(response.json).toEqual({
      type: 'server-response',
      rpcId: 'rpc-2',
      result: { ok: true, value: { listenPort: 3082 } },
    })
    expect(world.seen.payloads).toEqual([{ listenPort: 3082 }])
  })

  it('applies the trust fence before dispatch', async () => {
    const world = await mount(
      async () => ({ ok: true, value: null }),
      () => 401,
    )
    const response = await call(world, 'status', request('rpc-3', 'status'))
    expect(response.status).toBe(401)
    expect(response.text).toBe('unauthorized')
    expect(world.seen.fenceCalls).toBe(1)
    expect(world.seen.endpoints).toEqual([])
  })

  it('maps a 403 fence rejection to forbidden', async () => {
    const world = await mount(
      async () => ({ ok: true, value: null }),
      () => 403,
    )
    const response = await call(world, 'status', request('rpc-4', 'status'))
    expect(response.status).toBe(403)
    expect(response.text).toBe('forbidden')
  })

  it('fails closed when the fence itself throws (harness API drift)', async () => {
    const world = await mount(
      async () => ({ ok: true, value: null }),
      () => {
        throw new TypeError("Cannot read properties of undefined (reading 'requestRejection')")
      },
    )
    const response = await call(world, 'status', request('rpc-4b', 'status'))
    // The request must be refused, never admitted, and never left hanging.
    expect(response.status).toBe(403)
    expect(response.text).toBe('forbidden')
    expect(world.seen.endpoints).toEqual([])
    expect(world.seen.fenceErrors).toHaveLength(1)
    expect(String(world.seen.fenceErrors[0])).toContain('requestRejection')
  })

  it('refuses non-POST methods with 404', async () => {
    const world = await mount(async () => ({ ok: true, value: null }))
    const response = await call(world, 'status', undefined, { method: 'GET' })
    expect(response.status).toBe(404)
    expect(world.seen.endpoints).toEqual([])
  })

  it('refuses unroutable paths with 404', async () => {
    const world = await mount(async () => ({ ok: true, value: null }))
    const response = await fetch(`${world.origin}${CHANNEL}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request('rpc-5', 'status')),
    })
    expect(response.status).toBe(404)
    expect(world.seen.endpoints).toEqual([])
  })

  it('refuses a non-JSON content type with 415', async () => {
    const world = await mount(async () => ({ ok: true, value: null }))
    const response = await call(world, 'status', undefined, {
      contentType: 'text/plain',
      raw: 'status',
    })
    expect(response.status).toBe(415)
  })

  it('refuses a broken JSON body with 400', async () => {
    const world = await mount(async () => ({ ok: true, value: null }))
    const response = await call(world, 'status', undefined, { raw: '{not json' })
    expect(response.status).toBe(400)
    expect(response.text).toBe('body is not JSON')
  })

  it('answers an invalid envelope with an uncorrelatable failure', async () => {
    const world = await mount(async () => ({ ok: true, value: null }))
    const response = await call(world, 'status', { type: 'nope' })
    expect(response.status).toBe(200)
    expect(response.json).toEqual({
      type: 'server-response',
      rpcId: 'invalid-request',
      result: {
        ok: false,
        error: {
          code: 'gateway/bad-request',
          message: 'invalid client-request message',
          details: {},
        },
      },
    })
    expect(world.seen.endpoints).toEqual([])
  })

  it('refuses a method that disagrees with the endpoint path', async () => {
    const world = await mount(async () => ({ ok: true, value: null }))
    const response = await call(world, 'status', request('rpc-6', 'update'))
    expect(response.status).toBe(200)
    expect(response.json).toMatchObject({
      type: 'server-response',
      rpcId: 'rpc-6',
      result: {
        ok: false,
        error: {
          code: 'gateway/bad-request',
          message: 'method "update" does not match endpoint "status"',
        },
      },
    })
    expect(world.seen.endpoints).toEqual([])
  })

  it('surfaces a handler throw as a 500 without leaking the envelope', async () => {
    const world = await mount(async () => {
      throw new Error('boom')
    })
    const response = await call(world, 'status', request('rpc-7', 'status'))
    expect(response.status).toBe(500)
    expect(response.text).toBe('handler failure: Error: boom')
  })

  it('refuses an oversized body with 413', async () => {
    const world = await mount(async () => ({ ok: true, value: null }))
    // The default cap is 1 MiB; a body past it is refused before dispatch.
    // The refusal destroys the still-streaming request (same as the harness
    // bridge), so a client mid-upload may observe the reset instead of the
    // 413 — either way the handler never runs.
    const big = { blob: 'x'.repeat(1024 * 1024 + 16) }
    let status: number | string
    try {
      const response = await call(world, 'update', request('rpc-8', 'update', big))
      status = response.status
    } catch {
      status = 'reset'
    }
    expect([413, 'reset']).toContain(status)
    expect(world.seen.endpoints).toEqual([])
  })
})
