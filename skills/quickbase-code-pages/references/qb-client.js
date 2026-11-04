/*
 * Minimal Quickbase JSON API client for code pages.
 *
 * - Auth: temporary tokens from the signed-in session (no user tokens in pages).
 * - One cached token per dbid; refreshed on 401 or after TOKEN_TTL_MS.
 * - Retries 401 (token refresh), 429 (Retry-After) and 5xx for reads.
 * - queryAll() follows skip/top pagination.
 *
 * Usage:
 *   const qb = createQuickbaseClient({ realmFallback: "yourrealm.quickbase.com" });
 *   const rows = await qb.queryAll({ from: QB.tables.defects.id, select: [3, 6, 7], where: "{7.EX.'Open'}" });
 *   await qb.upsert({ to: tableId, data: [{ 6: { value: "x" } }], fieldsToReturn: [3] });
 */
function createQuickbaseClient({ realmFallback, tokenTtlMs = 4 * 60 * 1000, maxRetries = 2 } = {}) {
  const realm = /\.quickbase\.com$/.test(location.hostname) ? location.hostname : realmFallback;
  const api = "https://api.quickbase.com/v1";
  const tokens = new Map();

  class QuickbaseError extends Error {
    constructor(status, message, description) {
      super(description ? `${message}: ${description}` : message);
      this.name = "QuickbaseError";
      this.status = status;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function tempToken(dbid, force = false) {
    const hit = tokens.get(dbid);
    if (!force && hit && Date.now() < hit.expires) return hit.token;
    const res = await fetch(`${api}/auth/temporary/${encodeURIComponent(dbid)}`, {
      headers: { "QB-Realm-Hostname": realm },
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) throw new QuickbaseError(res.status, "Could not get a temporary token", "open this page from inside Quickbase while signed in");
    const { temporaryAuthorization } = await res.json();
    tokens.set(dbid, { token: temporaryAuthorization, expires: Date.now() + tokenTtlMs });
    return temporaryAuthorization;
  }

  async function request(method, path, { dbid, body, query, idempotent = method === "GET" } = {}) {
    const url = new URL(api + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    let lastStatus = 0;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          "QB-Realm-Hostname": realm,
          // A 401 means the cached temp token expired: fetch a fresh one.
          Authorization: `QB-TEMP-TOKEN ${await tempToken(dbid, lastStatus === 401)}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      lastStatus = res.status;
      const retryable = res.status === 401 || res.status === 429 || (idempotent && res.status >= 500);
      if (retryable && attempt < maxRetries) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) throw new QuickbaseError(res.status, (data && data.message) || `HTTP ${res.status}`, data && data.description);
      return data;
    }
  }

  async function queryAll(body, { max = 10000, pageSize = 1000 } = {}) {
    const rows = [];
    let fields = [];
    let skip = (body.options && body.options.skip) || 0;
    for (;;) {
      const top = Math.min(pageSize, max - rows.length);
      const page = await request("POST", "/records/query", {
        dbid: body.from,
        body: { ...body, options: { ...(body.options || {}), skip, top } },
        idempotent: true,
      });
      if (!fields.length) fields = page.fields || [];
      rows.push(...page.data);
      skip += page.metadata.numRecords;
      if (!page.metadata.numRecords || skip >= page.metadata.totalRecords || rows.length >= max) break;
    }
    rows.fields = fields;
    return rows;
  }

  async function upsert(body) {
    const res = await request("POST", "/records", { dbid: body.to, body });
    const errors = res.metadata && res.metadata.lineErrors;
    if (errors && Object.keys(errors).length) {
      const first = Object.entries(errors)[0];
      throw new QuickbaseError(207, `Some records were rejected (line ${first[0]})`, first[1].join("; "));
    }
    return res;
  }

  /** Cell value helper: v(row, 7) -> row["7"].value or null. */
  const v = (row, fid) => (row && row[fid] ? row[fid].value : null);

  return { realm, request, queryAll, upsert, v, QuickbaseError };
}
