/**
 * Schema changes. Registered only when QB_ALLOW_WRITES=true; deletes only when
 * QB_ALLOW_DESTRUCTIVE=true as well, and every delete needs an exact confirm
 * phrase that the first call returns.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { dbid, envParam, getEnvArg, json, jsonObject, REMOTE_DESTRUCTIVE, REMOTE_WRITE, safe, text } from './util.js';

const FIELD_TYPES =
  'text, text-multiple-choice, text-multi-line, rich-text, numeric, currency, rating, percent, multitext, email, url, duration, date, datetime, timeofday, checkbox, user, multiuser, address, phone, file';

const summaryField = z.object({
  summaryFid: z.number().int().optional().describe('Field on the child table to summarize (omit for COUNT)'),
  label: z.string().optional(),
  accumulationType: z.enum(['AVG', 'SUM', 'MAX', 'MIN', 'STD-DEV', 'COUNT', 'COMBINED-TEXT', 'COMBINED-USER', 'DISTINCT-COUNT']),
  where: z.string().optional().describe('Optional filter, Quickbase query syntax'),
});

export function registerSchemaWriteTools(server: McpServer, ctx: AppContext): void {
  if (!ctx.config.allowWrites) return;
  const confirm = z.string().optional().describe('Protected environments: the environment name');

  server.registerTool(
    'create_table',
    {
      title: 'Create a table',
      description: 'Create a table in an app. Built-in fields 1-5 are added automatically; add fields with create_field.',
      inputSchema: z.object({
        appId: dbid('App ID').optional(),
        name: z.string().min(1),
        description: z.string().optional(),
        singleRecordName: z.string().optional().describe('e.g. "Defect"'),
        pluralRecordName: z.string().optional().describe('e.g. "Defects"'),
        confirm,
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      ctx.assertWritable(rt, { action: `create table "${args.name}"`, confirm: args.confirm });
      const res = await rt.json.post('/tables', {
        query: { appId },
        body: { name: args.name, description: args.description, singleRecordName: args.singleRecordName, pluralRecordName: args.pluralRecordName },
      });
      rt.schema.invalidateApp(appId);
      return json(ctx, res.data, 'Table created');
    }),
  );

  server.registerTool(
    'update_table',
    {
      title: 'Update a table',
      description: 'Rename a table or change its description / record names.',
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        appId: dbid('App ID').optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        singleRecordName: z.string().optional(),
        pluralRecordName: z.string().optional(),
        confirm,
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      await ctx.assertTableAllowed(rt, args.tableId);
      ctx.assertWritable(rt, { action: `update table ${args.tableId}`, confirm: args.confirm });
      const res = await rt.json.post(`/tables/${args.tableId}`, {
        query: { appId },
        body: { name: args.name, description: args.description, singleRecordName: args.singleRecordName, pluralRecordName: args.pluralRecordName },
      });
      rt.schema.invalidateApp(appId);
      rt.schema.invalidateTable(args.tableId);
      return json(ctx, res.data, 'Table updated');
    }),
  );

  server.registerTool(
    'create_field',
    {
      title: 'Create a field',
      description: `Create a field. fieldType is one of: ${FIELD_TYPES}. For a formula field pass properties.formula (test it first with run_formula). Choices go in properties.choices.`,
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        label: z.string().min(1),
        fieldType: z.string().describe(FIELD_TYPES),
        fieldHelp: z.string().optional(),
        addToForms: z.boolean().optional(),
        appearsByDefault: z.boolean().optional(),
        audited: z.boolean().optional(),
        properties: jsonObject.optional().describe('e.g. {"formula": "..."}, {"choices": ["Open","Closed"]}, {"maxLength": 50}'),
        confirm,
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      ctx.assertWritable(rt, { action: `create field "${args.label}" in ${args.tableId}`, confirm: args.confirm });
      const { tableId, confirm: _c, env: _e, ...body } = args as typeof args & { env?: string };
      const res = await rt.json.post('/fields', { query: { tableId }, body });
      rt.schema.invalidateTable(tableId);
      return json(ctx, res.data, 'Field created');
    }),
  );

  server.registerTool(
    'update_field',
    {
      title: 'Update a field',
      description: 'Change a field\'s label, help text, required/unique flags or properties (e.g. formula, choices). Check get_field_usage before renaming: formulas reference fields by label.',
      inputSchema: z.object({
        tableId: dbid('Table ID'),
        fieldId: z.number().int(),
        label: z.string().optional(),
        fieldHelp: z.string().optional(),
        required: z.boolean().optional(),
        unique: z.boolean().optional(),
        appearsByDefault: z.boolean().optional(),
        properties: jsonObject.optional(),
        confirm,
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      ctx.assertWritable(rt, { action: `update field ${args.fieldId} in ${args.tableId}`, confirm: args.confirm });
      const { tableId, fieldId, confirm: _c, env: _e, ...body } = args as typeof args & { env?: string };
      const res = await rt.json.post(`/fields/${fieldId}`, { query: { tableId }, body });
      rt.schema.invalidateTable(tableId);
      return json(ctx, res.data, 'Field updated');
    }),
  );

  server.registerTool(
    'create_relationship',
    {
      title: 'Create a relationship',
      description: 'Create a parent-child relationship (both tables in the same app): a reference field on the child, plus optional lookup fields (parent FIDs) and summary fields on the parent.',
      inputSchema: z.object({
        childTableId: dbid('Child table ID'),
        parentTableId: dbid('Parent table ID'),
        foreignKeyLabel: z.string().optional().describe('Label for the new reference field, e.g. "Related Supplier"'),
        lookupFieldIds: z.array(z.number().int()).optional().describe('Parent field IDs to show on the child'),
        summaryFields: z.array(summaryField).optional(),
        confirm,
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.childTableId);
      await ctx.assertTableAllowed(rt, args.parentTableId);
      ctx.assertWritable(rt, { action: `relate ${args.childTableId} to parent ${args.parentTableId}`, confirm: args.confirm });
      const res = await rt.json.post(`/tables/${args.childTableId}/relationship`, {
        body: {
          parentTableId: args.parentTableId,
          foreignKeyField: args.foreignKeyLabel ? { label: args.foreignKeyLabel } : undefined,
          lookupFieldIds: args.lookupFieldIds,
          summaryFields: args.summaryFields,
        },
      });
      rt.schema.invalidateTable(args.childTableId);
      rt.schema.invalidateTable(args.parentTableId);
      return json(ctx, res.data, 'Relationship created');
    }),
  );

  server.registerTool(
    'update_relationship',
    {
      title: 'Add lookups/summaries to a relationship',
      description: 'Add lookup fields and/or summary fields to an existing relationship (nothing is removed).',
      inputSchema: z.object({
        childTableId: dbid('Child table ID'),
        relationshipId: z.number().int(),
        lookupFieldIds: z.array(z.number().int()).optional(),
        summaryFields: z.array(summaryField).optional(),
        confirm,
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.childTableId);
      ctx.assertWritable(rt, { action: `update relationship ${args.relationshipId}`, confirm: args.confirm });
      const res = await rt.json.post(`/tables/${args.childTableId}/relationship/${args.relationshipId}`, {
        body: { lookupFieldIds: args.lookupFieldIds, summaryFields: args.summaryFields },
      });
      rt.schema.invalidateTable(args.childTableId);
      return json(ctx, res.data, 'Relationship updated');
    }),
  );

  server.registerTool(
    'update_app',
    {
      title: 'Update app properties / variables',
      description: 'Change an app\'s name or description, or set app variables (handy for feature flags and thresholds read by formulas and code pages).',
      inputSchema: z.object({
        appId: dbid('App ID').optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        variables: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        confirm,
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      ctx.assertWritable(rt, { action: `update app ${appId}`, confirm: args.confirm });
      const res = await rt.json.post(`/apps/${appId}`, { body: { name: args.name, description: args.description, variables: args.variables } });
      rt.schema.invalidateApp(appId);
      return json(ctx, res.data, 'App updated');
    }),
  );

  if (!ctx.config.allowDestructive) return;

  server.registerTool(
    'delete_fields',
    {
      title: 'Delete fields (two-step)',
      description: 'Permanently delete fields and their data. The first call shows where each field is used and the confirm phrase; call again with it to delete.',
      inputSchema: z.object({ tableId: dbid('Table ID'), fieldIds: z.array(z.number().int()).min(1), confirm: z.string().optional(), ...envParam(ctx) }),
      annotations: REMOTE_DESTRUCTIVE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.tableId);
      const builtIn = args.fieldIds.filter((f) => f <= 5);
      if (builtIn.length) throw new Error(`Built-in fields cannot be deleted: ${builtIn.join(', ')}.`);
      const base = `delete-fields:${args.tableId}:${[...args.fieldIds].sort((a, b) => a - b).join(',')}`;
      const expected = ctx.expectedConfirm(rt, base);
      if (args.confirm !== expected) {
        const fields = await rt.schema.fields(args.tableId);
        const usage = await Promise.all(
          args.fieldIds.map(async (fid) => ({
            fieldId: fid,
            label: fields.find((f) => f.id === fid)?.label ?? '(not found)',
            usage: await rt.json.get(`/fields/usage/${fid}`, { query: { tableId: args.tableId } }).then((r) => r.data).catch((e: Error) => e.message),
          })),
        );
        return json(ctx, { willDelete: usage, confirmWith: expected }, 'Preview: nothing deleted yet', 'Show the user this usage, then call again with the confirm phrase.');
      }
      ctx.assertWritable(rt, { action: `delete fields ${args.fieldIds.join(', ')}`, destructive: true, confirm: args.confirm, expected: base });
      const res = await rt.json.delete('/fields', { query: { tableId: args.tableId }, body: { fieldIds: args.fieldIds } });
      rt.schema.invalidateTable(args.tableId);
      return json(ctx, res.data, 'Fields deleted');
    }),
  );

  server.registerTool(
    'delete_relationship',
    {
      title: 'Delete a relationship (two-step)',
      description: 'Delete a relationship with all its lookup and summary fields (the reference field itself is kept). Two-step confirmation.',
      inputSchema: z.object({ childTableId: dbid('Child table ID'), relationshipId: z.number().int(), confirm: z.string().optional(), ...envParam(ctx) }),
      annotations: REMOTE_DESTRUCTIVE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      await ctx.assertTableAllowed(rt, args.childTableId);
      const base = `delete-relationship:${args.childTableId}:${args.relationshipId}`;
      const expected = ctx.expectedConfirm(rt, base);
      if (args.confirm !== expected) {
        const rel = (await rt.schema.relationships(args.childTableId)).find((r) => r.id === args.relationshipId);
        if (!rel) throw new Error(`Relationship ${args.relationshipId} not found on ${args.childTableId}.`);
        return json(ctx, { relationship: rel, confirmWith: expected }, 'Preview: nothing deleted yet');
      }
      ctx.assertWritable(rt, { action: `delete relationship ${args.relationshipId}`, destructive: true, confirm: args.confirm, expected: base });
      const res = await rt.json.delete(`/tables/${args.childTableId}/relationship/${args.relationshipId}`);
      rt.schema.invalidateTable(args.childTableId);
      return json(ctx, res.data, 'Relationship deleted');
    }),
  );

  server.registerTool(
    'delete_table',
    {
      title: 'Delete a table (two-step)',
      description: 'Permanently delete a table and all of its records. Two-step confirmation.',
      inputSchema: z.object({ tableId: dbid('Table ID'), appId: dbid('App ID').optional(), confirm: z.string().optional(), ...envParam(ctx) }),
      annotations: REMOTE_DESTRUCTIVE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      await ctx.assertTableAllowed(rt, args.tableId);
      const base = `delete-table:${args.tableId}`;
      const expected = ctx.expectedConfirm(rt, base);
      if (args.confirm !== expected) {
        const t = await rt.schema.table(appId, args.tableId);
        return text(`Preview: table "${t.name}" (${args.tableId}, next record ID ${t.nextRecordId ?? '?'}) and ALL its records would be deleted. Nothing deleted yet. Confirm with the user, then call again with confirm: "${expected}".`);
      }
      ctx.assertWritable(rt, { action: `delete table ${args.tableId}`, destructive: true, confirm: args.confirm, expected: base });
      const res = await rt.json.delete(`/tables/${args.tableId}`, { query: { appId } });
      rt.schema.invalidateApp(appId);
      return json(ctx, res.data, 'Table deleted');
    }),
  );
}
