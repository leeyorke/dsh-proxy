/** Credential pair enforced by the proxy (an empty pair = password login off). */
export interface AuthConfig {
    username: string;
    password: string;
}
/** Constant-time string comparison (length mismatch short-circuits). */
export declare function safeEqual(a: string, b: string): boolean;
/** Verify an HTTP Basic Authorization header against the configured pair. */
export declare function checkBasicAuth(authorization: string | undefined, username: string, password: string): boolean;
/** Cookie name carrying the proxy's post-login session capability. */
export declare const SESSION_COOKIE = "dsh_proxy_session";
/** Mint one cryptographically random session token (64 hex chars). */
export declare function mintSessionToken(): string;
/**
 * Extract a named cookie value from a request Cookie header.
 * @param header - the raw `cookie` request header, or undefined when absent.
 * @param name - the cookie name to look up (exact match).
 * @returns the cookie value, or undefined when absent.
 */
export declare function readCookie(header: string | undefined, name: string): string | undefined;
/**
 * The Set-Cookie header value issued after a successful Basic login. A
 * browser-session cookie: no Expires/Max-Age, so it dies with the browser
 * session and the token regenerates on every proxy start anyway.
 * @param token - the active session token.
 * @returns the full Set-Cookie header value.
 */
export declare function sessionCookieHeader(token: string): string;
/**
 * Cookie name marking that the entry browser-session exchange (the
 * harness's one-time `?token=` navigation) already completed for this
 * client. Without the mark the proxy would re-append the token to every
 * `/` GET, and the harness answers every token navigation with a 303 back
 * to `/` — an infinite redirect loop.
 */
export declare const ENTRY_COOKIE = "dsh_proxy_entry";
/**
 * The Set-Cookie value for the entry-exchange mark. A browser-session
 * cookie like the session capability: once it is gone the next entry
 * navigation re-runs the exchange, so a stale mark can never wedge a
 * visitor out. `maxAgeSeconds` of 0 expires it immediately, used to
 * self-heal when the harness session behind the mark has died.
 * @param maxAgeSeconds - when given, the cookie's Max-Age (0 = expire now).
 * @returns the full Set-Cookie header value.
 */
export declare function entryCookieHeader(maxAgeSeconds?: number): string;
/** The proxy's gate: Basic Auth only, active when both credentials are set. */
export declare class Authenticator {
    readonly config: AuthConfig;
    constructor(config: AuthConfig);
    /** Password login is active only when both username and password are set. */
    get enabled(): boolean;
    isAuthenticated(authorization: string | undefined): boolean;
}
