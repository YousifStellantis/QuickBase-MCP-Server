/**
 * Quickbase JSON RESTful API client (https://api.quickbase.com/v1).
 *
 * Retry policy:
 *  - 429: always retried (the request was not processed), honoring Retry-After.
 *  - 5xx / network errors: retried only for idempotent calls. An upsert that
 *    timed out may already have been applied, and retrying it blindly can
 *    create duplicate records.
 */

import type { Logger } from '../logger.js';
import { redact, silentLogger } from '../logger.js';
import { QuickbaseApiError } from './errors.js';
import type { FetchLike } from './http.js';
import type { RateLimiter } from './rate-limiter.js';

export interface JsonClientOptions {
  realm: string;
  userToken: string;
  baseUrl: string;
  limiter: RateLimiter;
  timeoutMs: number;
  userAgent: string;
  fetchImpl: FetchLike;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export interface JsonRequest {
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON-serialized request body. */
  body?: unknown;
  /** Raw text body (e.g. QBL YAML). Takes precedence over `body`. */
  text?: string;
  contentType?: string;
  accept?: string;
  headers?: Record<string, string>;
  /** Safe to retry on 5xx/network errors. Defaults to true for GET. */
  idempotent?: boolean;
  /** Return the body as raw bytes instead of parsing it. */
  binary?: boolean;
}

export interface JsonResponse<T> {
  status: number;
  data: T;
  headers: Headers;
  contentType: string;
  bytes?: Uint8Array;
}

export class QuickbaseJsonClient {
  readonly realm: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(private readonly opts: JsonClientOptions) {
    this.realm = opts.realm;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = opts.logger ?? silentLogger;
  }

  get<T = unknown>(path: string, req: JsonRequest = {}) {
    return this.request<T>('GET', path, req);
  }
  post<T = unknown>(path: string, req: JsonRequest = {}) {
    return this.request<T>('POST', path, req);
  }
  put<T = unknown>(path: string, req: JsonRequest = {}) {
    return this.request<T>('PUT', path, req);
  }
  patch<T = unknown>(path: string, req: JsonRequest = {}) {
    return this.request<T>('PATCH', path, req);
  }
  delete<T = unknown>(path: string, req: JsonRequest = {}) {
    return this.request<T>('DELETE', path, req);
  }

  async request<T = unknown>(method: string, path: string, req: JsonRequest = {}): Promise<JsonResponse<T>> {
    const url = new URL(this.opts.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      'QB-Realm-Hostname': this.opts.realm,
      Authorization: `QB-USER-TOKEN ${this.opts.userToken}`,
      'User-Agent': this.opts.userAgent,
      Accept: req.accept ?? 'application/json',
      ...req.headers,
    };

    let body: string | undefined;
    if (req.text !== undefined) {
      body = req.text;
      headers['Content-Type'] = req.contentType ?? 'text/plain';
    } else if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers['Content-Type'] = req.contentType ?? 'application/json';
    }

    const idempotent = req.idempotent ?? method === 'GET';

    for (let attempt = 0; ; attempt++) {
      await this.opts.limiter.acquire();
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url, { method, headers, body });
      } catch (err) {
        if (idempotent && attempt < this.maxRetries) {
          this.logger.debug(`${method} ${path} network error, retrying`, err);
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(this.scrub(`${method} ${path}: ${describeNetworkError(err, this.opts.timeoutMs)}`));
      }

      if (res.status === 429 && attempt < this.maxRetries) {
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt);
        this.logger.warn(`${method} ${path} rate limited; waiting ${wait} ms`);
        await drain(res);
        await this.sleep(wait);
        continue;
      }
      if (res.status >= 500 && idempotent && attempt < this.maxRetries) {
        this.logger.warn(`${method} ${path} returned ${res.status}; retrying`);
        await drain(res);
        await this.sleep(backoffMs(attempt));
        continue;
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (req.binary && res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, data: undefined as T, headers: res.headers, contentType, bytes };
      }

