/**
 * Streamable HTTP mode: the same MCP server, served at http://localhost:<port>/mcp.
 *
 * For organizations whose AI clients may only reach a local MCP server at a
 * fixed loopback URL, instead of launching one over stdio. The SDK's
 * createMcpHandler does the protocol work: 2026-07-28 clients are served per
 * request, and 2025-era clients through its stateless fallback (which answers
 * GET and DELETE with 405, as the spec allows).
 *
 * Safety:
 *  - It listens on loopback only (127.0.0.1 and ::1), never on the network,
 *    because every tool acts with the configured Quickbase token.
 *  - A request whose Host header is not a loopback name, or whose Origin is not
 *    a loopback origin, is refused with 403. That stops a web page from using
 *    DNS rebinding to drive the server from a browser. Desktop clients such as
 *    VS Code send no Origin header and are unaffected.
 */

import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server as NodeServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, DEFAULT_MAX_REQUEST_BODY_SIZE, type McpServerFactory } from '@modelcontextprotocol/server';
import type { Logger } from './logger.js';

export const DEFAULT_HTTP_PORT = 8080;
export const MCP_PATH = '/mcp';

/** Host names that resolve to this computer only. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** VS Code's own window. Web pages cannot claim this origin. */
const EDITOR_ORIGINS = new Set(['vscode-file://vscode-app']);

export interface HttpServeOptions {
  /** TCP port; 0 picks a free one (tests). */
  port: number;
  logger: Logger;
  /** Addresses to listen on. Defaults to loopback only; anything else is refused. */
  hosts?: string[];
}

export interface RunningHttpServer {
  /** The URL clients connect to, e.g. http://localhost:8080/mcp. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export class HttpStartError extends Error {}

/** Parse `--port <n>` / QB_HTTP_PORT. */
export function parsePort(value: string | undefined, fallback = DEFAULT_HTTP_PORT): number {
  if (value === undefined || value.trim() === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new HttpStartError(`Invalid port "${value}". Use a number from 1 to 65535.`);
  }
  return port;
}

/** Host header ("localhost:8080", "[::1]:8080") -> lowercase host name without port or brackets. */
export function hostName(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h.slice(1) : h.slice(1, end);
  }
  const colon = h.lastIndexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/** Why a request must be refused before it reaches the MCP handler, or null to let it through. */
export function rejectReason(headers: IncomingMessage['headers']): string | null {
  const host = headers.host;
  if (!host || !LOOPBACK_HOSTS.has(hostName(host))) {
    return `Host "${host ?? ''}" is not allowed. This server only answers requests addressed to localhost.`;
  }
  const origin = headers.origin;
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    return `Origin "${origin}" is not allowed. Web pages may not call this server.`;
  }
  return null;
}

function isAllowedOrigin(origin: string): boolean {
  if (EDITOR_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false; // includes the literal "null" origin of sandboxed pages and file://
  }
}

export async function serveHttp(factory: McpServerFactory, opts: HttpServeOptions): Promise<RunningHttpServer> {
  const hosts = opts.hosts ?? ['127.0.0.1', '::1'];
  const nonLoopback = hosts.filter((h) => !LOOPBACK_HOSTS.has(h));
  if (nonLoopback.length) {
    throw new HttpStartError(`Refusing to listen on ${nonLoopback.join(', ')}: this server only listens on this computer (loopback).`);
  }

  const handler = createMcpHandler(factory, {
    onerror: (error) => opts.logger.debug('MCP HTTP request rejected or failed', error),
  });

  let port = opts.port;
  const servers: NodeServer[] = [];
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, handler.fetch, port, opts.logger).catch((err) => {
      opts.logger.error('HTTP request failed', err);
      if (!res.headersSent) sendText(res, 500, 'Internal server error.');
      else res.destroy();
    });
  };

  try {
    for (const host of hosts) {
      const server = createServer(listener);
      try {
        await listen(server, port, host);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ::1 is optional: some machines have IPv6 switched off.
        if (host === '::1' && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) {
          opts.logger.debug('IPv6 loopback unavailable; listening on 127.0.0.1 only');
          continue;
        }
        if (code === 'EADDRINUSE') {
          throw new HttpStartError(
            `Port ${port} is already in use on this computer. Another program, or another copy of this server, is listening on it. Stop it first, or choose another port with --port.`,
          );
        }
        throw err;
      }
      servers.push(server);
      // With port 0 the first listener picks the port; the others reuse it.
      if (port === 0) port = (server.address() as AddressInfo).port;
    }
  } catch (err) {
    await Promise.all(servers.map(closeServer));
    await handler.close();
    throw err;
  }

  return {
    url: `http://localhost:${port}${MCP_PATH}`,
    port,
    close: async () => {
      await handler.close();
      await Promise.all(servers.map(closeServer));
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  fetchMcp: (request: Request) => Promise<Response>,
  port: number,
  logger: Logger,
): Promise<void> {
  const refused = rejectReason(req.headers);
  if (refused) {
    logger.warn(`Refused ${req.method} ${req.url}: ${refused}`);
    sendText(res, 403, refused);
    return;
  }

  const path = (req.url ?? '/').split('?')[0];
  if (path !== MCP_PATH && path !== `${MCP_PATH}/`) {
    sendText(res, 404, `Not found. The MCP endpoint is http://localhost:${port}${MCP_PATH}`);
    return;
  }

  // Abort the MCP exchange if the client goes away mid-response.
  const aborter = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) aborter.abort();
  });

  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const read = await readBody(req, DEFAULT_MAX_REQUEST_BODY_SIZE);
    if (read === null) {
      sendText(res, 413, 'Request body too large.');
      return;
    }
    body = read;
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const request = new Request(`http://localhost:${port}${req.url ?? MCP_PATH}`, {
    method: req.method,
    headers,
    body: body && body.length ? new Uint8Array(body) : undefined,
    signal: aborter.signal,
  });

  const response = await fetchMcp(request);
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  res.flushHeaders();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
      if (res.destroyed) break;
    }
  } finally {
    // Client gone: stop the stream (e.g. an open SSE subscription) instead of leaving it running.
    if (res.destroyed) await reader.cancel().catch(() => {});
    reader.releaseLock();
    if (!res.destroyed) res.end();
  }
}

/** Read the request body, or null if it is larger than `limit` bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > limit) {
      req.resume();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${text}\n`);
}

function listen(server: NodeServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: NodeServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
