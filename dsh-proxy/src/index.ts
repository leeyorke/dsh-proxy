/**
 * dsh-proxy host plugin: mounts the authenticated LAN reverse proxy on a
 * second port, forwarding the web app's loopback listener (127.0.0.1:3080 by
 * default) to the LAN with a web-based login gate. The harness deliberately
 * refuses `--host 0.0.0.0` for the web server itself — remote code execution
 * exposure — so this plugin is the sanctioned way to serve the surface beyond
 * loopback, with authentication in front.
 *
 * The plugin also mounts the `/dsh-proxy` generic Connection RPC channel:
 * `status` reads the running proxy, `update` persists a settings patch (target
 * upstream port, username, password) into `$DSH_HOME/dsh-proxy.json` and
 * restarts the forwarding service — the backend of the settings section. The
 * channel's physical route is owned by this plugin (registered on the injected
 * `ctx.webServer`, fenced by `ctx.connection.requestRejection`) instead of
 * going through `connection.rpc.handle`: the harness's dedicated-channel
 * mount resolves `webServer` through the client-connection plugin's fiber and
 * throws once `webServer` stopped being a static injection there.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: merges `ctx.webServer` into the Context type.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: merges `ctx.connection` (host Connection RPC registry).
import type {} from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ProxyController } from './controller.ts'
import { createChannelRoute, type ChannelRpcResult } from './rpc-route.ts'
import { RPC_CHANNEL, RPC_START_ENDPOINT, RPC_STATUS_ENDPOINT, RPC_STOP_ENDPOINT, RPC_UPDATE_ENDPOINT } from './contract.ts'

// Standalone API for scripts and smoke tests, exercised through the same
// bundled artifact the profile loads.
export { lanAddresses, startLanProxy } from './proxy.ts'
export type { LanProxyHandle, LanProxyOptions } from './proxy.ts'

/** Stable Cordis plugin name (the Loader entry and package name). */
export const name = '@leeyorke/dsh-proxy'

/** Services required before load: the web server (upstream port source and channel route host) and the Connection service (the channel route's trust fence). */
export const inject = ['webServer', 'connection']

/** Plugin configuration, validated at load by the Loader. */
export interface Config {
  /** Interface the proxy binds; 0.0.0.0 exposes the LAN. */
  listenHost: string
  /** Port the proxy listens on (must differ from the web app's port). */
  listenPort: number
  /** Upstream DSH bind host. */
  upstreamHost: string
  /** Upstream DSH port; 0 follows the web app's actual bound port. */
  upstreamPort: number
  /** Login / Basic Auth username; password login is enabled only when both it and `password` are set. */
  username: string
  /** Login / Basic Auth password; password login is enabled only when both it and `username` are set. */
  password: string
}

/** Configuration schema; deployment-varying bounds stay tunable from cordis.yml. */
export const Config = z.object({
  listenHost: z.string().default('0.0.0.0'),
  listenPort: z.natural().max(65535).default(3081),
  upstreamHost: z.string().default('127.0.0.1'),
  upstreamPort: z.natural().max(65535).default(0),
  username: z.string().default(''),
  password: z.string().default(''),
})

/**
 * Read the harness process launch token through Connection's public helper.
 *
 * The harness gates the index behind a one-time `?token=` exchange that
 * mints the browser session; the proxy appends this token to the entry
 * navigation so LAN visitors get in with Basic Auth alone (the token is
 * consumed upstream and never reaches the client). A harness without the
 * helper — older or newer — degrades to the manual flow (open the printed
 * `?token=` URL once) with a warning instead of failing the load.
 * @param ctx - host cordis context.
 * @param log - plugin log sink.
 * @returns the launch token, or undefined when unavailable.
 */
function readLaunchToken(ctx: Context, log: (level: 'info' | 'warn' | 'error', message: string) => void): string | undefined {
  try {
    const token = new URL(ctx.connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token')
    if (token === null) {
      log('warn', 'dsh-proxy: the harness exposed no launch token — LAN visitors must open the ?token= URL printed by dsh web once')
      return undefined
    }
    return token
  } catch (error) {
    log('warn', `dsh-proxy: cannot read the harness launch token (${String(error)}) — LAN visitors must open the ?token= URL printed by dsh web once`)
    return undefined
  }
}

/**
 * Mount the proxy and the RPC channel as effects on this plugin's fiber:
 * unloading the plugin closes the listener, every upgraded socket, and the
 * channel.
 * @param ctx - host cordis context.
 * @param config - validated plugin configuration (schema defaults applied).
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = Config(config ?? {})
  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    ctx.logger[level](message)
  }
  const controller = new ProxyController({
    base: {
      listenHost: resolved.listenHost,
      listenPort: resolved.listenPort,
      upstreamHost: resolved.upstreamHost,
      upstreamPort: resolved.upstreamPort || ctx.webServer.port || 3080,
      username: resolved.username,
      password: resolved.password,
      indexToken: readLaunchToken(ctx, log),
    },
    settingsFile: dshHomePath('dsh-proxy.json'),
    log,
  })

  ctx.effect(
    async () => {
      await controller.start()
      return () => controller.stop()
    },
    'dsh-proxy.proxy',
  )

  ctx.effect(
    () => ctx.webServer.register(createChannelRoute({
      channel: RPC_CHANNEL,
      // The channel rides the same trust fence and browser-session
      // authentication as `/api` (the plugin's proxy rewrites Host and
      // Origin to the loopback upstream, so proxied LAN traffic passes the
      // Host fence exactly like the shared API channel). A fence that
      // throws refuses the request (fail closed) and is logged loudly —
      // the channel must never silently open if the harness API moves.
      fence: (request) => ctx.connection.requestRejection(request),
      onFenceError: (error) => log('error', `dsh-proxy: channel trust fence failed, request refused: ${String(error)}`),
      handler: async (endpoint, payload): Promise<ChannelRpcResult> => {
        if (endpoint === RPC_STATUS_ENDPOINT) {
          return { ok: true, value: await controller.refreshStatus() }
        }
        if (endpoint === RPC_START_ENDPOINT) {
          const outcome = await controller.start()
          if (!outcome.ok) {
            // The listener did not bind (e.g. the port is taken): answer with
            // the real reason so the settings page reports it instead of
            // claiming the proxy started.
            return {
              ok: false,
              error: { code: 'bad-request', message: outcome.message, details: { issues: [] } },
            }
          }
          return { ok: true, value: await controller.refreshStatus() }
        }
        if (endpoint === RPC_STOP_ENDPOINT) {
          // Answered before the listener closes so the response survives
          // when the caller is connected through the proxy.
          return { ok: true, value: controller.stopDeferred() }
        }
        if (endpoint === RPC_UPDATE_ENDPOINT) {
          const outcome = await controller.update(payload)
          if (outcome.ok) return { ok: true, value: outcome.result }
          return {
            ok: false,
            error: { code: 'bad-request', message: outcome.message, details: { issues: [] } },
          }
        }
        return {
          ok: false,
          error: {
            code: 'bad-request',
            message: `unknown endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
          },
        }
      },
    })),
    'dsh-proxy.rpc',
  )
}