      const raw = await res.text();
      let data: unknown = raw;
      if (raw && (contentType.includes('json') || /^\s*[[{]/.test(raw))) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
      } else if (!raw) {
        data = null;
      }

      if (!res.ok) throw this.toError(method, path, res.status, data, raw);
      return { status: res.status, data: data as T, headers: res.headers, contentType };
    }
  }

  /**
   * Run a records query and follow pagination until `maxRecords` rows are
   * collected or the table is exhausted.
   */
  async queryAll(
    body: Record<string, unknown>,
    maxRecords: number,
  ): Promise<{ data: Array<Record<string, { value: unknown }>>; fields: Array<{ id: number; label: string; type: string }>; totalRecords: number }> {
    const options = (body.options as Record<string, unknown> | undefined) ?? {};
    let skip = Number(options.skip ?? 0);
    const rows: Array<Record<string, { value: unknown }>> = [];
    let fields: Array<{ id: number; label: string; type: string }> = [];
    let total = 0;

    while (rows.length < maxRecords) {
      const top = Math.min(1000, maxRecords - rows.length);
      const res = await this.post<{
        data: Array<Record<string, { value: unknown }>>;
        fields: Array<{ id: number; label: string; type: string }>;
        metadata: { totalRecords: number; numRecords: number; skip: number };
      }>('/records/query', { body: { ...body, options: { ...options, skip, top } }, idempotent: true });
      const page = res.data;
      if (fields.length === 0) fields = page.fields ?? [];
      total = page.metadata?.totalRecords ?? total;
      rows.push(...(page.data ?? []));
      const got = page.metadata?.numRecords ?? page.data?.length ?? 0;
      skip += got;
      if (got === 0 || skip >= total) break;
    }
    return { data: rows, fields, totalRecords: total };
  }

  private async fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await this.opts.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private toError(method: string, path: string, status: number, data: unknown, raw: string): QuickbaseApiError {
    let message = `HTTP ${status}`;
    let description: string | undefined;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      if (typeof d.message === 'string') message = d.message;
      if (typeof d.description === 'string') description = d.description;
      else if (Array.isArray(d.errors)) description = d.errors.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('; ');
    } else if (raw) {
      description = raw.slice(0, 500);
    }
    return new QuickbaseApiError({
      status,
      method,
      path,
      message: this.scrub(`${method} ${path} -> ${status} ${message}`),
      description: description ? this.scrub(description) : undefined,
      body: data,
    });
  }

  private scrub(text: string): string {
    return redact(text, [this.opts.userToken]);
  }
}

export function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/** Retry-After is either delta-seconds or an HTTP date. Capped at 30 s. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  return undefined;
}

export function describeNetworkError(err: unknown, timeoutMs: number, env: Record<string, string | undefined> = process.env): string {
  // undici nests the real reason (proxy refusal, DNS, TLS) a few `cause` levels down.
  const chain: Array<{ name?: string; code?: unknown; message?: string; hostname?: unknown }> = [];
  for (let c = err as { cause?: unknown } | undefined, i = 0; c && i < 6; c = c.cause as typeof c, i++) chain.push(c as never);
  const messages = chain.map((e) => e.message ?? '');
  const proxy = messages.join(' ').match(/Proxy response \((\d{3})\)/);
  if (proxy) {
    return proxy[1] === '407'
      ? 'the HTTPS proxy requires authentication (HTTP 407); put credentials in HTTPS_PROXY (http://user:password@proxy:port)'
      : `the HTTPS proxy refused the connection (HTTP ${proxy[1]}): this Quickbase host is not allowed through HTTPS_PROXY. Ask IT to allow it, or bypass the proxy with NO_PROXY`;
  }
  const top = chain[0];
  if (top?.name === 'AbortError' || top?.name === 'TimeoutError') {
    return `request timed out after ${timeoutMs} ms (corporate proxy or firewall? set HTTPS_PROXY / NODE_EXTRA_CA_CERTS)`;
  }
  const code = chain.map((e) => e.code).find((x): x is string => typeof x === 'string' && x.length > 0);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    const host =
      chain.map((e) => e.hostname).find((h): h is string => typeof h === 'string' && h.length > 0) ??
      messages.join(' ').match(/(?:ENOTFOUND|EAI_AGAIN) (\S+)/)?.[1];
    return describeDnsFailure(host, env);
  }
  if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return 'TLS certificate not trusted (corporate TLS inspection?). Point NODE_EXTRA_CA_CERTS at your corporate root CA bundle.';
  }
  const deepest = [...messages].reverse().find(Boolean);
  if (deepest && deepest !== messages[0]) return `${messages[0] || 'fetch failed'}: ${deepest}${code ? ` (${code})` : ''}`;
  return messages[0] || String(err);
}

/**
 * Say which name could not be resolved, and whether a proxy was in play. With
 * a proxy, undici only resolves the proxy's own name, so a failure there means
 * the proxy is unreachable (off the company network or VPN), not Quickbase.
 */
function describeDnsFailure(host: string | undefined, env: Record<string, string | undefined>): string {
  const target = host ?? 'the Quickbase host';
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!raw) {
    return `DNS lookup failed for ${target}, and no proxy is set for this server (HTTPS_PROXY is not in its environment). On a corporate network, add HTTPS_PROXY to the server's environment in your MCP client`;
  }
  let proxy = raw;
  try {
    const u = new URL(raw);
    proxy = u.port ? `${u.hostname}:${u.port}` : u.hostname; // never echo credentials
  } catch {
    proxy = '(unparseable HTTPS_PROXY value)';
  }
  if (host && proxy.split(':')[0] === host.toLowerCase()) {
    return `DNS lookup failed for the proxy ${host} (from HTTPS_PROXY): this computer can't find it. Check that you're on the company network or VPN, and that the proxy address is right`;
  }
  return `DNS lookup failed for ${target} although HTTPS_PROXY is set (${proxy}); check NO_PROXY, which may send this host around the proxy`;
}

async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore */
  }
}
