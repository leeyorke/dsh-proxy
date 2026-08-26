/**
 * Authentication primitives for the LAN proxy: HTTP Basic Auth is the entire
 * gate, presented through the browser's NATIVE credential dialog — the same
 * model as the standalone dsh-proxy. There is no custom login page and no
 * session cookie: after a successful Basic login the browser caches the
 * credentials for the origin and silently sends them on every request.
 *
 * Password login is active only when BOTH username and password are
 * configured; with either one empty the LAN surface is open (the settings
 * page warns about this).
 */
import { timingSafeEqual, randomBytes } from 'node:crypto'

/** Credential pair enforced by the proxy (an empty pair = password login off). */
export interface AuthConfig {
  username: string
  password: string
}

/** Constant-time string comparison (length mismatch short-circuits). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** Verify an HTTP Basic Authorization header against the configured pair. */
export function checkBasicAuth(
  authorization: string | undefined,
  username: string,
  password: string,
): boolean {
  const match = /^Basic\s+(.+)$/i.exec(authorization ?? '')
  if (!match) return false
  let decoded: string
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8')
  } catch {
    return false
  }
  const sep = decoded.indexOf(':')
  if (sep === -1) return false
  return safeEqual(decoded.slice(0, sep), username) && safeEqual(decoded.slice(sep + 1), password)
}

/** Cookie name carrying the proxy's post-login session capability. */
export const SESSION_COOKIE = 'dsh_proxy_session'

/** Mint one cryptographically random session token (64 hex chars). */
export function mintSessionToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Extract a named cookie value from a request Cookie header.
 * @param header - the raw `cookie` request header, or undefined when absent.
 * @param name - the cookie name to look up (exact match).
 * @returns the cookie value, or undefined when absent.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq !== -1 && trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1)
  }
  return undefined
}

/**
 * The Set-Cookie header value issued after a successful Basic login. A
 * browser-session cookie: no Expires/Max-Age, so it dies with the browser
 * session and the token regenerates on every proxy start anyway.
 * @param token - the active session token.
 * @returns the full Set-Cookie header value.
 */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`
}

/** The proxy's gate: Basic Auth only, active when both credentials are set. */
export class Authenticator {
  constructor(readonly config: AuthConfig) {}

  /** Password login is active only when both username and password are set. */
  get enabled(): boolean {
    return this.config.username !== '' && this.config.password !== ''
  }

  isAuthenticated(authorization: string | undefined): boolean {
    if (!this.enabled) return true
    return checkBasicAuth(authorization, this.config.username, this.config.password)
  }
}
