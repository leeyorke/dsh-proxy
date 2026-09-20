/**
 * The LAN reverse proxy core: an HTTP + WebSocket reverse proxy that forwards
 * to the local DSH service (127.0.0.1:<upstreamPort>) and gates every request
 * behind HTTP Basic Auth — the browser's NATIVE credential dialog, exactly
 * like the standalone dsh-proxy. No custom login page, no session cookies:
 * after a successful Basic login the browser caches the credentials for the
 * origin and sends them on every request (including WebSocket handshakes).
 * Pure node — no cordis; the plugin entry in index.ts wires it into the
 * harness lifecycle.
 *
 * Three compatibility fixes make the proxied LAN surface work exactly like
 * loopback access:
 * - `changeOrigin` rewrites Host to the upstream loopback authority, so the
 *   DSH `/api` browser-trust fence sees a loopback Host.
 * - The browser's Origin is aligned to the same upstream authority (the fence
 *   requires Origin to equal the Host it sees), which also covers WebSocket
 *   upgrades.
 * - The `crypto.randomUUID` polyfill is injected into every proxied HTML
 *   document, because LAN pages are a non-secure context where randomUUID is
 *   undefined.
 *
 * A fourth fix (dsh 0.1.1+) patches served JavaScript instead of HTML: the
 * client now computes `connection.isLoopback` from `location.hostname` and
 * keeps settings remote-only on non-loopback pages ("settings are unavailable
 * in this browser"). Since the hostname cannot be spoofed, the proxy rewrites
 * the bundle bytes to restore host-trust — unconditionally, like every other
 * compatibility fix here: the Host/Origin rewrite already presents proxied
 * traffic as loopback to the server-side fence, so withholding only the
 * client-side alignment would leave the UI degraded while the wire stayed
 * fully open. Basic Auth remains the one security barrier for the surface.
 *
 * A fifth fix (dsh 0.1.6-alpha+) carries the harness's browser-session
 * login: the index is gated behind a one-time `?token=` exchange that mints
 * a session cookie, so a bare LAN navigation would 401 with "web
 * authentication required". The proxy appends the process launch token to
 * the entry navigation of an already Basic-authenticated request; the token
 * is consumed upstream (which answers 303 to the clean path) and never
 * reaches the client, and a caller-supplied token is left untouched. Basic
 * Auth therefore remains the single barrier — the session is derived behind
 * it, exactly like the pre-browser-auth behavior LAN users expect.
 */
import http from 'node:http'
import type { Duplex } from 'node:stream'
import net from 'node:net'
import os from 'node:os'
import httpProxy from 'http-proxy'
import { Authenticator, SESSION_COOKIE, ENTRY_COOKIE, entryCookieHeader, mintSessionToken, readCookie, safeEqual, sessionCookieHeader } from './session.ts'
import { injectPolyfill, RANDOM_UUID_POLYFILL } from './polyfill.ts'
import { isJavaScriptContentType, patchClientScript } from './clientpatch.ts'

export interface LanProxyOptions {
  /** Interface the proxy binds (0.0.0.0 for LAN access). */
  listenHost: string
  /** Port the proxy listens on; 0 asks the OS for a free port. */
  listenPort: number
  /** Upstream DSH bind host, normally the loopback address. */
  upstreamHost: string
  /** Upstream DSH port (the web app's actual bound port). */
  upstreamPort: number
  /** Basic Auth username; password login is enabled only when both it and `password` are set. */
  username: string
  /** Basic Auth password; password login is enabled only when both it and `username` are set. */
  password: string
  /**
   * Process launch token the harness's index login exchanges for a browser
   * session. When set, the proxy appends it to the entry navigation so LAN
   * visitors get in with Basic Auth alone; absent (older harness or unreadable
   * token) the request is forwarded untouched and visitors fall back to the
   * printed `?token=` URL.
   */
  indexToken?: string
  /** Optional sink for human-readable lifecycle messages. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface LanProxyHandle {
  /** Resolves with the bound port once listening; rejects on bind errors. */
  ready: Promise<number>
  /** Close the listener and every upgraded socket. */
  close: () => Promise<void>
  /** Human-readable access URLs (local + LAN) for the configured port. */
  describeUrls: (boundPort: number) => { local: string; lan: string[] }
}

