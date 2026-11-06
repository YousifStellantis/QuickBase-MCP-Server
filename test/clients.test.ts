import { describe, expect, it } from 'vitest';
import { QuickbaseApiError, QuickbaseXmlError } from '../src/quickbase/errors.js';
import type { FetchLike } from '../src/quickbase/http.js';
import { QuickbaseJsonClient, retryAfterMs } from '../src/quickbase/json-client.js';
import { SlidingWindowLimiter, unlimited } from '../src/quickbase/rate-limiter.js';
import { escapeCdata, stripCdata, unsplitCdata } from '../src/quickbase/xml.js';
import { QuickbaseXmlClient } from '../src/quickbase/xml-client.js';

const TOKEN = 'b5grq7_jxdx_0_bqxxxxxxxxxxxxxxxxxxxxxx';
const noSleep = async () => {};

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn: FetchLike = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return handler(String(input), init);
  };
  return { fn, calls };
}

function jsonClient(fetchImpl: FetchLike) {
  return new QuickbaseJsonClient({
    realm: 'demo.quickbase.com',
    userToken: TOKEN,
    baseUrl: 'https://api.quickbase.com/v1',
    limiter: unlimited,
    timeoutMs: 5000,
    userAgent: 'test',
    fetchImpl,
    sleep: noSleep,
  });
}

describe('QuickbaseJsonClient', () => {
  it('sends realm, auth and user-agent headers and query params', async () => {
    const f = fakeFetch(() => Response.json([{ id: 'bq1', name: 'T' }]));
    const res = await jsonClient(f.fn).get('/tables', { query: { appId: 'bqapp', skip: undefined } });
    expect(res.data).toEqual([{ id: 'bq1', name: 'T' }]);
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(f.calls[0].url).toBe('https://api.quickbase.com/v1/tables?appId=bqapp');
    expect(headers['QB-Realm-Hostname']).toBe('demo.quickbase.com');
    expect(headers.Authorization).toBe(`QB-USER-TOKEN ${TOKEN}`);
    expect(headers['User-Agent']).toBe('test');
  });

  it('retries 429 using Retry-After, for any method', async () => {
    let n = 0;
    const f = fakeFetch(() => (++n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }) : Response.json({ ok: true })));
    const res = await jsonClient(f.fn).post('/records', { body: { to: 'x', data: [] } });
    expect(res.data).toEqual({ ok: true });
    expect(f.calls).toHaveLength(2);
  });

  it('retries 5xx for idempotent calls but not for writes', async () => {
    const f1 = fakeFetch(() => new Response('boom', { status: 503 }));
    await expect(jsonClient(f1.fn).post('/records', { body: {} })).rejects.toBeInstanceOf(QuickbaseApiError);
    expect(f1.calls).toHaveLength(1);

    let n = 0;
    const f2 = fakeFetch(() => (++n < 3 ? new Response('boom', { status: 502 }) : Response.json({ fine: 1 })));
    const res = await jsonClient(f2.fn).get('/apps/x');
    expect(res.data).toEqual({ fine: 1 });
    expect(f2.calls).toHaveLength(3);
  });

  it('maps Quickbase error bodies and redacts the token', async () => {
    const f = fakeFetch(() => Response.json({ message: 'Bad Request', description: `token ${TOKEN} is invalid` }, { status: 400 }));
    const err = (await jsonClient(f.fn).get('/fields').catch((e) => e)) as QuickbaseApiError;
    expect(err).toBeInstanceOf(QuickbaseApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('Bad Request');
    expect(err.description).toContain('[REDACTED]');
    expect(err.description).not.toContain(TOKEN);
    expect(err.hint).toMatch(/field IDs/);
  });

  it('queryAll follows skip/top pagination', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => ({ '3': { value: i + 1 } }));
    const f = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      const page = all.slice(body.options.skip, body.options.skip + body.options.top);
      return Response.json({ data: page, fields: [{ id: 3, label: 'Record ID#', type: 'recordid' }], metadata: { totalRecords: all.length, numRecords: page.length, skip: body.options.skip } });
    });
    const res = await jsonClient(f.fn).queryAll({ from: 'bq1' }, 2200);
    expect(res.data).toHaveLength(2200);
    expect(res.totalRecords).toBe(2500);
    expect(f.calls).toHaveLength(3);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('999')).toBe(30_000);
  });
});

describe('XML helpers', () => {
  it('round-trips page bodies containing ]]>', () => {
    const body = 'const re = /a]]>b/; // CDATA terminator inside code';
    const wrapped = `<![CDATA[${escapeCdata(body)}]]>`;
    expect(stripCdata(wrapped)).toBe(body);
    expect(unsplitCdata(escapeCdata(body))).toBe(body);
  });
});

