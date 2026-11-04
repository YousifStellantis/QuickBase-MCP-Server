# What the Quickbase APIs can and cannot do

Research snapshot: November 2026. Quickbase exposes three programmable surfaces:

1. **JSON RESTful API** (`https://api.quickbase.com/v1`, about 66 operations), the main API.
2. **Legacy XML API** (`https://<realm>/db/<dbid>` with `API_*` actions), still documented
   and still the only API for code pages.
3. **Solution APIs / QBL** (YAML schema-as-code), **Enterprise plans only since January 2026**,
   the only API surface for forms, dashboards and most "builder" objects.

Pipelines have **no public REST API**; they move as YAML through the UI (and, for some
channels, inside solutions).

## Capability matrix

Legend: ✅ supported · ⚠️ partial / with conditions · ❌ not available via API.
"Tool" names the tool in this server that exposes it.

| Area | Read | Create / change | Delete | How / tool | Notes |
|---|---|---|---|---|---|
| List apps the token can reach | ✅ | — | — | XML `API_GrantedDBs` · `list_apps` | JSON API has no "list apps". A user token only works on apps it is assigned to. |
| App properties and variables | ✅ | ✅ | ✅ | `GET/POST/DELETE /apps/{id}` · `get_app`, `update_app` | App delete intentionally not exposed. Copy app (`POST /apps/{id}/copy`) exists. |
| Tables | ✅ | ✅ | ✅ | `/tables` · `get_app`, `get_table`, `create_table`, `update_table`, `delete_table` | |
| Fields (IDs, types, formulas, choices, permissions) | ✅ | ✅ | ✅ | `/fields` · `get_fields`, `get_schema_map`, `create_field`, `update_field`, `delete_fields` | Formula fields via `properties.formula`. |
| Field usage (where a field is used) | ✅ | — | — | `/fields/usage` · `get_field_usage` | Check before renaming/deleting. |
| Relationships, lookups, summaries | ✅ | ✅ | ✅ | `/tables/{id}/relationship(s)` · `list_relationships`, `create_relationship`, … | Same-app relationships only. |
| Reports | ✅ definitions, ✅ run | ❌ | ❌ | `/reports`, `/reports/{id}/run` · `get_reports`, `run_report` | Report creation/editing: UI or QBL. |
| Records | ✅ query | ✅ upsert | ✅ by query | `/records`, `/records/query` · `query_records`, `upsert_records`, `delete_records` | `lineErrors` can appear on HTTP 200. |
| Records changed since a time | ✅ | — | — | `POST /records/modifiedSince` · `records_modified_since` | Follows lookup dependencies; good for syncs. |
| Formula evaluation without a field | ✅ | — | — | `POST /formula/run` · `run_formula` | Test formulas before creating fields. |
| File attachments | ✅ download | ✅ upload via upsert (base64) | ✅ | `/files/...` · `download_file`, `upsert_records` | |
| Document templates (PDF/DOCX) | ✅ generate | ❌ | ❌ | `GET /docTemplates/{id}/generate` · `generate_document` | Business/Enterprise; template edits take ~15 min to reach the API. |
| App roles | ✅ | ❌ (JSON) | ❌ | `GET /apps/{id}/roles` · `list_app_roles` | Role permissions: UI or QBL. XML can assign users to roles (`API_AddUserToRole`). |
| Trustees (users/groups/domains on an app) | ✅ | ✅ | ✅ | `/app/{id}/trustees` · `get_trustees` (admin toolset) | Server exposes read only. |
| Automation inventory (webhooks, notifications, reminders, subscriptions, QB Actions, automations) | ✅ | ❌ | ❌ | `GET /apps/{id}/events` · `list_app_events` | **Does not include pipelines.** Legacy table webhooks are editable via XML `API_Webhooks_*` (not exposed). |
| **Code pages** | ✅ by ID or name | ✅ create / replace | ❌ | XML `API_GetDBPage`, `API_AddReplaceDBPage` · `get_code_page`, `deploy_code_page` | **No API lists pages** → page IDs from URLs/config, `discover_code_pages` (bounded ID probe), or QBL `QB::CodePage`. No version history: this server adds build stamps + drift protection. Deleting a page: UI only. |
| **Forms** (legacy and new forms, dynamic form rules) | ⚠️ QBL only | ⚠️ QBL only | ⚠️ QBL only | Solutions · `export_solution`, `inspect_qbl`, `apply_solution` | `QB::Form` (legacy) and `QB::FormV2` (new forms). No JSON/XML form API. |
| Dashboards, charts, home/rich-text pages | ⚠️ QBL only | ⚠️ QBL only | ⚠️ QBL only | Solutions | |
| Custom emails, document templates as schema | ⚠️ QBL v0.14 (beta) | ⚠️ | ⚠️ | Solutions | Version-dependent. |
| **Pipelines** | ⚠️ YAML export (UI) | ⚠️ YAML import (UI) | ❌ API | Workspace YAML · `list_pipeline_files`, `inspect_pipeline`, `remap_pipeline`, `save_pipeline` | No REST API to list/read/create/run. Imports start disabled; importer becomes owner; tokens are never exported. |
| Pipelines inside solutions | ⚠️ | ⚠️ | ⚠️ | Solutions/QBL | Only supported channels (v0.12: Quickbase, Callable). v0.14 beta limits: 2 apps with up to 30 pipelines, or 3 apps without pipelines. |
| Start a pipeline from outside | ✅ | — | — | Incoming-webhook / callable trigger URL · `trigger_pipeline` | Only URLs allowlisted in the config file. |
| Solutions / QBL | ✅ export, info | ✅ create, update, changeset (dry run), from/to record | — | `/solutions...` · `export_solution`, `get_solution_info`, `preview_solution_changes`, `apply_solution` | Enterprise only. Coverage grows by QBL version; unsupported objects are left untouched. |
| Users, groups | ✅ (account admin) | ✅ deny/undeny, group members/managers/subgroups | — | `/users`, `/groups/{gid}/...` · `get_users` (admin) | Write operations intentionally not exposed. |
| User tokens | — | ✅ clone, transfer, deactivate, delete (the calling token) | ✅ | `/usertoken/...` | Not exposed (risk of locking yourself out). |
| Audit logs | ✅ (realm admin, Enterprise) | — | — | `POST /audit` · `get_audit_log` (admin) | One day per query, paged. |
| Platform analytics | ✅ (realm admin) | — | — | `/analytics/...` · `get_platform_analytics` (admin) | |
| Auth | user tokens (server-side), temporary tokens (code pages), SSO SAML exchange (RFC 8693) | | | | Use a service-account user token for this server. |

