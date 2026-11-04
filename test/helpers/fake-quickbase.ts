/**
 * In-process fake of the Quickbase JSON and XML APIs, enough for end-to-end
 * tests of the MCP server over stdio. It enforces the realm and token headers
 * so a broken auth path fails the tests.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const REALM = 'demo.quickbase.com';
export const TOKEN = 'b5grq7_jxdx_0_e2etesttokenxxxxxxxxxxxx';
export const APP_ID = 'bqapp0001';
export const DEFECTS = 'bqdef0001';

export interface FakeState {
  pages: Map<number, string>;
  nextPageId: number;
  requests: Array<{ method: string; path: string; action?: string }>;
}

const FIELDS = [
  { id: 1, label: 'Date Created', fieldType: 'timestamp', mode: '' },
  { id: 3, label: 'Record ID#', fieldType: 'recordid', mode: '', properties: { primaryKey: true } },
  { id: 6, label: 'Line', fieldType: 'text', mode: '', required: true },
  { id: 7, label: 'Status', fieldType: 'text-multiple-choice', mode: '', properties: { choices: ['Open', 'Contained', 'Closed'] } },
  { id: 8, label: 'Quantity', fieldType: 'numeric', mode: '' },
  { id: 9, label: 'Days Open', fieldType: 'numeric', mode: 'formula', properties: { formula: 'ToDays(Today() - ToDate([Date Created]))' } },
];

const ROWS = Array.from({ length: 7 }, (_, i) => ({
  '3': { value: 100 + i },
  '6': { value: `Line ${1 + (i % 2)}` },
  '7': { value: i % 3 === 0 ? 'Closed' : 'Open' },
  '8': { value: i + 1 },
}));

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function xmlOk(inner = '') {
  return `<?xml version="1.0" ?>\n<qdbapi><action>x</action><errcode>0</errcode><errtext>No error</errtext>${inner}</qdbapi>`;
}

function unsplit(s: string) {
  return s.split(']]]]><![CDATA[>').join(']]>');
}

export async function startFakeQuickbase(): Promise<{ url: string; state: FakeState; close: () => Promise<void> }> {
  const state: FakeState = {
    pages: new Map([[12, '<!DOCTYPE html>\n<html><head><title>Line board</title></head><body>v1</body></html>\n']]),
    nextPageId: 13,
    requests: [],
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = await readBody(req);

    // XML API
    if (url.pathname.startsWith('/db/')) {
      const action = String(req.headers['quickbase-action'] ?? '');
      state.requests.push({ method: req.method ?? '', path: url.pathname, action });
      if (!body.includes(`<usertoken>${TOKEN}</usertoken>`)) {
        return send(res, 200, '<qdbapi><errcode>4</errcode><errtext>User not authorized</errtext></qdbapi>', 'text/xml');
      }
      if (action === 'API_GetUserInfo') {
        return send(res, 200, xmlOk('<user id="5883.e2e"><firstName>Test</firstName><lastName>Engineer</lastName><login>t.e</login><email>test.engineer@example.com</email></user>'), 'text/xml');
      }
      if (action === 'API_GrantedDBs') {
        return send(res, 200, xmlOk(`<databases><dbinfo><dbname>Plant Quality</dbname><dbid>${APP_ID}</dbid></dbinfo></databases>`), 'text/xml');
      }
      if (action === 'API_GetDBPage') {
        const id = Number(body.match(/<pageID>([^<]+)<\/pageID>/)?.[1]);
        const page = state.pages.get(id);
        if (!page) return send(res, 200, '<qdbapi><errcode>2</errcode><errtext>Invalid input</errtext><errdetail>No such page</errdetail></qdbapi>', 'text/xml');
        return send(res, 200, page, 'text/html');
      }
      if (action === 'API_AddReplaceDBPage') {
        const id = body.match(/<pageid>([^<]+)<\/pageid>/)?.[1];
        const content = unsplit(body.match(/<pagebody><!\[CDATA\[([\s\S]*)\]\]><\/pagebody>/)?.[1] ?? '');
        const pageId = id ? Number(id) : state.nextPageId++;
        state.pages.set(pageId, content);
        return send(res, 200, xmlOk(`<pageID>${pageId}</pageID>`), 'text/xml');
      }
      return send(res, 200, '<qdbapi><errcode>5</errcode><errtext>Unimplemented in fake</errtext></qdbapi>', 'text/xml');
    }

    // JSON API
    state.requests.push({ method: req.method ?? '', path: url.pathname });
    if (req.headers['qb-realm-hostname'] !== REALM || req.headers.authorization !== `QB-USER-TOKEN ${TOKEN}`) {
      return send(res, 401, { message: 'Unauthorized', description: 'bad token or realm' });
    }
    const p = url.pathname.replace(/^\/v1/, '');
    if (req.method === 'GET' && p === `/apps/${APP_ID}`) return send(res, 200, { id: APP_ID, name: 'Plant Quality', timeZone: '(UTC-05:00) Eastern', dateFormat: 'YYYY-MM-DD', variables: [{ name: 'TargetFTT', value: '92' }] });
    if (req.method === 'GET' && p === '/tables' && url.searchParams.get('appId') === APP_ID) {
      return send(res, 200, [{ id: DEFECTS, name: 'Defects', alias: '_DBID_DEFECTS', keyFieldId: 3, singleRecordName: 'Defect', pluralRecordName: 'Defects', nextRecordId: 107 }]);
    }
    if (req.method === 'GET' && p === `/tables/${DEFECTS}`) return send(res, 200, { id: DEFECTS, name: 'Defects', keyFieldId: 3 });
    if (req.method === 'GET' && p === '/fields') {
      return url.searchParams.get('tableId') === DEFECTS ? send(res, 200, FIELDS) : send(res, 404, { message: 'Not Found', description: 'Table not found' });
    }
    if (req.method === 'GET' && p === `/tables/${DEFECTS}/relationships`) return send(res, 200, { relationships: [], metadata: { numRelationships: 0, skip: 0, totalRelationships: 0 } });
    if (req.method === 'POST' && p === '/records/query') {
      const q = JSON.parse(body);
      if (q.from !== DEFECTS) return send(res, 404, { message: 'Not Found', description: 'Table not found' });
      const select: number[] = q.select ?? [3, 6, 7];
      const skip = q.options?.skip ?? 0;
      const top = q.options?.top ?? 100;
      const page = ROWS.slice(skip, skip + top).map((r) => Object.fromEntries(select.map((fid) => [String(fid), (r as Record<string, { value: unknown }>)[String(fid)] ?? { value: null }])));
      return send(res, 200, {
        data: page,
        fields: select.map((fid) => ({ id: fid, label: FIELDS.find((f) => f.id === fid)?.label ?? `f${fid}`, type: FIELDS.find((f) => f.id === fid)?.fieldType ?? 'text' })),
        metadata: { totalRecords: ROWS.length, numRecords: page.length, numFields: select.length, skip },
      });
    }
    if (req.method === 'POST' && p === '/formula/run') return send(res, 200, { result: '42' });
    return send(res, 404, { message: 'Not Found', description: `No fake route for ${req.method} ${p}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
