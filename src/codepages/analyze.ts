/**
 * Static review of a Quickbase code page.
 *
 * Finds every table ID and field ID the page depends on (so they can be
 * checked against the live schema), and flags the mistakes that hurt most in
 * production: user tokens embedded in a page every app user can read,
 * unpinned CDN scripts, and hardcoded IDs that break after a solution install.
 */

import type { QbField } from '../quickbase/types.js';
import { normalizeLabel } from '../quickbase/schema.js';
import { findPlaceholders, readStamp } from './build.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  line?: number;
}

export interface StaticAnalysis {
  bytes: number;
  lines: number;
  title: string | null;
  stamp: ReturnType<typeof readStamp>;
  dbids: Array<{ id: string; names: string[]; count: number; firstLine: number }>;
  fidConstants: Array<{ name: string; fid: number; line: number }>;
  queryFieldIds: number[];
  selectFieldIds: number[];
  placeholders: string[];
  realmHosts: string[];
  externalScripts: Array<{ src: string; pinned: boolean; sri: boolean }>;
  externalFetchHosts: string[];
  usesTempToken: boolean;
  findings: Finding[];
}

const QUERY_OPS = 'EX|XEX|CT|XCT|SW|XSW|BF|OBF|AF|OAF|IR|XIR|TV|XTV|LT|LTE|GT|GTE|HAS|XHAS|EQ';
const NON_REALM_HOSTS = new Set(['api.quickbase.com', 'www.quickbase.com', 'help.quickbase.com', 'helpv2.quickbase.com', 'developer.quickbase.com', 'community.quickbase.com']);