/** Basic Auth realm presented to unauthenticated clients. */
const AUTH_REALM = 'dsh-proxy'

/**
 * Static files browsers fetch OUTSIDE the authenticated document context
 * (the PWA manifest and the favicon are requested without credentials), so
 * gating them on Basic auth 401s them. They carry no secrets and the
 * upstream serves them unauthenticated anyway.
 */
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg'])

/** LAN IPv4 addresses the host currently has, as http URLs on `port`. */
export function lanAddresses(port: number): string[] {
  const ips: string[] = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const entry of ifaces ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) ips.push(entry.address)
    }
  }
  return ips.map((ip) => `http://${ip}:${port}`)
}

export function startLanProxy(options: LanProxyOptions): LanProxyHandle {
  const {
    listenHost,
    listenPort,
    upstreamHost,
    upstreamPort,
    username,
    password,
    indexToken,
    log = () => {},
  } = options
  const targetOrigin = `http://${upstreamHost}:${upstreamPort}`
  const auth = new Authenticator({ username, password })
  // Safari authenticates WebSocket handshakes separately from the page (it
  // does not replay the page's Basic credentials on an upgrade request),
  // which made iOS clients prompt for the password twice. A session cookie
  // issued on Basic-authenticated responses is accepted on both carriers;
  // Chromium already replays credentials, so its flow is unchanged. The
  // token lives only for this proxy start and is compared constant-time.
  const sessionToken = mintSessionToken()
  const isRequestAuthenticated = (req: http.IncomingMessage): boolean =>
    auth.isAuthenticated(req.headers.authorization)
    || safeEqual(readCookie(req.headers.cookie, SESSION_COOKIE) ?? '', sessionToken)

  // Entry navigations this proxy token-injected, so the proxyRes hook below
  // can mark the client once the harness completed the exchange. Keyed by
  // request object: http-proxy hands both hooks the same instance.
  const entryInjected = new WeakSet<http.IncomingMessage>()

  /** Merge extra Set-Cookie values into an upstream response's cookie list. */
  const withResponseCookies = (proxyRes: http.IncomingMessage, extra: string[]): void => {
    const existing = proxyRes.headers['set-cookie']
    const cookies = Array.isArray(existing) ? [...existing] : existing === undefined ? [] : [String(existing)]
    proxyRes.headers['set-cookie'] = [...cookies, ...extra]
  }

  const proxy = httpProxy.createProxyServer({
    target: targetOrigin,
    ws: true,
    changeOrigin: true,
  })
  proxy.on('error', (err, _req, res) => {
    log('error', `upstream ${targetOrigin} error: ${err.message}`)
    if (res && 'writeHead' in res && !res.headersSent) {
      try {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('502 Bad Gateway')
      } catch {
        /* socket already gone */
      }
    }
  })

  // Inject the randomUUID polyfill into proxied HTML documents, and rewrite
  // served JavaScript so the client treats the authenticated proxy as
  // host-trusted (see clientpatch.ts). Responses stream chunk by chunk, and
  // the JS needles can span chunks, so the JS branch buffers the whole body;
  // content-length is dropped in both cases (the chunked stream then carries
  // the body).
  proxy.on('proxyRes', (proxyRes, _req, res) => {
    const contentType = String(proxyRes.headers['content-type'] ?? '')
    if (proxyRes.headers['content-encoding']) return
    if (contentType.includes('text/html')) {
      delete proxyRes.headers['content-length']
      res.removeHeader('content-length')
      let injected = false
      // The interceptor must be attached before any data flows; http-proxy
      // emits proxyRes before piping, so hooking res.write here is safe.
      const origWrite = res.write.bind(res)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(res as any).write = (chunk: any, ...rest: any[]) => {
        if (!injected) {
          injected = true
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
          chunk = Buffer.from(injectPolyfill(text, RANDOM_UUID_POLYFILL))
        }
        return origWrite(chunk, ...rest)
      }
      return
    }
    // Applied unconditionally: the Host/Origin rewrite already lets the
    // server-side fence treat proxied traffic as loopback, so withholding the
    // client-side alignment would only leave the UI degraded (the pre-0.1.1
    // behavior) while the wire stayed fully open. Basic Auth remains the one
    // security barrier for the whole surface.
    if (!isJavaScriptContentType(contentType)) return
    delete proxyRes.headers['content-length']
    res.removeHeader('content-length')
    const chunks: Buffer[] = []
    let bufferedBytes = 0
    let ended = false
    const origWrite = res.write.bind(res)
    const origEnd = res.end.bind(res)
    const capture = (chunk: any): void => {
      const part =
        typeof chunk === 'string'
          ? Buffer.from(chunk, 'utf8')
          : ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer
            ? Buffer.from(chunk as Uint8Array)
            : null
      if (part !== null) {
        chunks.push(part)
        bufferedBytes += part.length
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(res as any).write = (chunk: any, ...rest: any[]): boolean => {
      capture(chunk)
      return true
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(res as any).end = (chunk?: any, ...rest: any[]) => {
      if (ended) return
      ended = true
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') capture(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      const { code, matched } = patchClientScript(text)
      if (matched.length > 0) log('info', `loopback-trust patch applied: ${matched.join(', ')}`)
      const callback = [chunk, ...rest].find((arg) => typeof arg === 'function')
      return callback === undefined ? origEnd(Buffer.from(code)) : origEnd(Buffer.from(code), callback)
    }
  })

  // Entry-exchange bookkeeping (see the injection in the request handler).
  // The mark rides in the upstream response's own cookie list because
  // http-proxy's writeHeaders replaces res.setHeader values wholesale.
  proxy.on('proxyRes', (proxyRes, req) => {
    const injected = entryInjected.delete(req)
    const status = proxyRes.statusCode ?? 0
    const isEntry = new URL(req.url ?? '/', 'http://proxy.local').pathname === '/'
    if (injected) {
      // The exchange completed only when the harness answered the token
      // navigation (303 + Set-Cookie; 200 if a future harness serves the
      // index directly). Anything else leaves the client unmarked so the
      // next entry navigation simply retries.
      if (isEntry && (status === 303 || status === 200)) {
        withResponseCookies(proxyRes, [entryCookieHeader()])
      }
      return
    }
    // Not ours: the only reason to touch the response is a stale mark — the
    // client completed the exchange before, but the harness session behind
    // it is gone (the 30-day cookie expired) and the entry is now refused.
    // Expire the mark so the next navigation re-runs the exchange instead
    // of failing forever.
    if (status === 401 && isEntry && readCookie(req.headers.cookie, ENTRY_COOKIE) !== undefined) {
      withResponseCookies(proxyRes, [entryCookieHeader(0)])
    }
  })

  const alignOrigin = (req: http.IncomingMessage): void => {
    if (req.headers.origin) req.headers.origin = targetOrigin
  }

  /**
   * Challenge with HTTP Basic Auth: the 401 plus WWW-Authenticate makes the
   * browser show its NATIVE credential dialog. No custom login page exists —
   * this is the whole authentication surface, matching the standalone
   * dsh-proxy. (Browsers cache the credentials per origin after a successful
   * login and silently replay them, including on WebSocket handshakes.)
   */
  const challenge = (res: http.ServerResponse): void => {
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'www-authenticate': `Basic realm="${AUTH_REALM}"`,
    })
    res.end('401 Unauthorized')
  }

  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://proxy.local').pathname
    // Public static files (PWA manifest, favicon): fetched without
    // credentials by the browser, so they bypass the auth gate.
    if (PUBLIC_PATHS.has(pathname)) {
      alignOrigin(req)
      proxy.web(req, res)
      return
    }
    if (!isRequestAuthenticated(req)) {
      challenge(res)
      return
    }
    // Issue the session capability only on proof of the actual password (not
    // on requests that merely presented a valid cookie), so the token never
    // leaks to an unauthenticated caller. With password login off there is
    // nothing to gate and no cookie is issued.
    if (auth.enabled && auth.isAuthenticated(req.headers.authorization)) {
      res.setHeader('set-cookie', sessionCookieHeader(sessionToken))
    }
    // Browser-session login: the harness gates the index behind a one-time
    // `?token=` exchange (303 + session cookie). Append the launch token to
    // the entry navigation only — the request already passed the Basic Auth
    // gate above, the token is consumed upstream and never echoed to the
    // client, and a caller-supplied token is never overwritten. The entry
    // mark makes it exactly once per browser session: the harness answers
    // EVERY token navigation with a 303 back to `/`, so re-appending on the
    // follow-up request would loop forever.
    if (indexToken !== undefined && req.method === 'GET' && pathname === '/') {
      const url = new URL(req.url ?? '/', 'http://proxy.local')
      if (!url.searchParams.has('token')
        && readCookie(req.headers.cookie, ENTRY_COOKIE) === undefined) {
        url.searchParams.set('token', indexToken)
        req.url = `${url.pathname}${url.search}`
        entryInjected.add(req)
      }
    }
    alignOrigin(req)
    proxy.web(req, res)
  })

  // Mobile peers routinely reset connections mid-handshake (tab closes, auth
  // retries, network switches). Neither the 401 write in the upgrade handler
  // below nor http-proxy's ws pass observes socket errors until after the
  // upstream answers, so observe them here first: an unobserved ECONNRESET
  // escapes as an unhandled 'error' event and kills the whole dsh web
  // process this plugin runs inside.
  server.on('connection', (socket) => {
    socket.on('error', (error: NodeJS.ErrnoException) => {
      log('warn', `client socket error ${error.code ?? error.message}`)
      socket.destroy()
    })
  })

  const upgradedSockets = new Set<net.Socket>()
  server.on('upgrade', (req, socket, head) => {
    if (!isRequestAuthenticated(req)) {
      socket.end(`HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`)
      return
    }
    upgradedSockets.add(socket as net.Socket)
    ;(socket as net.Socket).once('close', () => upgradedSockets.delete(socket as net.Socket))
    alignOrigin(req)
    proxy.ws(req, socket as Duplex, head)
  })

  const ready = new Promise<number>((resolve, reject) => {
    const onListenError = (err: NodeJS.ErrnoException): void => {
      log('error', `cannot listen on ${listenHost}:${listenPort}: ${err.code ?? err.message}`)
      reject(err)
    }
    server.once('error', onListenError)
    server.listen(listenPort, listenHost, () => {
      server.off('error', onListenError)
      server.on('error', (err) => log('error', `proxy server error: ${err.message}`))
      resolve((server.address() as net.AddressInfo).port)
    })
  })

  const close = async (): Promise<void> => {
    for (const socket of upgradedSockets) socket.destroy()
    upgradedSockets.clear()
    await new Promise<void>((resolveClose) => {
      // Stop accepting new connections; the listener is released immediately
      // so a restart can rebind the same port. In-flight responses (e.g. the
      // settings-page update answer travelling back through the proxy) get a
      // short grace before connections are force-closed. The timer stays
      // referenced so it always fires even under a loaded event loop.
      server.close(() => resolveClose())
      const timer = setTimeout(() => {
        server.closeAllConnections()
      }, 250)
    })
  }

  return {
    ready,
    close,
    describeUrls: (boundPort) => ({
      local: `http://127.0.0.1:${boundPort}`,
      lan: lanAddresses(boundPort),
    }),
  }
}
