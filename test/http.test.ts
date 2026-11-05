/**
 * HTTP mode: spawn `build/index.js http` against a fake Quickbase and drive it
 * with the official MCP client over Streamable HTTP, in both protocol eras.
 * Also checks the loopback-only guards. Run `npm run build` first (npm test does).
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostName, HttpStartError, parsePort, rejectReason, serveHttp } from '../src/http-server.js';
import { silentLogger } from '../src/logger.js';
import { APP_ID, DEFECTS, REALM, startFakeQuickbase, TOKEN } from './helpers/fake-quickbase.js';

const SERVER = fileURLToPath(new URL('../build/index.js', import.meta.url));

let fake: Awaited<ReturnType<typeof startFakeQuickbase>>;
let workspace: string;

function serverEnv(): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    HOME: workspace,
    QB_REALM: REALM,
    QB_USER_TOKEN: TOKEN,
    QB_APP_ID: APP_ID,
    QB_API_BASE_URL: `${fake.url}/v1`,
    QB_XML_BASE_URL: fake.url,
    QB_WORKSPACE: workspace,
    QB_LOG_LEVEL: 'warn',
  };
}

/** Start `quickbase-mcp http` and resolve with its URL once it prints it. */
function startHttpServer(args: string[] = ['--port', '0']): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [SERVER, 'http', ...args], { env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}\n${err}`)), 20_000);
    child.stdout?.on('data', (d) => {
      out += String(d);
      const m = out.match(/running at (http:\/\/localhost:\d+\/mcp)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1] });
      }
    });
    child.stderr?.on('data', (d) => (err += String(d)));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${out}\n${err}`));
    });
  });
}

/** A raw request, so tests can set Host and Origin headers that fetch would not let them forge. */
function rawPost(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += String(d)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content.map((c) => c.text ?? '').join('\n');
}

let server: { child: ChildProcess; url: string };

beforeAll(async () => {
  fake = await startFakeQuickbase();
  workspace = mkdtempSync(join(tmpdir(), 'qbmcp-http-'));
  server = await startHttpServer();
});

afterAll(async () => {
  server?.child.kill();
  await fake?.close();
});

describe.each(['legacy', 'modern'] as const)('HTTP server (%s era)', (era) => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ name: 'http-test', version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  });
  afterAll(async () => {
    await client?.close();
  });

  it('lists the read-only tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['test_connection', 'get_schema_map', 'get_code_page', 'load_skill']));
    expect(names).not.toContain('deploy_code_page');
  });

  it('calls Quickbase through the tools', async () => {
    expect(textOf(await client.callTool({ name: 'test_connection', arguments: {} }))).toContain('Connection OK');
    expect(textOf(await client.callTool({ name: 'get_schema_map', arguments: {} }))).toContain(`## Defects — \`${DEFECTS}\``);
  });
});

describe('HTTP guards', () => {
  it('serves loopback host names', async () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const res = await rawPost(server.url, { host: `${host}:${new URL(server.url).port}` });
      expect(res.status, host).not.toBe(403);
    }
  });

  it('refuses other Host headers (DNS rebinding)', async () => {
    const res = await rawPost(server.url, { host: 'attacker.example:80' });
    expect(res.status).toBe(403);
    expect(res.body).toContain('only answers requests addressed to localhost');
  });

  it('refuses web-page origins but accepts loopback ones', async () => {
    const host = `localhost:${new URL(server.url).port}`;
    expect((await rawPost(server.url, { host, origin: 'https://attacker.example' })).status).toBe(403);
    expect((await rawPost(server.url, { host, origin: 'null' })).status).toBe(403);
    expect((await rawPost(server.url, { host, origin: 'http://localhost:6274' })).status).not.toBe(403);
  });

  it('answers 404 outside /mcp', async () => {
    const res = await rawPost(server.url.replace('/mcp', '/other'), { host: `localhost:${new URL(server.url).port}` });
    expect(res.status).toBe(404);
    expect(res.body).toContain('/mcp');
  });

  it('explains a port that is already in use', async () => {
    const port = new URL(server.url).port;
    const child = spawn(process.execPath, [SERVER, 'http', '--port', port], { env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d) => (err += String(d)));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(err).toContain(`Port ${port} is already in use`);
  });
});

describe('HTTP helpers', () => {
  it('parses ports', () => {
    expect(parsePort(undefined)).toBe(8080);
    expect(parsePort('9090')).toBe(9090);
    expect(() => parsePort('80a')).toThrow(HttpStartError);
    expect(() => parsePort('70000')).toThrow(HttpStartError);
  });

  it('extracts host names from Host headers', () => {
    expect(hostName('LOCALHOST:8080')).toBe('localhost');
    expect(hostName('[::1]:8080')).toBe('::1');
    expect(hostName('127.0.0.1')).toBe('127.0.0.1');
    expect(rejectReason({ host: 'localhost:8080' })).toBeNull();
    expect(rejectReason({})).toContain('not allowed');
    expect(rejectReason({ host: 'localhost:8080', origin: 'vscode-file://vscode-app' })).toBeNull();
  });

  it('never listens beyond loopback', async () => {
    await expect(serveHttp(() => {
      throw new Error('unused');
    }, { port: 0, logger: silentLogger, hosts: ['0.0.0.0'] })).rejects.toThrow(/only listens on this computer/);
  });
});
