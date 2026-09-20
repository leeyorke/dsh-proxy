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
import type { IncomingMessage } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
/** Failure shape one endpoint may return (Connection's `ConnectionRpcFailure`). */
export interface ChannelRpcFailure {
    readonly code: string;
    readonly message: string;
    readonly details: object;
}
/** Result shape one endpoint returns (Connection's `ConnectionRpcResult`). */
export type ChannelRpcResult<T = unknown> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: ChannelRpcFailure;
};
/** Decoded endpoint handler: the plugin's own verbs (status/update/start/stop). */
export type ChannelRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ChannelRpcResult>;
/** Trust fence applied before dispatch; returns the rejection status, or undefined to admit. */
export type ChannelTrustFence = (request: IncomingMessage) => number | undefined;
/** Everything the route needs from its host. */
export interface ChannelRouteOptions {
    /** Absolute channel prefix, e.g. `/dsh-proxy`. */
    readonly channel: string;
    /** Decoded endpoint handler invoked after the fence and envelope checks pass. */
    readonly handler: ChannelRpcHandler;
    /** Host/Origin trust plus browser-authentication fence (Connection's `requestRejection`). */
    readonly fence: ChannelTrustFence;
    /** Maximum buffered request body; larger bodies are refused with 413. */
    readonly maxBodyBytes?: number;
}
/**
 * Extract the endpoint from a channel pathname, applying the same grammar
 * as the Connection client so both halves agree on what is routable.
 * @param channel - absolute channel prefix.
 * @param pathname - request pathname (no query).
 * @returns the channel-relative endpoint, or undefined when unroutable.
 */
export declare function channelEndpoint(channel: string, pathname: string): string | undefined;
/**
 * Build the physical webServer route for one owned RPC channel.
 * @param options - channel, handler, trust fence, and body cap.
 * @returns a prefix `WebRoute` mounting `<channel>/<endpoint>`.
 */
export declare function createChannelRoute(options: ChannelRouteOptions): WebRoute;
