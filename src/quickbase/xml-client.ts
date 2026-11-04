/**
 * Legacy XML API client: https://<realm>/db/<dbid> with a QUICKBASE-ACTION header.
 *
 * Used only where the JSON API has no equivalent:
 *  - code pages (API_GetDBPage / API_AddReplaceDBPage)
 *  - listing the apps a token can reach (API_GrantedDBs)
 *  - identifying the token's user (API_GetUserInfo)
 *  - cheap record counts (API_DoQueryCount)
 *
 * The XML API returns HTTP 200 for application failures, so every response is
 * checked for a non-zero <errcode>. Checking response.ok alone is how scripts
 * report success while having done nothing.
 */

import type { Logger } from '../logger.js';
import { redact, silentLogger } from '../logger.js';
import { QuickbaseXmlError } from './errors.js';
import type { FetchLike } from './http.js';
import { backoffMs, retryAfterMs } from './json-client.js';
import type { RateLimiter } from './rate-limiter.js';
import { decodeXmlEntities, escapeCdata, escapeXmlText, extractAll, extractAttr, extractTag, stripCdata, textContent } from './xml.js';

/** pagetype 1 = HTML / XSL page; 3 = Exact Form (Word template). */
export const PAGE_TYPE_HTML = 1;

export interface XmlClientOptions {
  realm: string;
  userToken: string;
  appToken?: string;
  /** Defaults to https://<realm>. */
  baseUrl?: string;
  limiter: RateLimiter;
  timeoutMs: number;
  userAgent: string;
  fetchImpl: FetchLike;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

export interface GrantedDb {
  dbid: string;
  name: string;
  ancestorAppId?: string;
  oldestAncestorAppId?: string;
}

export interface UserInfo {
  id: string | null;
  firstName: string | null;
  lastName: string | null;
  login: string | null;
  email: string | null;
  screenName: string | null;
}

const READ_ACTIONS = new Set(['API_GetDBPage', 'API_GrantedDBs', 'API_GetUserInfo', 'API_DoQueryCount', 'API_GetSchema', 'API_GetDBInfo']);

export class QuickbaseXmlClient {
  readonly realm: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;

  constructor(private readonly opts: XmlClientOptions) {
    this.realm = opts.realm;
    this.baseUrl = (opts.baseUrl ?? `https://${opts.realm}`).replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.logger = opts.logger ?? silentLogger;
  }

