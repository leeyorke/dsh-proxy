/**
 * Host-side HTTP route for the plugin's own Connection RPC channel
 * (`/dsh-proxy`), owned end to end by this plugin.
 *
 * Why this exists: the channel used to be mounted through
 * `ctx.connection.rpc.handle(...)`. The harness's dedicated-channel path
 * resolves `webServer` through the client-connection plugin's own fiber
 * (a cordis traceable-shadow walk in `HostConnectionService.register`),
 * which worked only while client-connection statically injected
 * `webServer`. Since the harness made `webServer` optional there (the
 * `0.1.6-alpha` line), that walk reaches the root fiber and throws
 * `cannot get property "webServer" without inject` — breaking every
 * external plugin that mounts a dedicated RPC channel. So the plugin owns
 * its physical route instead, registered directly on the injected
 * `ctx.webServer` exactly like the harness's own api-gateway mounts its
 * upgrade route, and applies the same Host/Origin trust fence plus browser
 * authentication through `ctx.connection.requestRejection`.
 *
 * The wire contract is the Connection generic-RPC envelope, unchanged:
 * POST `<channel>/<endpoint>` with a JSON `client-request` body answers a
 * JSON `server-response` envelope (the browser half keeps calling
 * `connection.rpc.call(RPC_CHANNEL, endpoint, payload)`). Keeping the host
 * half here also makes the channel immune to future carrier refactors —
 * the plugin no longer depends on the harness mounting dedicated channels.
 *
 * Pure node:http — no cordis, no harness runtime import — so the whole
 * envelope path is unit-testable against a real listener.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/** Correlation id used when the request body is not a decodable envelope. */
const INVALID_REQUEST_RPC_ID = 'invalid-request'

/** Endpoint segment grammar — identical to the Connection client's `assertTarget`. */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** Default per-request body cap for this channel (settings patches are tiny). */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** Failure shape one endpoint may return (Connection's `ConnectionRpcFailure`). */
export interface ChannelRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Result shape one endpoint returns (Connection's `ConnectionRpcResult`). */
export type ChannelRpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ChannelRpcFailure }

/** Decoded endpoint handler: the plugin's own verbs (status/update/start/stop). */
export type ChannelRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<ChannelRpcResult>

/** Trust fence applied before dispatch; returns the rejection status, or undefined to admit. */
export type ChannelTrustFence = (request: IncomingMessage) => number | undefined

/** Everything the route needs from its host. */
export interface ChannelRouteOptions {
  /** Absolute channel prefix, e.g. `/dsh-proxy`. */
  readonly channel: string
  /** Decoded endpoint handler invoked after the fence and envelope checks pass. */
  readonly handler: ChannelRpcHandler
  /** Host/Origin trust plus browser-authentication fence (Connection's `requestRejection`). */
  readonly fence: ChannelTrustFence
  /** Maximum buffered request body; larger bodies are refused with 413. */
  readonly maxBodyBytes?: number
  /**
   * Sink for fence failures. A fence that throws must never admit the request
   * (fail closed) and never leave it hanging: the route answers 403 and reports
   * here so a harness API rename shows up loudly instead of silently opening
   * the channel or stalling callers.
   */
  readonly onFenceError?: (error: unknown) => void
}

/** Decoded `client-request` envelope. */
interface ChannelClientRequest {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/**
 * Extract the endpoint from a channel pathname, applying the same grammar
 * as the Connection client so both halves agree on what is routable.
 * @param channel - absolute channel prefix.
 * @param pathname - request pathname (no query).
 * @returns the channel-relative endpoint, or undefined when unroutable.
 */
export function channelEndpoint(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

/**
 * Build the physical webServer route for one owned RPC channel.
 * @param options - channel, handler, trust fence, and body cap.
 * @returns a prefix `WebRoute` mounting `<channel>/<endpoint>`.
 */
export function createChannelRoute(options: ChannelRouteOptions): WebRoute {
  const { channel, handler, fence } = options
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  return {
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      // A response whose socket dies mid-write must not surface as an
      // unhandled 'error' event, which would take the whole process down.
      res.on('error', () => {})
      try {
        await dispatch(req, res)
      } catch {
        // Nothing may leave a request hanging: an unexpected failure (e.g. a
        // reset mid-upload) still gets an answer, or the socket is already
        // gone and there is nothing left to answer on.
        if (!res.writableEnded) {
          try {
            res.writeHead(500)
            res.end('internal error')
          } catch {
            // socket already destroyed — nothing to do
          }
        }
      }
    },
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let rejection: number | undefined
    try {
      rejection = fence(req)
    } catch (error) {
      // Fail closed: a fence that cannot run refuses the request instead of
      // admitting it, and reports so the cause is visible in the log.
      options.onFenceError?.(error)
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
    const endpoint = channelEndpoint(channel, pathname)
    if (req.method !== 'POST' || endpoint === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      res.writeHead(415)
      res.end('content type must be application/json')
      return
    }
    const body = await readBody(req, res, maxBodyBytes)
    if (body === undefined) return
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      res.writeHead(400)
      res.end('body is not JSON')
      return
    }
    const message = parseClientRequest(parsed)
    if (message === undefined) {
      respond(res, {
        type: 'server-response',
        rpcId: INVALID_REQUEST_RPC_ID,
        result: {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: 'invalid client-request message',
            details: {},
          },
        },
      })
      return
    }
    if (message.method !== endpoint) {
      respond(res, {
        type: 'server-response',
        rpcId: message.rpcId,
        result: {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: {},
          },
        },
      })
      return
    }
    // Client-disconnect detection hangs off the response, not the request:
    // IncomingMessage 'close' fires as soon as the body is consumed.
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })
    try {
      const result = await handler(endpoint, message.payload, abort.signal)
      respond(res, { type: 'server-response', rpcId: message.rpcId, result })
    } catch (error) {
      res.writeHead(500)
      res.end(`handler failure: ${String(error)}`)
    }
  }
}

/** Narrow a decoded JSON body to a `client-request` envelope. */
function parseClientRequest(value: unknown): ChannelClientRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== 'client-request') return undefined
  const { rpcId, method } = record
  if (typeof rpcId !== 'string' || typeof method !== 'string') return undefined
  // `payload` is optional on the wire: JSON.stringify drops explicit
  // undefined members, and `rpc.call(channel, endpoint, undefined)` sends none.
  return { rpcId, method, payload: record.payload }
}

/** Buffer the request body under the cap; 413 (already answered) on overflow. */
async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBodyBytes: number,
): Promise<Buffer | undefined> {
  const tooLarge = (): undefined => {
    res.writeHead(413, { connection: 'close' })
    res.end()
    req.destroy()
    return undefined
  }
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined && Number(declaredLength) > maxBodyBytes) return tooLarge()
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    received += buffer.byteLength
    if (received > maxBodyBytes) return tooLarge()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Write one JSON envelope response. */
function respond(res: ServerResponse, envelope: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(envelope))
}
