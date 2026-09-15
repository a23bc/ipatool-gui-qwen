/**
 * HTTP helpers for the main process.
 *
 * Everything goes through Electron's `net.fetch` when the app is ready, which
 * uses Chromium's network stack and therefore honours the system proxy. That
 * matters a lot for this app: GitHub release assets and Apple's artwork CDN are
 * frequently reached through a corporate or regional proxy, and Node's plain
 * `fetch` ignores system proxy settings entirely.
 *
 * We fall back to global fetch before app-ready (and in unit tests).
 */

import { app, net } from 'electron'

export interface FetchOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Called with (received, total|null) as the body streams in. */
  onProgress?: (received: number, total: number | null) => void
}

const USER_AGENT = 'ipatool-gui (Electron)'

function fetchImpl(): typeof globalThis.fetch {
  try {
    if (app.isReady?.() && typeof net?.fetch === 'function') {
      return net.fetch as unknown as typeof globalThis.fetch
    }
  } catch {
    /* net unavailable - use the Node implementation */
  }
  return globalThis.fetch
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Downloads a whole body into memory, reporting progress as it arrives. */
export async function fetchBuffer(url: string, options: FetchOptions = {}): Promise<Uint8Array> {
  const response = await fetchImpl()(url, {
    signal: options.signal,
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) }
  })

  if (!response.ok) {
    throw new HttpError(`HTTP ${response.status} ${response.statusText || ''}`.trim(), response.status, url)
  }

  const lengthHeader = response.headers.get('content-length')
  const total = lengthHeader ? Number.parseInt(lengthHeader, 10) : null
  const expected = Number.isFinite(total) && total && total > 0 ? total : null

  if (!response.body || !options.onProgress) {
    const buffer = Buffer.from(await response.arrayBuffer())
    options.onProgress?.(buffer.byteLength, expected)
    return buffer
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.byteLength
      options.onProgress(received, expected)
    }
  }
  const out = Buffer.alloc(received)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const bytes = await fetchBuffer(url, options)
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Fetches text and reports the final URL after redirects.
 *
 * Used to discover the newest ipatool release without the GitHub *API*:
 * github.com/<repo>/releases/latest redirects to /releases/tag/vX.Y.Z, and the
 * plain site is both less rate-limited and proxy-friendly compared to
 * api.github.com (which 403s heavily on shared/NAT IPs).
 */
export async function fetchTextWithFinalUrl(
  url: string,
  options: FetchOptions = {}
): Promise<{ text: string; url: string }> {
  const response = await fetchImpl()(url, {
    signal: options.signal,
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, ...(options.headers ?? {}) }
  })
  if (!response.ok) {
    throw new HttpError(`HTTP ${response.status} ${response.statusText || ''}`.trim(), response.status, url)
  }
  const text = await response.text()
  return { text, url: response.url }
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, {
    ...options,
    headers: { Accept: 'application/vnd.github+json', ...(options.headers ?? {}) }
  })
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${(error as Error).message}`)
  }
}

/**
 * Prepends a user-configured mirror/proxy prefix to a github.com download URL.
 * Only applied to asset downloads - the GitHub API is left alone because most
 * mirrors do not proxy it.
 */
export function applyMirror(url: string, mirror: string): string {
  const prefix = mirror.trim()
  if (prefix === '') return url
  if (!url.startsWith('https://github.com/')) return url
  return `${prefix.replace(/\/+$/, '')}/${url}`
}

/** Turns an HTTP failure into a short, user-presentable message. */
export function describeHttpError(error: unknown, url: string): string {
  if (error instanceof HttpError) {
    if (error.status === 403) return `Rate limited or forbidden by ${error.url}`
    if (error.status === 404) return `Not found: ${error.url}`
    return `${error.message} (${error.url})`
  }
  const message = error instanceof Error ? error.message : String(error)
  return `${message} (${url})`
}