## Limits and behaviors to design for

- **Rate limit**: about **100 requests per 10 seconds per user token** on most JSON
  endpoints (some endpoints differ); the XML API is limited dynamically. On HTTP 429
  honor `Retry-After`. This server keeps a client-side window of 90/10 s (`QB_RATE_LIMIT`).
- **XML API returns HTTP 200 for failures**; the `<errcode>` decides success.
- **CDATA**: page bodies containing `]]>` must be split, or the page is silently truncated.
- **Page names need an extension** (`KPI.html`), otherwise Quickbase serves the page as text.
- **Field IDs can change** when an app is copied or a solution is installed into another
  app; never hardcode them in pages or pipelines (generate constants / remap).
- **Pipelines reference fields by snake_case label** in `inputs`; renames break them.
- **Temporary tokens** (code pages) are short-lived and scoped to one app/table dbid.

## Is it possible to put skills inside the MCP server?

Yes. The MCP **Skills extension** (`io.modelcontextprotocol/skills`, SEP-2640, published
specification; extension in Beta) lets a server publish Agent Skills (`SKILL.md` folders):
`skills/list`, `skills/get`, and `resources/read` of `skill://…` URIs with SHA-256
digests that hosts verify. The TypeScript SDK ships it from v2.4.0 (`ext/skills`).

Client support is still uneven (late 2026): MCPJam, mcpc and Glean implement it, ChatGPT,
fast-agent and the MCP Inspector partially; Claude Code, Claude Desktop, VS Code/Copilot
and Cursor do not yet. This server therefore exposes the same skills four ways:
the extension, plain MCP resources, prompts (slash commands) and two tools
(`list_skills` / `load_skill`), and `quickbase-mcp install-skills` copies them into a
client's native skills folder (for example `.claude/skills/`).

## Sources

- MCP: [Build an MCP server (2026-07-28)](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-server),
  [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
  [Skills extension](https://modelcontextprotocol.io/extensions/skills/overview),
  [Extension client matrix](https://modelcontextprotocol.io/extensions/client-matrix),
  [ext-skills implementations](https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/implementations.md).
- Quickbase API reference: [developer.quickbase.com](https://developer.quickbase.com/); endpoint inventory
  cross-checked against the OpenAPI-generated clients `quickbase-js` 2.3.0 (March 2026) and
  `quickbase` 6.0.0 on npm.
- Quickbase help: [QBL and Solution APIs overview](https://help.quickbase.com/docs/qbl-and-solution-apis-overview),
  [About QBL versions](https://help.quickbase.com/docs/about-qbl-versions),
  [QBL v0.14 overview](https://help.quickbase.com/docs/qbl-version-014-overview),
  [Pipelines: QBL v0.12](https://help.quickbase.com/docs/pipelines-qbl-v012),
  [Dynamic form rules: QBL v0.9](https://help.quickbase.com/docs/dynamic-form-rules-qbl-v09),
  [Import YAML to create a pipeline](https://help.quickbase.com/docs/import-yaml-to-create-a-pipeline),
  [Account slugs in pipeline exports](https://help.quickbase.com/docs/account-slugs-and-aliases-in-pipeline-exports),
  [Rate limiting overview](https://help.quickbase.com/docs/rate-limiting-overview),
  [API_AddReplaceDBPage](https://help.quickbase.com/docs/api-addreplacedbpage).
- Field notes from `qb-deploy` (code page deploy tool): CDATA splitting, errcode on HTTP 200,
  no page listing, ID-not-name updates, drift detection.
