/**
 * Live smoke test for dsh-proxy against a RUNNING DSH web app.
 *
 * Starts the bundled proxy (lib/index.js — the same artifact the profile
 * loads) on 127.0.0.1:0, then verifies the full LAN story against the real
 * app: login flow, cookie-gated proxying, trust-fence header rewriting,
 * randomUUID polyfill injection, and WebSocket handshakes.
 *
 * Usage: pnpm run smoke   (requires the web app on 127.0.0.1:3080)
 * Set DSH_SMOKE_SKIP_LIVE=1 to run only the plugin-contract phase (no live
 * DSH needed — drives the bundled apply() with a fake ctx).
 */
import http from 'node:http'
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLanProxy } from '../lib/index.cjs'

const UPSTREAM = Number(process.env.DSH_SMOKE_UPSTREAM_PORT ?? 3080)
const USER = process.env.DSH_SMOKE_USER ?? 'admin'
const PASS = process.env.DSH_SMOKE_PASS ?? 'admin'

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function rawUpgrade(port, path, headers) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ status: 0, text: data })
    }, 8000)
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer)
        socket.destroy()
        const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(data)?.[1] ?? 0)
        resolve({ status, text: data })
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve({ status: 0, text: data })
    })
  })
}

async function main() {
  if (process.env.DSH_SMOKE_SKIP_LIVE !== '1') {
    await liveProxyPhase()
  }
  await pluginContractPhase()

  console.log(`\nsmoke: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

/** Phase 1: the bundled proxy against a running DSH web app. */
async function liveProxyPhase() {
  const upstream = `http://127.0.0.1:${UPSTREAM}`
  console.log(`dsh-proxy smoke — upstream ${upstream}, auth ${USER}/***`)
  const handle = startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: UPSTREAM,
    username: USER,
    password: PASS,
    log: (level, message) => console.log(`  [proxy:${level}] ${message}`),
  })
  const port = await handle.ready
  const base = `http://127.0.0.1:${port}`
  const origin = `http://127.0.0.1:${port}`
  const authorization = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`

  try {
    // 1. anonymous navigation → 401 with the native Basic challenge
    let res = await fetch(`${base}/`, { redirect: 'manual', headers: { accept: 'text/html' } })
    check(
      'anonymous / → 401 Basic challenge',
      res.status === 401 && /^Basic realm=/.test(res.headers.get('www-authenticate') ?? ''),
      `status=${res.status} www-auth=${res.headers.get('www-authenticate')}`,
    )

    // 2. anonymous /api → 401 with the Basic challenge
    res = await fetch(`${base}/api/state`, { redirect: 'manual' })
    check('anonymous /api → 401 Basic challenge', res.status === 401 && /^Basic realm=/.test(res.headers.get('www-authenticate') ?? ''), `status=${res.status}`)

    // 2b. public static files (PWA manifest, favicon) need no auth
    res = await fetch(`${base}/manifest.webmanifest`, { redirect: 'manual' })
    check('public manifest served without auth', res.status === 200, `status=${res.status}`)
    res = await fetch(`${base}/favicon.svg`, { redirect: 'manual' })
    check('public favicon served without auth', res.status === 200, `status=${res.status}`)

    // 3. wrong Basic credentials → 401
    res = await fetch(`${base}/`, { redirect: 'manual', headers: { authorization: `Basic ${Buffer.from(`${USER}:wrong`).toString('base64')}` } })
    check('wrong Basic credentials → 401', res.status === 401, `status=${res.status}`)

    // 4. with Basic credentials → real DSH index + polyfill injected
    res = await fetch(`${base}/`, { headers: { authorization } })
    const html = await res.text()
    const polyfillAt = html.indexOf('randomUUID=function')
    const moduleAt = html.indexOf('<script type="module"')
    check('authenticated / serves the DSH app', res.status === 200 && html.includes('<div id="root">'), `status=${res.status}`)
    check('randomUUID polyfill injected before the app script', polyfillAt !== -1 && polyfillAt < moduleAt, `polyfillAt=${polyfillAt} moduleAt=${moduleAt}`)

    // 5. static asset through the proxy
    res = await fetch(`${base}/favicon.svg`, { headers: { authorization } })
    check('favicon served through the proxy', res.status === 200 && (res.headers.get('content-type') ?? '').includes('svg'), `status=${res.status}`)

    // 6. trust fence passes: GET /api/events.mux must reach the route (426 upgrade required), not 403
    res = await fetch(`${base}/api/events.mux`, { headers: { authorization } })
    check('/api/events.mux reaches the route (426, fence passed)', res.status === 426, `status=${res.status} (403 would mean the Host/Origin rewrite failed)`)

    // 7. websocket with Basic credentials → 101
    const open = await rawUpgrade(port, '/api/events.mux', {
      Origin: origin,
      Authorization: authorization,
    })
    check('WS handshake with Basic → 101', open.status === 101, `status=${open.status}`)

    // 8. websocket without credentials → 401
    const denied = await rawUpgrade(port, '/api/events.mux', { Origin: origin })
    check('WS handshake without credentials → 401', denied.status === 401, `status=${denied.status}`)
  } finally {
    await handle.close()
  }
}

/**
 * Plugin-contract phase: drive the BUNDLED apply() (lib/index.cjs — the same
 * artifact the profile loads) against a fake cordis ctx, exercising the
 * /dsh-proxy RPC channel — fence, envelope, dispatch — the settings
 * persistence, and the restart path end to end without the web app.
 * $DSH_HOME is redirected to a temp dir so the smoke never touches the
 * user's real persisted config.
 *
 * The route is driven through the REAL bundled handler with fake
 * node:http req/res objects: the breakage this guards against (the
 * dedicated-channel mount failing under a real fiber) was invisible to a
 * fake ctx that only captured a handler function.
 */
async function pluginContractPhase() {
  console.log('\ndsh-proxy plugin contract — bundled apply() with a fake ctx')
  const plugin = await import('../lib/index.cjs')
  check(
    'plugin exports name/inject/Config/apply',
    ['name', 'inject', 'Config', 'apply'].every((key) => key in plugin)
      && plugin.name === '@leeyorke/dsh-proxy'
      && plugin.inject.includes('webServer')
      && plugin.inject.includes('connection'),
  )

  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-proxy-smoke-'))
  process.env.DSH_HOME = tempHome
  // A local stand-in for the harness web app, mimicking the two gates the
  // proxy must satisfy: the index browser-session exchange (authorizeIndex:
  // 401 without the launch token, 303 + session cookie with it) and a
  // reachable favicon for the status probe.
  const LAUNCH_TOKEN = 'smoke-launch-token'
  const upstreamSeen = { indexUrl: undefined, apiUrl: undefined }
  const fakeUpstream = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://up')
    if (url.pathname === '/') {
      upstreamSeen.indexUrl = req.url
      if (url.searchParams.get('token') === LAUNCH_TOKEN) {
        res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-x=v1; Path=/; HttpOnly' })
        res.end()
        return
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
      return
    }
    if (url.pathname === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      res.end('<svg xmlns="http://www.w3.org/2000/svg"/>')
      return
    }
    if (url.pathname === '/api/state') {
      upstreamSeen.apiUrl = req.url
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise((resolve) => fakeUpstream.listen(0, '127.0.0.1', resolve))
  const fakeUpstreamPort = fakeUpstream.address().port
  try {
    let registeredRoute = null
    let fenceReject = 0
    const fenceCalls = []
    const effectFns = []
    const pluginLogs = []
    const fakeCtx = {
      webServer: {
        port: fakeUpstreamPort,
        host: '127.0.0.1',
        register: (route) => {
          registeredRoute = route
          return () => {}
        },
      },
      connection: {
        requestRejection: (request) => {
          fenceCalls.push(request)
          return fenceReject === 0 ? undefined : fenceReject
        },
        authenticatedUrl: (base) => `${base}${base.includes('?') ? '&' : '?'}token=${LAUNCH_TOKEN}`,
      },
      logger: {
        info: (message) => { pluginLogs.push(['info', message]); console.log(`  [plugin:info] ${message}`) },
        warn: (message) => { pluginLogs.push(['warn', message]); console.log(`  [plugin:warn] ${message}`) },
        error: (message) => { pluginLogs.push(['error', message]); console.log(`  [plugin:error] ${message}`) },
      },
      effect: (fn) => {
        effectFns.push(fn)
        return () => {}
      },
    }
    plugin.apply(fakeCtx, { listenHost: '127.0.0.1', listenPort: 0 })
    const proxyDisposer = await effectFns[0]()
    const rpcCleanup = effectFns[1]()
    check(
      'launch token acquired from Connection (no manual-URL warning)',
      pluginLogs.every(([level, message]) => !(level === 'warn' && /launch token/.test(message))),
      JSON.stringify(pluginLogs.filter(([level, message]) => level === 'warn' && /launch token/.test(message))),
    )
    check(
      'RPC channel mounted as a prefix route on the web server',
      registeredRoute?.kind === 'prefix' && registeredRoute?.path === '/dsh-proxy',
      JSON.stringify(registeredRoute && { kind: registeredRoute.kind, path: registeredRoute.path }),
    )

    // Drive the bundled route handler with fake node:http objects.
    const rpc = async (endpoint, payload, opts = {}) => {
      const body = JSON.stringify({
        type: 'client-request',
        rpcId: opts.rpcId ?? `smoke-${endpoint}`,
        method: opts.method ?? endpoint,
        ...payload === undefined ? {} : { payload },
      })
      const req = {
        method: 'POST',
        url: opts.url ?? `/dsh-proxy/${endpoint}`,
        headers: { 'content-type': 'application/json' },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(body, 'utf8')
        },
        destroy() {},
      }
      const res = {
        statusCode: 0,
        headers: {},
        body: '',
        writableEnded: false,
        writeHead(status, headers) {
          this.statusCode = status
          this.headers = headers ?? {}
          return this
        },
        write(chunk) {
          this.body += String(chunk)
          return true
        },
        end(chunk) {
          if (chunk !== undefined) this.body += String(chunk)
          this.writableEnded = true
          return this
        },
        on() {},
      }
      await registeredRoute.handler(req, res)
      let envelope
      try {
        envelope = JSON.parse(res.body)
      } catch {
        envelope = undefined // transport-level answers (401/403/404/…) are plain text
      }
      return { status: res.statusCode, envelope }
    }

    const status1 = await rpc('status')
    check(
      'RPC status returns ok with a bound port and green lights',
      status1.status === 200
        && status1.envelope?.type === 'server-response'
        && status1.envelope?.result?.ok === true
        && typeof status1.envelope.result.value?.listenPort === 'number'
        && status1.envelope.result.value.listenPort > 0
        && status1.envelope.result.value.proxyListening === true
        && status1.envelope.result.value.upstreamReachable === true,
      JSON.stringify(status1),
    )
    check('every channel request passes the Connection trust fence', fenceCalls.length === 1, `fenceCalls=${fenceCalls.length}`)

    // The fence gates the channel: a rejected request never reaches the handler.
    fenceReject = 401
    const fenced = await rpc('status')
    check(
      'a fence-rejected request is refused before dispatch',
      fenced.status === 401 && fenced.envelope === undefined,
      `status=${fenced.status}`,
    )
    fenceReject = 0

    const updated = await rpc('update', { username: 'smoke-user', password: 'smoke-pass' })
    check(
      'RPC update rotates credentials and restarts',
      updated.envelope?.result?.ok === true && updated.envelope.result.value?.status?.username === 'smoke-user',
      JSON.stringify(updated),
    )

    const status2 = await rpc('status')
    check(
      'status reflects the new username and persisted flag',
      status2.envelope?.result?.value?.username === 'smoke-user'
        && status2.envelope.result.value.persisted === true,
      JSON.stringify(status2),
    )

    const persisted = JSON.parse(readFileSync(join(tempHome, 'dsh-proxy.json'), 'utf8'))
    check(
      'patch persisted to $DSH_HOME/dsh-proxy.json',
      persisted.username === 'smoke-user' && persisted.password === 'smoke-pass',
    )

    const conflict = await rpc('update', { listenPort: status2.envelope.result.value.upstreamPort })
    check(
      'listen port equal to the default service port rejected',
      conflict.envelope?.result?.ok === false,
      JSON.stringify(conflict),
    )

    const cleared = await rpc('update', { username: '', password: '' })
    check(
      'clearing credentials disables password login (set-empty semantics)',
      cleared.envelope?.result?.ok === true
        && cleared.envelope.result.value?.status?.authEnabled === false
        && cleared.envelope.result.value.status.password === '',
      JSON.stringify(cleared),
    )
    const reopened = await rpc('update', { username: 'smoke-user', password: 'smoke-pass' })
    check(
      're-setting both credentials re-enables password login',
      reopened.envelope?.result?.ok === true && reopened.envelope.result.value?.status?.authEnabled === true,
    )

    const stopped = await rpc('stop', {})
    check(
      'RPC stop answers with the proxy stopped',
      stopped.envelope?.result?.ok === true && stopped.envelope.result.value?.proxyListening === false,
      JSON.stringify(stopped),
    )
    // Let the deferred listener close, then bring it back up.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const started = await rpc('start', {})
    check(
      'RPC start brings the proxy back up',
      started.envelope?.result?.ok === true && started.envelope.result.value?.proxyListening === true,
      JSON.stringify(started),
    )

    // Envelope-level failures answer inside the envelope (HTTP 200), never as
    // transport errors — the browser half throws on any non-2xx.
    const mismatch = await rpc('status', undefined, { method: 'update', rpcId: 'smoke-mismatch' })
    check(
      'method/endpoint disagreement answers an error envelope, not a transport error',
      mismatch.status === 200
        && mismatch.envelope?.result?.ok === false
        && mismatch.envelope.result.error.code === 'gateway/bad-request',
      JSON.stringify(mismatch),
    )

    // Entry-navigation token injection, end to end through the bundled
    // plugin: the proxy is really listening (its port comes from the
    // plugin's own log — the LAST one, after the stop/start cycle above
    // rebound it), the fake upstream is the harness's index gate. The
    // restart above left password login on (smoke-user/smoke-pass), so the
    // entry fetches carry Basic credentials like a real LAN browser.
    const logText = pluginLogs.map(([, message]) => message).join('\n')
    const ports = [...logText.matchAll(/本机访问 http:\/\/127\.0\.0\.1:(\d+)/g)].map((match) => match[1])
    const proxyPort = ports.at(-1)
    const entry = async (path) => {
      const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
        redirect: 'manual',
        headers: { authorization: `Basic ${Buffer.from('smoke-user:smoke-pass').toString('base64')}` },
      })
      return { status: res.status, setCookie: res.headers.get('set-cookie') }
    }
    const entered = await entry('/')
    check(
      'entry navigation carries the launch token and passes the session exchange',
      entered.status === 303 && entered.setCookie?.includes('dsh-auth-') === true
        && new URL(upstreamSeen.indexUrl ?? '', 'http://up').searchParams.get('token') === LAUNCH_TOKEN,
      JSON.stringify({ entered, upstreamSeen }),
    )
    await entry('/?token=caller-token')
    check(
      'a caller-supplied token is never overwritten',
      new URL(upstreamSeen.indexUrl ?? '', 'http://up').searchParams.get('token') === 'caller-token',
      upstreamSeen.indexUrl,
    )
    const api = await entry('/api/state')
    check(
      'non-entry paths carry no token',
      api.status === 200 && upstreamSeen.apiUrl === '/api/state',
      JSON.stringify({ api, upstreamSeen }),
    )

    rpcCleanup()
    await proxyDisposer()
  } finally {
    delete process.env.DSH_HOME
    rmSync(tempHome, { recursive: true, force: true })
    await new Promise((resolve) => {
      fakeUpstream.closeAllConnections()
      fakeUpstream.close(() => resolve())
    })
  }
}

main().catch((err) => {
  console.error('smoke crashed:', err)
  process.exit(1)
})