describe('QuickbaseXmlClient', () => {
  const make = (fetchImpl: FetchLike) =>
    new QuickbaseXmlClient({ realm: 'demo.quickbase.com', userToken: TOKEN, limiter: unlimited, timeoutMs: 5000, userAgent: 'test', fetchImpl, sleep: noSleep });

  it('throws on non-zero errcode even with HTTP 200', async () => {
    const f = fakeFetch(() => new Response('<qdbapi><action>API_GetDBPage</action><errcode>24</errcode><errtext>Invalid Application Token</errtext></qdbapi>'));
    const err = (await make(f.fn).getPage('bqapp', 3).catch((e) => e)) as QuickbaseXmlError;
    expect(err).toBeInstanceOf(QuickbaseXmlError);
    expect(err.code).toBe(24);
    expect(err.isAuthError).toBe(true);
  });

  it('reads pages returned bare or inside a pagebody envelope', async () => {
    const bare = fakeFetch(() => new Response('<!DOCTYPE html><html><body>Hi</body></html>'));
    expect(await make(bare.fn).getPage('bqapp', 3)).toContain('<body>Hi</body>');
    const wrapped = fakeFetch(() => new Response(`<?xml version="1.0"?><qdbapi><errcode>0</errcode><pagebody><![CDATA[${escapeCdata('<p>a]]>b</p>')}]]></pagebody></qdbapi>`));
    expect(await make(wrapped.fn).getPage('bqapp', 3)).toBe('<p>a]]>b</p>');
  });

  it('sends the action header, user token and CDATA-escaped body on putPage', async () => {
    const f = fakeFetch(() => new Response('<qdbapi><errcode>0</errcode><pageID>17</pageID></qdbapi>'));
    const id = await make(f.fn).putPage('bqapp', { pageName: 'KPI.html', body: 'x ]]> y' });
    expect(id).toBe('17');
    const headers = f.calls[0].init.headers as Record<string, string>;
    expect(headers['QUICKBASE-ACTION']).toBe('API_AddReplaceDBPage');
    expect(f.calls[0].url).toBe('https://demo.quickbase.com/db/bqapp');
    const body = String(f.calls[0].init.body);
    expect(body).toContain('<pagename>KPI.html</pagename>');
    expect(body).toContain(`<usertoken>${TOKEN}</usertoken>`);
    expect(body).toContain(']]]]><![CDATA[>');
  });

  it('parses API_GrantedDBs and API_GetUserInfo', async () => {
    const f = fakeFetch((_u, init) => {
      const action = (init.headers as Record<string, string>)['QUICKBASE-ACTION'];
      if (action === 'API_GrantedDBs') {
        return new Response('<qdbapi><errcode>0</errcode><databases><dbinfo><dbname>Plant &amp; Skills</dbname><dbid>bqh6r2kxa</dbid></dbinfo><dbinfo><dbname>KPI</dbname><dbid>bqh7c5d8n</dbid><ancestorappid>bqh6r2kxa</ancestorappid></dbinfo></databases></qdbapi>');
      }
      return new Response('<qdbapi><errcode>0</errcode><user id="5883.abcd"><firstName>Jordan</firstName><lastName>Lee</lastName><email>j@example.com</email></user></qdbapi>');
    });
    const client = make(f.fn);
    expect(await client.grantedDbs()).toEqual([
      { dbid: 'bqh6r2kxa', name: 'Plant & Skills', ancestorAppId: undefined, oldestAncestorAppId: undefined },
      { dbid: 'bqh7c5d8n', name: 'KPI', ancestorAppId: 'bqh6r2kxa', oldestAncestorAppId: undefined },
    ]);
    const user = await client.getUserInfo();
    expect(user).toMatchObject({ id: '5883.abcd', firstName: 'Jordan', email: 'j@example.com' });
  });
});

describe('SlidingWindowLimiter', () => {
  it('waits once the window is full', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new SlidingWindowLimiter(2, 10_000, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(10_000);
  });
});

describe('describeNetworkError', () => {
  it('explains proxy refusals, timeouts and DNS failures', async () => {
    const { describeNetworkError } = await import('../src/quickbase/json-client.js');
    const proxy = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('Request was cancelled.'), { cause: Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { name: 'AbortError', code: 'UND_ERR_ABORTED' }) }),
    });
    expect(describeNetworkError(proxy, 1000)).toContain('proxy refused the connection (HTTP 403)');
    expect(describeNetworkError(Object.assign(new Error('x'), { cause: new Error('Proxy response (407) !== 200') }), 1000)).toContain('requires authentication');
    expect(describeNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 5000)).toContain('timed out after 5000 ms');
    expect(describeNetworkError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) }), 1)).toContain('DNS lookup failed');
  });

  it('names the host that could not be found, and whether it was the proxy', async () => {
    const { describeNetworkError } = await import('../src/quickbase/json-client.js');
    const dns = (host: string) =>
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host }) });
    expect(describeNetworkError(dns('acme.quickbase.com'), 1, {})).toContain('DNS lookup failed for acme.quickbase.com, and no proxy is set');
    const viaProxy = describeNetworkError(dns('proxy.example.com'), 1, { HTTPS_PROXY: 'http://user:secret@proxy.example.com:8080' });
    expect(viaProxy).toContain('DNS lookup failed for the proxy proxy.example.com');
    expect(viaProxy).toContain('VPN');
    expect(viaProxy).not.toContain('secret');
    const bypassed = describeNetworkError(dns('acme.quickbase.com'), 1, { https_proxy: 'http://user:secret@proxy.example.com:8080' });
    expect(bypassed).toContain('although HTTPS_PROXY is set (proxy.example.com:8080)');
    expect(bypassed).not.toContain('secret');
  });
});
