---
name: quickbase-code-pages
description: Engineering rules for Quickbase code pages (HTML/JS pages stored in an app and served from the realm), including authentication with temporary tokens, the JSON API from the browser, field-ID discipline, pagination, error handling, performance, environment portability and the pull / review / deploy workflow with drift protection. Use whenever you create, change, review or deploy a code page.
metadata:
  version: "1.0"
  pairs-with: "automotive-ui-design-system, quickbase-query-language"
---

# Quickbase code pages

A code page is a file stored in a Quickbase app (app settings > Pages) and served at
`https://<realm>/db/<appId>?a=dbpage&pageID=<id>`. It runs in the browser **as the
signed-in user**, with that user's role permissions. There is no server side.

## Golden rules

1. **Never embed a user token.** Anyone who can open the page can read it. Authenticate
   every JSON API call with a temporary token from
   `GET https://api.quickbase.com/v1/auth/temporary/{dbid}` using
   `credentials: "include"` (the session cookie) and the `QB-Realm-Hostname` header.
   Send it as `Authorization: QB-TEMP-TOKEN <token>`.
2. **Never type a table or field ID.** Get them from `get_schema_map`, then generate
   constants with `generate_field_constants` (or use `__QB_FIELD:table.field__`
   placeholders that `deploy_code_page` resolves per environment). Solution installs
   and DEV/PROD copies can reassign field IDs.
3. **One page = one HTML file** in the repo/workspace, with version control. The live
   page is a deploy target, not the source of truth. Edits made in the browser are
   "drift" and must be pulled back before the next deploy.
4. **Review before deploy.** Run `analyze_code_page`; fix every error. Then the design
   checklist from `automotive-ui-design-system`.

## Client pattern

Use `references/qb-client.js` (temp-token cache per dbid, retry on 401/429/5xx with
Retry-After, pagination with `skip`/`top`, typed errors). Key behaviors:

- Temp tokens are short-lived and scoped to one app or table dbid. Cache per dbid for a
  few minutes; on 401 drop the cache and retry once.
- Realm: use `location.hostname` when the page is served from `*.quickbase.com`, with
  a constant fallback for local preview. No hardcoded realm in two places.
- Pagination: `POST /v1/records/query` returns `metadata.totalRecords`/`numRecords`.
  Loop with `options.skip` and `options.top` (≤ 1000 per page is a good size) until done.
  Never assume the first page is everything.
- Rate limits: about 100 requests per 10 seconds per user. Batch: one query with a wider
  `where` and grouping in JS beats 50 per-row queries. Run independent queries in
  parallel, but no more than ~4 at a time.
- Writes: `POST /v1/records` with `{ to, data: [{ "<fid>": { value } }], fieldsToReturn: [3] }`.
  Check `metadata.lineErrors` even on HTTP 200. Use `mergeFieldId` for idempotent upserts.
- XML API calls from a page (`/db/<dbid>?a=API_...`) also work with the session; prefer the
  JSON API except for things only XML has (e.g. `API_GetUserInfo`).

## Structure of a page

```
<head> title, viewport, tokens, fonts </head>
<body>
  header: product name · context (plant/line/shift/range) · freshness · theme toggle
  error banner (hidden) · filters · KPI strip · panels (charts, tables) · footer (source)
  <script> GENERATED CONSTANTS → client → data loaders → renderers → event wiring </script>
</body>
```

Start from `../automotive-ui-design-system/references/page-template.html` (load it with
`load_skill name="automotive-ui-design-system" file="references/page-template.html"`).

## Correctness checklist

- Escape every record value before inserting HTML (`textContent`, or an `escapeHtml`
  helper). Record data is user input.
- Quote query values: `{7.EX.'Line 2'}`; escape `'` inside values as `\'`.
- Dates: Quickbase returns ISO strings; render in the plant time zone, compare as dates
  not strings. Use `compareWithAppLocalTime` when filtering on "today".
- User fields come back as objects (`{ id, email, name }`); file fields as
  `{ url, versions: [...] }`. Handle `null`.
- Show loading, empty and error states. Never leave a spinner forever.
- Pin CDN libraries to exact versions (e.g. `chart.js@4.4.3`). Prefer the same versions
  across pages.
- Page names need an extension (`KPI.html`); without one Quickbase serves the page as
  plain text.
- Linking to records: `/db/<tableId>?a=dr&rid=<recordId>` (view), `?a=er&rid=` (edit).

## Performance

- Select only the fields you render (`select: [...]`).
- Push filtering and sorting into the query; aggregate client-side only what the API
  cannot (or use a summary report via `run_report`).
- Cache lookups that rarely change (domains, roles, positions) in memory for the session.
- Avoid formula-heavy fields in large queries; they are computed per row on the server.

## Workflow with this server

1. `get_schema_map` → `generate_field_constants` (or placeholders).
2. Build the page locally in the workspace.
3. `analyze_code_page localPath=...` → fix.
4. `diff_code_page` against the live page (if it exists).
5. `deploy_code_page dryRun=true`, show the diff, then deploy (protected environments need
   `confirm` with the environment name). The build stamp records the git SHA; drift
   protection refuses to overwrite a page edited in the browser unless `force` is set.
6. Pull pages you did not write with `get_code_page saveTo=...` before editing them.

Finding pages: Quickbase has no API that lists code pages. Use the IDs in
`?a=dbpage&pageID=` URLs, the config file's `targets`, `discover_code_pages` (probes a
small ID range), or a QBL export (`QB::CodePage` resources) on Enterprise plans.
