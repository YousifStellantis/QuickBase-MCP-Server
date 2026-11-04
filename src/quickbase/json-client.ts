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

function describeNetworkError(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'AbortError') return `request timed out after ${timeoutMs} ms (corporate proxy or firewall? set HTTPS_PROXY / NODE_EXTRA_CA_CERTS)`;
  const code = e?.cause?.code;
  if (code === 'ENOTFOUND') return 'DNS lookup failed; check the network or proxy settings';
  if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
    return 'TLS certificate not trusted (corporate TLS inspection?). Point NODE_EXTRA_CA_CERTS at your corporate root CA bundle.';
  }
  return e?.cause?.message ?? e?.message ?? String(err);
}

async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore */
  }
}
