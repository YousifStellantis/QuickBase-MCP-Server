import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { resolveFieldRef, rowsToCsv, rowsToLabeled } from '../quickbase/schema.js';
import type { QbQueryResponse } from '../quickbase/types.js';
import { slugify } from '../workspace.js';
import { dbid, envParam, getEnvArg, json, jsonObject, READ_ONLY, REMOTE_DESTRUCTIVE, REMOTE_WRITE, safe, text, LOCAL_WRITE } from './util.js';

const fieldRef = z.union([z.number().int(), z.string()]).describe('Field ID (number) or exact field label');

const QUERY_HELP =
  'Quickbase query syntax: {fid.OP.value} joined with AND / OR, e.g. {7.EX.\'Open\'}AND{12.OAF.\'today\'}. Operators: EX, XEX, CT, XCT, SW, XSW, LT, LTE, GT, GTE, BF, OBF, AF, OAF, IR, XIR, TV, HAS, XHAS. Load the quickbase-query-language skill for the full reference.';

export function registerRecordTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'query_records',
    {
      title: 'Query records',
      description: `Query a table and get rows keyed by field label (or raw FIDs, or CSV). Follows pagination up to maxRecords. ${QUERY_HELP}`,
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        select: z.array(fieldRef).optional().describe('Fields to return (IDs or labels). Default: the table\'s default columns'),
        where: z.string().optional().describe('Quickbase query string'),
        sortBy: z.array(z.object({ field: fieldRef, order: z.enum(['ASC', 'DESC']).optional() })).optional(),
        groupBy: z.array(fieldRef).optional(),
        maxRecords: z.number().int().min(1).max(10000).optional().describe('Default 100, max 10000'),
        skip: z.number().int().min(0).optional(),
        format: z.enum(['labels', 'raw', 'csv']).optional().describe('labels (default), raw ({fid: {value}}), csv'),
        saveTo: z.string().optional().describe('Write the full result to this workspace path (json or csv) and return a summary'),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      const fields = await rt.schema.fields(args.tableId);
      const body: Record<string, unknown> = { from: args.tableId };
      if (args.select?.length) body.select = args.select.map((r) => resolveFieldRef(fields, r));
      if (args.where) body.where = args.where;
      if (args.sortBy?.length) body.sortBy = args.sortBy.map((s) => ({ fieldId: resolveFieldRef(fields, s.field), order: s.order ?? 'ASC' }));
      if (args.groupBy?.length) body.groupBy = args.groupBy.map((g) => ({ fieldId: resolveFieldRef(fields, g), grouping: 'equal-values' }));
      if (args.skip) body.options = { skip: args.skip };
      const max = args.maxRecords ?? 100;
      const res = await rt.json.queryAll(body, max);
      return renderRows(ctx, res.data, res.fields, res.totalRecords, args.format, args.saveTo, `${args.tableId}`);
    }),
  );

  server.registerTool(
    'run_report',
    {
      title: 'Run a report',
      description: 'Run a saved report by ID and return its rows (table reports) or summary data. Respects the report\'s filters and columns.',
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        reportId: z.string().describe('Report ID, e.g. "1" (see get_reports)'),
        top: z.number().int().min(1).max(10000).optional().describe('Max rows (default 100)'),
        skip: z.number().int().min(0).optional(),
        format: z.enum(['labels', 'raw', 'csv']).optional(),
        saveTo: z.string().optional(),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      const res = await rt.json.post<QbQueryResponse & Record<string, unknown>>(`/reports/${encodeURIComponent(args.reportId)}/run`, {
        query: { tableId: args.tableId, skip: args.skip, top: args.top ?? 100 },
        idempotent: true,
      });
      const d = res.data;
      if (Array.isArray(d?.data) && Array.isArray(d?.fields)) {
        return renderRows(ctx, d.data, d.fields, d.metadata?.totalRecords ?? d.data.length, args.format, args.saveTo, `report-${args.reportId}`);
      }
      return json(ctx, d, 'Report result');
    }),
  );

  server.registerTool(
    'run_formula',
    {
      title: 'Evaluate a Quickbase formula',
      description:
        'Evaluate a formula against a table (optionally one record) without creating a field. Use it to test formula syntax and results before adding a formula field, e.g. "If([Status]=\\"Open\\", ToDays(Today()-[Date Created]), 0)".',
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        formula: z.string().min(1),
        recordId: z.number().int().optional().describe('Record ID# to evaluate against'),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      const res = await rt.json.post('/formula/run', { body: { formula: args.formula, rid: args.recordId, from: args.tableId }, idempotent: true });
      return json(ctx, res.data, 'Formula result');
    }),
  );

  server.registerTool(
    'records_modified_since',
    {
      title: 'Records changed since a time',
      description: 'Which records were created, modified or deleted after a timestamp, optionally following the dependency graph through lookup fields. Ideal for incremental syncs and "what changed this shift" questions.',
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        after: z.string().describe('ISO-8601 UTC timestamp, e.g. 2026-11-04T06:00:00Z'),
        fieldList: z.array(z.number().int()).optional().describe('Field IDs whose source records should also be checked'),
        includeDetails: z.boolean().optional().describe('Return record IDs and change types (default true)'),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      const res = await rt.json.post('/records/modifiedSince', {
        body: { from: args.tableId, after: args.after, fieldList: args.fieldList, includeDetails: args.includeDetails ?? true },
        idempotent: true,
      });
      return json(ctx, res.data);
    }),
  );

  server.registerTool(
    'download_file',
    {
      title: 'Download a file attachment',
      description: 'Download a file attachment from a record into the workspace (latest version unless one is given).',
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        recordId: z.number().int(),
        fieldId: z.number().int().describe('File attachment field ID'),
        version: z.number().int().min(0).optional().describe('Version number (default: latest)'),
        saveTo: z.string().optional().describe('Workspace path (default files/<table>/<record>/<file name>)'),
        ...envParam(ctx),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      let version = args.version;
      let fileName: string | undefined;
      if (version === undefined) {
        const q = await rt.json.post<QbQueryResponse>('/records/query', {
          body: { from: args.tableId, select: [args.fieldId], where: `{3.EX.${args.recordId}}` },
          idempotent: true,
        });
        const cell = q.data.data?.[0]?.[String(args.fieldId)]?.value as { versions?: Array<{ versionNumber: number; fileName: string }> } | undefined;
        const versions = cell?.versions ?? [];
        if (!versions.length) throw new Error(`Record ${args.recordId} has no file in field ${args.fieldId}.`);
        const latest = versions.reduce((a, b) => (b.versionNumber > a.versionNumber ? b : a));
        version = latest.versionNumber;
        fileName = latest.fileName;
      }
      const res = await rt.json.get<string>(`/files/${args.tableId}/${args.recordId}/${args.fieldId}/${version}`, { accept: '*/*' });
      const disposition = res.headers.get('content-disposition') ?? '';
      fileName = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? fileName ?? `file-v${version}`;
      const bytes = Buffer.from(String(res.data ?? ''), 'base64');
      const target = args.saveTo ?? `files/${args.tableId}/${args.recordId}/${slugify(decodeURIComponent(fileName), 'file')}`;
      const abs = await ctx.workspace.writeBytes(target, bytes);
      return json(ctx, { saved: ctx.workspace.display(abs), fileName, bytes: bytes.length, version });
    }),
  );

  server.registerTool(
    'generate_document',
    {
      title: 'Generate a document from a template',
      description: 'Render a Quickbase document template (PDF, DOCX or HTML) for a record and save it to the workspace. Business/Enterprise plans; template edits can take ~15 minutes to reach the API.',
      inputSchema: z.object({
        templateId: z.number().int(),
        tableId: dbid('Table ID'),
        recordId: z.number().int().optional(),
        filename: z.string().describe('File name without extension'),
        format: z.enum(['pdf', 'docx', 'html']).optional(),
        pageSize: z.enum(['Letter', 'Legal', 'Tabloid', 'A3', 'A4', 'A5', 'A6']).optional(),
        orientation: z.enum(['portrait', 'landscape']).optional(),
        margin: z.string().optional().describe('"top right bottom left", e.g. "0.5 0.5 0.5 0.5"'),
        unit: z.enum(['in', 'cm', 'nm', 'px']).optional(),
        saveTo: z.string().optional(),
        ...envParam(ctx),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      const format = args.format ?? 'pdf';
      const res = await rt.json.get<Record<string, unknown>>(`/docTemplates/${args.templateId}/generate`, {
        query: {
          tableId: args.tableId,
          recordId: args.recordId,
          filename: args.filename,
          format,
          pageSize: args.pageSize,
          orientation: args.orientation,
          margin: args.margin,
          unit: args.unit,
          realm: rt.config.realm,
        },
        accept: 'application/json',
      });
      const d = res.data;
      const base64 = typeof d?.data === 'string' ? d.data : typeof d === 'string' ? (d as unknown as string) : '';
      if (!base64) return json(ctx, d, 'Unexpected response (no file data)');
      const bytes = Buffer.from(base64, 'base64');
      const name = typeof d?.fileName === 'string' ? d.fileName : `${args.filename}.${format}`;
      const abs = await ctx.workspace.writeBytes(args.saveTo ?? `documents/${slugify(name, `document.${format}`)}`, bytes);
      return json(ctx, { saved: ctx.workspace.display(abs), fileName: name, bytes: bytes.length, contentType: d?.contentType });
    }),
  );

  if (!ctx.config.allowWrites) return;

  server.registerTool(
    'upsert_records',
    {
      title: 'Insert or update records',
      description:
        'Insert and/or update records. Keys may be field IDs or labels; values are plain values (wrapped as {value} automatically). Records with the key field (Record ID# = 3, or mergeFieldId) update; others insert. File attachments: {"fileName": "x.pdf", "data": "<base64>"}.',
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        records: z.array(jsonObject).min(1).max(5000).describe('One object per record: { "<fid or label>": value }'),
        mergeFieldId: z.number().int().optional().describe('Unique field to match existing records on (default: the key field)'),
        fieldsToReturn: z.array(fieldRef).optional(),
        confirm: z.string().optional().describe('Required in protected environments: the environment name'),
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      ctx.assertWritable(rt, { action: `upsert ${args.records.length} record(s) into ${args.tableId}`, confirm: args.confirm });
      const fields = await rt.schema.fields(args.tableId);
      const data = args.records.map((rec) => {
        const row: Record<string, { value: unknown }> = {};
        for (const [k, v] of Object.entries(rec)) {
          const fid = resolveFieldRef(fields, k);
          row[String(fid)] = v && typeof v === 'object' && !Array.isArray(v) && 'value' in (v as object) ? (v as { value: unknown }) : { value: v };
        }
        return row;
      });
      const res = await rt.json.post<{ metadata?: Record<string, unknown>; data?: unknown[] }>('/records', {
        body: {
          to: args.tableId,
          data,
          mergeFieldId: args.mergeFieldId,
          fieldsToReturn: args.fieldsToReturn?.map((r) => resolveFieldRef(fields, r)) ?? [3],
        },
      });
      const meta = res.data?.metadata ?? {};
      const lineErrors = meta.lineErrors as Record<string, string[]> | undefined;
      return json(
        ctx,
        { metadata: meta, returned: res.data?.data?.slice(0, 50) },
        lineErrors && Object.keys(lineErrors).length ? 'Upsert finished WITH LINE ERRORS' : 'Upsert finished',
      );
    }),
  );

  if (!ctx.config.allowDestructive) return;

  server.registerTool(
    'delete_records',
    {
      title: 'Delete records (two-step)',
      description:
        'Delete the records matching a query. First call returns how many match and the exact confirm phrase; call again with that phrase to delete. To delete everything, use where "{3.GT.0}" explicitly.',
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        where: z.string().min(3).describe('Quickbase query selecting the records to delete'),
        confirm: z.string().optional(),
        ...envParam(ctx),
      }),
      annotations: REMOTE_DESTRUCTIVE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      const preview = await rt.json.post<QbQueryResponse>('/records/query', {
        body: { from: args.tableId, select: [3], where: args.where, options: { top: 5 } },
        idempotent: true,
      });
      const count = preview.data.metadata?.totalRecords ?? preview.data.data.length;
      const expected = ctx.expectedConfirm(rt, `delete:${args.tableId}:${count}`);
      if (count === 0) return text(`No records match ${args.where}; nothing to delete.`);
      if (args.confirm !== expected) {
        const ids = preview.data.data.map((r) => r['3']?.value).filter((v) => v !== undefined);
        return text(
          `Preview: ${count} record(s) in ${args.tableId} match ${args.where} (first IDs: ${ids.join(', ')}).\n` +
            `Nothing was deleted. Confirm with the user, then call again with confirm: "${expected}".`,
        );
      }
      ctx.assertWritable(rt, { action: `delete ${count} record(s) from ${args.tableId}`, destructive: true, confirm: args.confirm, expected: `delete:${args.tableId}:${count}` });
      const res = await rt.json.delete<{ numberDeleted: number }>('/records', { body: { from: args.tableId, where: args.where } });
      rt.schema.invalidateTable(args.tableId);
      return json(ctx, res.data, 'Deleted');
    }),
  );
}

async function renderRows(
  ctx: AppContext,
  data: Array<Record<string, { value: unknown }>>,
  fields: Array<{ id: number; label: string; type: string }>,
  total: number,
  format: 'labels' | 'raw' | 'csv' | undefined,
  saveTo: string | undefined,
  label: string,
) {
  const rows = format === 'raw' ? data : rowsToLabeled(data, fields);
  const meta = { returned: data.length, totalMatching: total, columns: fields.map((f) => `${f.id} ${f.label} (${f.type})`) };
  if (saveTo) {
    const content = format === 'csv' ? rowsToCsv(rowsToLabeled(data, fields)) : JSON.stringify(rows, null, 2) + '\n';
    const abs = await ctx.workspace.writeText(saveTo, content);
    return json(ctx, { ...meta, saved: ctx.workspace.display(abs), preview: (rows as unknown[]).slice(0, 5) }, `Saved ${data.length} row(s) from ${label}`);
  }
  if (format === 'csv') return text(`${data.length} of ${total} row(s)\n\n\`\`\`csv\n${rowsToCsv(rowsToLabeled(data, fields))}\`\`\``);
  return json(ctx, { ...meta, rows }, `${data.length} of ${total} row(s)`);
}