  /** POST one XML API action. Returns the raw response text; throws QuickbaseXmlError on errcode != 0. */
  async call(dbid: string, action: string, innerXml = ''): Promise<string> {
    const url = `${this.baseUrl}/db/${encodeURIComponent(dbid)}`;
    const auth = [
      `<usertoken>${escapeXmlText(this.opts.userToken)}</usertoken>`,
      this.opts.appToken ? `<apptoken>${escapeXmlText(this.opts.appToken)}</apptoken>` : '',
    ]
      .filter(Boolean)
      .join('\n  ');
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<qdbapi>\n  ${innerXml}\n  ${auth}\n</qdbapi>`;
    const idempotent = READ_ACTIONS.has(action);

    for (let attempt = 0; ; attempt++) {
      await this.opts.limiter.acquire();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      let res: Response;
      try {
        res = await this.opts.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/xml',
            'QUICKBASE-ACTION': action,
            'User-Agent': this.opts.userAgent,
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (idempotent && attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        const e = err as { name?: string; message?: string };
        const why = e?.name === 'AbortError' ? `timed out after ${this.opts.timeoutMs} ms (proxy or firewall?)` : e?.message;
        throw new Error(this.scrub(`${action}: network error reaching ${url} -- ${why}`));
      }
      clearTimeout(timer);

      if (res.status === 429 && attempt < this.maxRetries) {
        await this.sleep(retryAfterMs(res.headers.get('retry-after')) ?? backoffMs(attempt));
        continue;
      }
      if (res.status >= 500 && idempotent && attempt < this.maxRetries) {
        await this.sleep(backoffMs(attempt));
        continue;
      }

      const text = await res.text();
      if (!res.ok) throw new Error(this.scrub(`${action}: HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`));

      const errcode = extractTag(text, 'errcode');
      // API_GetDBPage may return the bare page with no <qdbapi> envelope.
      if (errcode === null) return text;
      const code = Number(errcode.trim());
      if (code !== 0) {
        const errtext = decodeXmlEntities(extractTag(text, 'errtext') ?? 'unknown error');
        const detail = extractTag(text, 'errdetail');
        throw new QuickbaseXmlError(action, code, this.scrub(errtext), detail ? this.scrub(decodeXmlEntities(detail)) : undefined);
      }
      this.logger.debug(`${action} ok (${dbid})`);
      return text;
    }
  }

  async getUserInfo(email?: string): Promise<UserInfo> {
    const raw = await this.call('main', 'API_GetUserInfo', email ? `<email>${escapeXmlText(email)}</email>` : '');
    const pick = (tag: string) => textContent(extractTag(raw, tag));
    return {
      id: extractAttr(raw, 'user', 'id'),
      firstName: pick('firstName'),
      lastName: pick('lastName'),
      login: pick('login'),
      email: pick('email'),
      screenName: pick('screenName'),
    };
  }

  /** Apps (and optionally tables) the token's user can access in this realm. */
  async grantedDbs(opts: { includeTables?: boolean; adminOnly?: boolean } = {}): Promise<GrantedDb[]> {
    const inner = [
      `<withembeddedtables>${opts.includeTables ? 1 : 0}</withembeddedtables>`,
      '<excludeparents>0</excludeparents>',
      '<realmAppsOnly>true</realmAppsOnly>',
      '<includeancestors>1</includeancestors>',
      opts.adminOnly ? '<adminOnly>1</adminOnly>' : '',
    ]
      .filter(Boolean)
      .join('\n  ');
    const raw = await this.call('main', 'API_GrantedDBs', inner);
    return extractAll(raw, 'dbinfo').map((block) => ({
      dbid: (textContent(extractTag(block, 'dbid')) ?? '').trim(),
      name: (textContent(extractTag(block, 'dbname')) ?? '').trim(),
      ancestorAppId: textContent(extractTag(block, 'ancestorappid'))?.trim() || undefined,
      oldestAncestorAppId: textContent(extractTag(block, 'oldestancestorappid'))?.trim() || undefined,
    }));
  }

  /**
   * Current contents of a code page, by page ID or page name.
   * Responses are inconsistent: sometimes a <qdbapi> envelope with <pagebody>,
   * sometimes the bare page. Both are handled.
   */
  async getPage(appId: string, pageIdOrName: string | number): Promise<string> {
    const raw = await this.call(appId, 'API_GetDBPage', `<pageID>${escapeXmlText(String(pageIdOrName))}</pageID>`);
    const pagebody = extractTag(raw, 'pagebody');
    if (pagebody !== null) return stripCdata(pagebody) ?? decodeXmlEntities(pagebody);
    if (/^\s*<\?xml/.test(raw) && /<qdbapi>/i.test(raw)) {
      const inner = raw.replace(/[\s\S]*?<qdbapi>/i, '').replace(/<\/qdbapi>[\s\S]*$/i, '');
      const cleaned = inner
        .replace(/<action>[\s\S]*?<\/action>/gi, '')
        .replace(/<errcode>[\s\S]*?<\/errcode>/gi, '')
        .replace(/<errtext>[\s\S]*?<\/errtext>/gi, '')
        .trim();
      if (cleaned) return stripCdata(cleaned) ?? decodeXmlEntities(cleaned);
    }
    return raw;
  }

  /**
   * Create (pageName) or replace (pageId) a code page. Returns the page ID.
   * pageid and pagename are alternatives: ID replaces, name adds. Updating
   * "by name" is not a documented path and risks a silent duplicate page.
   */
  async putPage(appId: string, page: { pageId?: string | number; pageName?: string; body: string; pageType?: number }): Promise<string | null> {
    if (!page.pageId && !page.pageName) throw new Error('putPage needs pageId (replace) or pageName (create).');
    const selector = page.pageId
      ? `<pageid>${escapeXmlText(String(page.pageId))}</pageid>`
      : `<pagename>${escapeXmlText(page.pageName ?? '')}</pagename>`;
    const inner = [
      selector,
      `<pagetype>${page.pageType ?? PAGE_TYPE_HTML}</pagetype>`,
      `<pagebody><![CDATA[${escapeCdata(page.body)}]]></pagebody>`,
    ].join('\n  ');
    const raw = await this.call(appId, 'API_AddReplaceDBPage', inner);
    const assigned = extractTag(raw, 'pageID') ?? extractTag(raw, 'pageid');
    return assigned ? assigned.trim() : page.pageId !== undefined ? String(page.pageId) : null;
  }

  async doQueryCount(tableId: string, query: string): Promise<number> {
    const raw = await this.call(tableId, 'API_DoQueryCount', `<query>${escapeXmlText(query)}</query>`);
    return Number((extractTag(raw, 'numMatches') ?? '0').trim());
  }

  private scrub(text: string): string {
    return redact(text, [this.opts.userToken, this.opts.appToken]);
  }
}