function lineOf(source: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

export function analyzeCodePage(source: string): StaticAnalysis {
  const findings: Finding[] = [];
  const dbidMap = new Map<string, { names: Set<string>; count: number; firstLine: number }>();
  const addDbid = (id: string, name: string | null, index: number) => {
    const e = dbidMap.get(id) ?? { names: new Set<string>(), count: 0, firstLine: lineOf(source, index) };
    if (name) e.names.add(name);
    e.count++;
    dbidMap.set(id, e);
  };

  // Named constants: const DBID_COMP_DETAILS = "bqh6r4tz7"
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z0-9_$]*(?:DBID|TABLE|Table|Dbid|APP|App)[A-Za-z0-9_$]*)\s*=\s*["'`]([a-z0-9]{8,10})["'`]/g)) {
    addDbid(m[2], m[1], m.index ?? 0);
  }
  // URLs: /db/bqh6r2kxa
  for (const m of source.matchAll(/\/db\/([a-z0-9]{8,10})\b/g)) if (m[1] !== 'main') addDbid(m[1], null, m.index ?? 0);
  // API bodies: from: "b...", to: "b...", tableId=b..., appId: "b..."
  for (const m of source.matchAll(/\b(?:from|to|tableId|appId|dbid)["']?\s*[:=]\s*["'`]?(b[a-z0-9]{7,9})\b/g)) addDbid(m[1], null, m.index ?? 0);
  // Any other quoted dbid-looking literal that contains a digit (filters out words like "bluetooth").
  for (const m of source.matchAll(/["'`](b(?=[a-z0-9]*\d)[a-z0-9]{8})["'`]/g)) addDbid(m[1], null, m.index ?? 0);

  const fidConstants: StaticAnalysis['fidConstants'] = [];
  for (const m of source.matchAll(/(?:const|let|var)\s+(FID_[A-Za-z0-9_]+)\s*=\s*(\d+)\b/g)) {
    fidConstants.push({ name: m[1], fid: Number(m[2]), line: lineOf(source, m.index ?? 0) });
  }
  // fids: { firstName: 16, lastName: 17 }
  for (const block of source.matchAll(/\bfids\s*:\s*\{([^}]*)\}/g)) {
    for (const m of block[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(\d+)\b/g)) {
      fidConstants.push({ name: m[1], fid: Number(m[2]), line: lineOf(source, (block.index ?? 0) + (m.index ?? 0)) });
    }
  }

  const queryFieldIds = [...new Set([...source.matchAll(new RegExp(`\\{\\s*'?(\\d+)'?\\s*\\.\\s*(?:${QUERY_OPS})\\s*\\.`, 'g'))].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const selectFieldIds = [
    ...new Set([...source.matchAll(/\bselect\s*:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/\b(\d+)\b/g)].map((x) => Number(x[1])))),
  ].sort((a, b) => a - b);

  const realmHosts = [...new Set([...source.matchAll(/\b([a-z0-9-]+\.quickbase\.com)\b/gi)].map((m) => m[1].toLowerCase()))].filter((h) => !NON_REALM_HOSTS.has(h));

  const externalScripts: StaticAnalysis['externalScripts'] = [];
  for (const m of source.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const src = m[1];
    if (!/^(https?:)?\/\//i.test(src)) continue;
    const pinned = /@\d+(\.\d+){0,2}/.test(src) || /\/v?\d+\.\d+(\.\d+)?\//.test(src) || /[-.]\d+\.\d+(\.\d+)?(\.min)?\.js/.test(src);
    const sri = /\bintegrity\s*=/.test(m[0]);
    externalScripts.push({ src, pinned, sri });
    if (!pinned) findings.push({ severity: 'warning', code: 'unpinned-cdn', message: `Script ${src} has no pinned version; a CDN update can silently break the page.`, line: lineOf(source, m.index ?? 0) });
  }

  const externalFetchHosts = [
    ...new Set(
      [...source.matchAll(/\bfetch\(\s*["'`](https?:\/\/[^"'`/\s]+)/g)].map((m) => m[1].replace(/^https?:\/\//, '').toLowerCase()).filter((h) => !h.endsWith('quickbase.com')),
    ),
  ];

  // Security: a user token inside a code page is readable by every app user.
  const tokenLike = source.match(/\b[a-z0-9]{6}_[a-z0-9]{4}_\d{1,3}_[a-z0-9]{20,40}\b/i);
  if (tokenLike) {
    findings.push({
      severity: 'error',
      code: 'embedded-user-token',
      message: 'A string that looks like a Quickbase user token is embedded in the page. Anyone who can open the page can read it. Revoke it and use temporary tokens (GET /v1/auth/temporary/{dbid}) instead.',
      line: lineOf(source, tokenLike.index ?? 0),
    });
  }
  const userTokenHeader = source.search(/QB-USER-TOKEN/);
  if (userTokenHeader >= 0) {
    findings.push({
      severity: 'error',
      code: 'user-token-auth',
      message: 'The page authenticates with QB-USER-TOKEN. Code pages run in the browser as the signed-in user; use QB-TEMP-TOKEN from /v1/auth/temporary/{dbid} with credentials: "include".',
      line: lineOf(source, userTokenHeader),
    });
  }
  const usertokenParam = source.search(/[?&]usertoken=/i);
  if (usertokenParam >= 0) findings.push({ severity: 'error', code: 'usertoken-param', message: 'A usertoken= URL parameter is present. Tokens in URLs leak into logs and browser history.', line: lineOf(source, usertokenParam) });
  const apptoken = source.search(/apptoken/i);
  if (apptoken >= 0) findings.push({ severity: 'info', code: 'app-token', message: 'The page references an app token. App tokens are visible to page users; make sure that is intended.', line: lineOf(source, apptoken) });

  const usesTempToken = /\/auth\/temporary\//.test(source);
  if (/api\.quickbase\.com/.test(source) && !usesTempToken && userTokenHeader < 0) {
    findings.push({ severity: 'warning', code: 'no-temp-token', message: 'The page calls api.quickbase.com but never requests a temporary token. JSON API calls from a code page need QB-TEMP-TOKEN.' });
  }
  if (usesTempToken && !/credentials\s*:\s*["']include["']/.test(source)) {
    findings.push({ severity: 'warning', code: 'temp-token-credentials', message: 'Temporary token requests from a code page need fetch(..., { credentials: "include" }) so the session cookie is sent.' });
  }

  const evalUse = source.search(/\beval\s*\(/);
  if (evalUse >= 0) findings.push({ severity: 'warning', code: 'eval', message: 'eval() is used. Avoid it in pages that render record data.', line: lineOf(source, evalUse) });
  const writes = (source.match(/\bdocument\.write\s*\(/g) ?? []).length;
  if (writes) findings.push({ severity: 'warning', code: 'document-write', message: `document.write() is used ${writes} time(s); it blocks rendering and breaks when called after load.` });
  const innerHtml = (source.match(/\.innerHTML\s*[+]?=/g) ?? []).length;
  if (innerHtml && !/escapeHtml|textContent|DOMPurify|sanitize/i.test(source)) {
    findings.push({ severity: 'warning', code: 'innerhtml-unescaped', message: `innerHTML is assigned ${innerHtml} time(s) and no escaping helper was found. Escape record data before inserting it (XSS).` });
  }
  const logs = (source.match(/\bconsole\.log\s*\(/g) ?? []).length;
  if (logs > 5) findings.push({ severity: 'info', code: 'console-log', message: `${logs} console.log() calls; consider removing debug logging before deploying to production.` });

  if (realmHosts.length > 1) findings.push({ severity: 'warning', code: 'multiple-realms', message: `The page references more than one realm: ${realmHosts.join(', ')}.` });
  const hardcodedFids = fidConstants.length + queryFieldIds.length;
  const placeholders = findPlaceholders(source);
  if (hardcodedFids > 0 && placeholders.length === 0) {
    findings.push({
      severity: 'info',
      code: 'hardcoded-fids',
      message: 'Field IDs are hardcoded. Installing a solution into another app can reassign them; consider __QB_FIELD:table.field__ placeholders or regenerating constants with generate_field_constants.',
    });
  }

  const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;

  return {
    bytes: Buffer.byteLength(source, 'utf8'),
    lines: source.split('\n').length,
    title,
    stamp: readStamp(source),
    dbids: [...dbidMap.entries()].map(([id, e]) => ({ id, names: [...e.names], count: e.count, firstLine: e.firstLine })),
    fidConstants,
    queryFieldIds,
    selectFieldIds,
    placeholders,
    realmHosts,
    externalScripts,
    externalFetchHosts,
    usesTempToken,
    findings,
  };
}

export interface SchemaCheck {
  tables: Array<{ id: string; status: 'ok' | 'not-found'; name?: string; fieldCount?: number }>;
  fields: Array<{ name: string; fid: number; status: 'ok' | 'label-mismatch' | 'not-found'; matches: Array<{ tableId: string; label: string }> }>;
  queryFields: Array<{ fid: number; status: 'ok' | 'not-found' }>;
  findings: Finding[];
}

/**
 * Cross-check the IDs found statically against live fields.
 * A constant named FID_FIRST_NAME pointing at a field labeled "Last Name" is
 * reported as a label mismatch: the ID exists, but probably not the one meant.
 */
export async function checkAgainstSchema(
  analysis: StaticAnalysis,
  loadFields: (tableId: string) => Promise<{ name?: string; fields: QbField[] } | null>,
): Promise<SchemaCheck> {
  const findings: Finding[] = [];
  const loaded = new Map<string, { name?: string; fields: QbField[] }>();
  const tables: SchemaCheck['tables'] = [];

  for (const d of analysis.dbids) {
    const info = await loadFields(d.id).catch(() => null);
    if (info) {
      loaded.set(d.id, info);
      tables.push({ id: d.id, status: 'ok', name: info.name, fieldCount: info.fields.length });
    } else {
      // App IDs are also dbids; they have no fields, so "not found" is only a warning.
      tables.push({ id: d.id, status: 'not-found' });
      findings.push({
        severity: 'warning',
        code: 'table-not-found',
        message: `DBID ${d.id}${d.names.length ? ` (${d.names.join(', ')})` : ''} is not a table this token can read (it may be an app ID, or the table was deleted / is in another realm).`,
        line: d.firstLine,
      });
    }
  }

  const allFields = [...loaded.entries()].flatMap(([tableId, t]) => t.fields.map((f) => ({ tableId, f })));
  const fields: SchemaCheck['fields'] = [];
  if (loaded.size > 0) {
    for (const c of analysis.fidConstants) {
      const matches = allFields.filter((x) => x.f.id === c.fid).map((x) => ({ tableId: x.tableId, label: x.f.label }));
      if (matches.length === 0) {
        fields.push({ name: c.name, fid: c.fid, status: 'not-found', matches });
        findings.push({ severity: 'error', code: 'fid-not-found', message: `${c.name} = ${c.fid}: no referenced table has field ${c.fid}.`, line: c.line });
        continue;
      }
      const wanted = normalizeLabel(c.name.replace(/^FID_/i, ''));
      const labelOk = matches.some((m) => {
        const l = normalizeLabel(m.label);
        return wanted.length > 0 && (l.includes(wanted) || wanted.includes(l));
      });
      fields.push({ name: c.name, fid: c.fid, status: labelOk ? 'ok' : 'label-mismatch', matches });
      if (!labelOk) {
        findings.push({
          severity: 'warning',
          code: 'fid-label-mismatch',
          message: `${c.name} = ${c.fid}, but field ${c.fid} is labeled ${matches.map((m) => `"${m.label}" (${m.tableId})`).join(', ')}. Check the constant points at the intended field.`,
          line: c.line,
        });
      }
    }
  }

  const queryFields: SchemaCheck['queryFields'] = [];
  if (loaded.size > 0) {
    for (const fid of analysis.queryFieldIds) {
      const ok = allFields.some((x) => x.f.id === fid);
      queryFields.push({ fid, status: ok ? 'ok' : 'not-found' });
      if (!ok) findings.push({ severity: 'error', code: 'query-fid-not-found', message: `A query filters on field ${fid}, which no referenced table has.` });
    }
  }

  return { tables, fields, queryFields, findings };
}
