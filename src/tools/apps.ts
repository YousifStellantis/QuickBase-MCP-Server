/** Discovery: apps, tables, fields (IDs), relationships, reports, roles, automations, schema map, constants. */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import {
  compactField,
  formatSchemaMarkdown,
  generateFieldConstants,
  toCamelKey,
  type ConstantsStyle,
} from '../quickbase/schema.js';
import { slugify } from '../workspace.js';
import { clip, dbid, envParam, getEnvArg, json, READ_ONLY, safe, text, LOCAL_WRITE } from './util.js';

export function registerAppTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'get_app',
    {
      title: 'Get app and its tables',
      description: 'App properties (name, time zone, date format, app variables) and every table with its ID, alias and key field.',
      inputSchema: z.object({ appId: dbid('App ID').optional().describe('App ID (default: the environment\'s app)'), ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      const [app, tables] = await Promise.all([rt.schema.app(appId), rt.schema.tables(appId)]);
      return json(ctx, {
        app: { id: appId, name: app.name, description: app.description, timeZone: app.timeZone, dateFormat: app.dateFormat, variables: app.variables ?? [] },
        tables: tables.map((t) => ({ id: t.id, name: t.name, alias: t.alias, keyFieldId: t.keyFieldId, singleRecordName: t.singleRecordName, nextRecordId: t.nextRecordId })),
      }, `${app.name} (${appId})`);
    }),
  );

  server.registerTool(
    'get_table',
    {
      title: 'Get table properties',
      description: 'Properties of one table: name, alias, key field, default sort, record names, size.',
      inputSchema: z.object({ tableId: dbid('Table ID'), appId: dbid('App ID').optional(), ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      await ctx.assertTableAllowed(rt, args.tableId);
      return json(ctx, await rt.schema.table(appId, args.tableId));
    }),
  );

  server.registerTool(
    'get_fields',
    {
      title: 'Get fields (IDs, types, formulas)',
      description:
        'Fields of a table with their field IDs (FIDs), types and modes (formula / lookup / summary). Use this instead of guessing FIDs. Filter with search or fieldIds; detail "full" returns every property Quickbase reports.',
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        search: z.string().optional().describe('Case-insensitive filter on label'),
        fieldIds: z.array(z.number().int()).optional().describe('Only these FIDs'),
        detail: z.enum(['compact', 'full']).optional().describe('compact (default) or full'),
        includeFormulas: z.boolean().optional().describe('Include formula text in compact mode'),
        includePermissions: z.boolean().optional().describe('Include per-role field permissions'),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      let fields = await rt.schema.fields(args.tableId, { includeFieldPerms: args.includePermissions });
      if (args.fieldIds?.length) fields = fields.filter((f) => args.fieldIds!.includes(f.id));
      if (args.search) {
        const s = args.search.toLowerCase();
        fields = fields.filter((f) => f.label.toLowerCase().includes(s));
      }
      const out = args.detail === 'full' ? fields : fields.map((f) => compactField(f, { includeFormula: args.includeFormulas, includeHelp: false }));
      return json(ctx, { tableId: args.tableId, count: fields.length, fields: out });
    }),
  );

  server.registerTool(
    'get_field_usage',
    {
      title: 'Get field usage',
      description: 'Where fields are used (reports, forms, formulas, notifications, pipelines-facing webhooks, etc.). Check this before renaming or deleting a field.',
      inputSchema: z.object({ tableId: dbid('Table ID'), fieldId: z.number().int().optional().describe('One field; omit for all fields'), ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      const path = args.fieldId ? `/fields/usage/${args.fieldId}` : '/fields/usage';
      return json(ctx, (await rt.json.get(path, { query: { tableId: args.tableId } })).data);
    }),
  );

  server.registerTool(
    'list_relationships',
    {
      title: 'List table relationships',
      description: 'Relationships where this table is the child: parent table, reference field, lookup and summary fields.',
      inputSchema: z.object({ tableId: dbid('Child table ID'), ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      return json(ctx, await rt.schema.relationships(args.tableId));
    }),
  );

  server.registerTool(
    'get_reports',
    {
      title: 'Get reports',
      description: 'Report definitions for a table (all, or one by reportId): type, filter, columns, sorting, grouping.',
      inputSchema: z.object({ tableId: dbid('Table ID'), reportId: z.string().optional().describe('One report ID, e.g. "1"'), ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      const path = args.reportId ? `/reports/${encodeURIComponent(args.reportId)}` : '/reports';
      const data = (await rt.json.get<unknown>(path, { query: { tableId: args.tableId } })).data;
      if (!args.reportId && Array.isArray(data)) {
        const list = data as Array<Record<string, unknown>>;
        return json(ctx, list.map((r) => ({ id: r.id, name: r.name, type: r.type, description: r.description, usedCount: r.usedCount, filter: (r.query as Record<string, unknown> | undefined)?.filter })));
      }
      return json(ctx, data);
    }),
  );

  server.registerTool(
    'list_app_roles',
    {
      title: 'List app roles',
      description: 'Roles in an app with their access level (requires app admin). Useful when a code page or form must behave differently per role.',
      inputSchema: z.object({ appId: dbid('App ID').optional(), ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      return json(ctx, (await rt.json.get(`/apps/${appId}/roles`)).data);
    }),
  );

  server.registerTool(
    'list_app_events',
    {
      title: 'List app automations',
      description:
        'Inventory of event-driven behavior in an app: webhooks, notifications, reminders, subscriptions, QB Actions and record-triggered automations, with owners and tables. Pipelines are not included (Quickbase exposes no pipeline listing API).',
      inputSchema: z.object({ appId: dbid('App ID').optional(), ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      return json(ctx, (await rt.json.get(`/apps/${appId}/events`)).data);
    }),
  );

  server.registerTool(
    'get_schema_map',
    {
      title: 'Get app schema map (all table and field IDs)',
      description:
        'One call that returns every table ID, field ID, type and relationship in an app, as compact markdown (default) or JSON. Start here before writing queries, code pages, pipelines or formulas. A JSON snapshot is saved to the workspace (.quickbase/schema/<env>-<appId>.json) for offline reference.',
      inputSchema: z.object({
        appId: dbid('App ID').optional(),
        tableIds: z.array(dbid('Table ID')).optional().describe('Limit to these tables'),
        format: z.enum(['markdown', 'json']).optional(),
        includeFormulas: z.boolean().optional().describe('Include formula text'),
        includeBuiltIns: z.boolean().optional().describe('Include built-in fields 1-5'),
        includeRelationships: z.boolean().optional().describe('Default true'),
        saveSnapshot: z.boolean().optional().describe('Default true'),
        ...envParam(ctx),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      const schema = await rt.schema.appSchema(appId, { tableIds: args.tableIds, includeRelationships: args.includeRelationships });
      let saved = '';
      if (args.saveSnapshot !== false) {
        const abs = await ctx.workspace.writeText(`.quickbase/schema/${rt.name}-${appId}.json`, JSON.stringify(schema, null, 2) + '\n');
        saved = `\n\nSnapshot saved: ${ctx.workspace.display(abs)}`;
      }
      if (args.format === 'json') {
        return json(ctx, {
          ...schema,
          tables: schema.tables.map((t) => ({ ...t, fields: t.fields.map((f) => compactField(f, { includeFormula: args.includeFormulas })) })),
        });
      }
      return text(clip(ctx, formatSchemaMarkdown(schema, { includeFormulas: args.includeFormulas, includeBuiltIns: args.includeBuiltIns }) + saved));
    }),
  );

  server.registerTool(
    'find_fields',
    {
      title: 'Find fields across tables',
      description: 'Search field labels (and optionally formula text) across all tables of an app, e.g. "TID", "Required Level", "[Status]".',
      inputSchema: z.object({
        query: z.string().min(1).describe('Substring, or /regex/flags'),
        appId: dbid('App ID').optional(),
        matchFormulas: z.boolean().optional().describe('Also search formula text'),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      const schema = await rt.schema.appSchema(appId, { includeRelationships: false });
      const re = toMatcher(args.query);
      const hits = schema.tables.flatMap((t) =>
        t.fields
          .filter((f) => re(f.label) || (args.matchFormulas && f.properties?.formula && re(f.properties.formula)))
          .map((f) => ({ tableId: t.id, table: t.name, fieldId: f.id, label: f.label, type: f.fieldType, mode: f.mode || undefined })),
      );
      return json(ctx, { query: args.query, count: hits.length, fields: hits });
    }),
  );

  server.registerTool(
    'generate_field_constants',
    {
      title: 'Generate DBID/FID constants for code',
      description:
        'Generate table-ID and field-ID constants from the live schema, ready to paste into a code page: js-const (const DBID_X / FID_X = n), js-object, typescript, or qb-deploy-json (the config/fields.<env>.json map used by __QB_FIELD:table.field__ placeholders). Never hand-type field IDs.',
      inputSchema: z.object({
        tables: z
          .array(z.object({ tableId: dbid('Table ID'), alias: z.string().optional().describe('Short name, e.g. compDetails') }))
          .min(1)
          .describe('Tables to include'),
        appId: dbid('App ID').optional(),
        style: z.enum(['js-const', 'js-object', 'typescript', 'qb-deploy-json']).optional().describe('Default js-const'),
        prefixWithTable: z.boolean().optional().describe('Prefix FID names with the table name (default: when more than one table)'),
        includeBuiltIns: z.boolean().optional().describe('Include built-in fields 1, 2, 4, 5 (3 is always included)'),
        saveTo: z.string().optional().describe('Workspace path to write, e.g. config/fields.dev.json'),
        ...envParam(ctx),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      const allTables = await rt.schema.tables(appId);
      const inputs = [];
      for (const t of args.tables) {
        const table = allTables.find((x) => x.id === t.tableId);
        if (!table) throw new Error(`Table ${t.tableId} is not in app ${appId}.`);
        inputs.push({ table, alias: t.alias ?? (toCamelKey(table.name) || slugify(table.id)), fields: await rt.schema.fields(t.tableId) });
      }
      const style = (args.style ?? 'js-const') as ConstantsStyle;
      const { code, collisions } = generateFieldConstants(inputs, style, {
        realm: rt.config.realm,
        appId,
        prefixWithTable: args.prefixWithTable,
        includeBuiltIns: args.includeBuiltIns,
      });
      let note = '';
      if (args.saveTo) {
        const abs = await ctx.workspace.writeText(args.saveTo, code);
        note = `Saved to ${ctx.workspace.display(abs)}.`;
      }
      if (collisions.length) note += `${note ? ' ' : ''}Name collisions (suffixed with the FID): ${collisions.join('; ')}.`;
      return text([note, '```' + (style === 'qb-deploy-json' ? 'json' : style === 'typescript' ? 'ts' : 'js'), code.trimEnd(), '```'].filter(Boolean).join('\n'));
    }),
  );
}

function toMatcher(q: string): (s: string) => boolean {
  const m = q.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    const re = new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`);
    return (s) => re.test(s);
  }
  const needle = q.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}
