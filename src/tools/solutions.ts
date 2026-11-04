/**
 * Solutions / QBL: the only API surface that covers forms, dashboards, roles,
 * code pages and (for supported channels) pipelines as schema. Enterprise
 * plans only since January 2026.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext, EnvRuntime } from '../context.js';
import { extractQblResource, QBL_TYPE_HINTS, summarizeQbl } from '../solutions/qbl.js';
import { slugify } from '../workspace.js';
import { envParam, getEnvArg, json, LOCAL_WRITE, READ_ONLY, REMOTE_WRITE, safe, text } from './util.js';

const solutionId = z.string().min(1).describe('Solution ID (UUID) or alias');

function qblHeaders(ctx: AppContext): Record<string, string> {
  return ctx.config.qblVersion ? { 'QBL-Version': ctx.config.qblVersion } : {};
}

async function qblSource(ctx: AppContext, args: { path?: string; qbl?: string }): Promise<{ text: string; from: string }> {
  if (args.qbl) return { text: args.qbl, from: 'inline' };
  if (args.path) return { text: await ctx.workspace.readText(args.path), from: args.path };
  throw new Error('Pass path (a QBL file in the workspace) or qbl (text).');
}

function summaryView(s: ReturnType<typeof summarizeQbl>) {
  return {
    qblVersion: s.qblVersion ?? null,
    resourcesByType: Object.fromEntries(Object.entries(s.countsByType).map(([t, n]) => [`${t}${QBL_TYPE_HINTS[t] ? ` (${QBL_TYPE_HINTS[t]})` : ''}`, n])),
    resources: s.resources.slice(0, 400),
    parameters: s.parameters,
    refs: s.refCount,
    badRefs: s.badRefs,
    errors: s.errors,
  };
}

export function registerSolutionTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'export_solution',
    {
      title: 'Export a solution (QBL)',
      description:
        'Export a solution as QBL YAML into the workspace and summarize it: resources by type (apps, tables, forms, reports, dashboards, roles, code pages, pipelines), parameters, and !BadRef entries that would break an install. Enterprise plans.',
      inputSchema: z.object({ solutionId, saveTo: z.string().optional(), ...envParam(ctx) }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const res = await rt.json.get<string>(`/solutions/${encodeURIComponent(args.solutionId)}`, {
        accept: 'application/x-yaml, text/yaml;q=0.9, application/json;q=0.5',
        headers: qblHeaders(ctx),
      });
      const qbl = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const abs = await ctx.workspace.writeText(args.saveTo ?? `solutions/${rt.name}/${slugify(args.solutionId)}-${stamp}.qbl.yaml`, qbl);
      return json(ctx, { saved: ctx.workspace.display(abs), bytes: qbl.length, ...summaryView(summarizeQbl(qbl)) }, 'Solution exported');
    }),
  );

  server.registerTool(
    'get_solution_info',
    {
      title: 'Get solution information',
      description: 'Metadata and resources of a solution, including the real and logical IDs of the apps and pipelines it contains.',
      inputSchema: z.object({ solutionId, ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      return json(ctx, (await rt.json.get(`/solutions/${encodeURIComponent(args.solutionId)}/resources`)).data);
    }),
  );

  server.registerTool(
    'inspect_qbl',
    {
      title: 'Inspect QBL',
      description:
        'Summarize a QBL file, or extract one resource by logical ID (e.g. a form "$Form_Defect_Entry" or code page "$CodePage_KPI"). For QB::CodePage resources the page source can be written to a workspace file.',
      inputSchema: z.object({
        path: z.string().optional(),
        qbl: z.string().optional(),
        resource: z.string().optional().describe('Logical ID to extract, e.g. $Table_Defects'),
        type: z.string().optional().describe('List only resources of this Type, e.g. QB::FormV2'),
        extractCodeTo: z.string().optional().describe('For a QB::CodePage resource: write its code to this workspace path'),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const src = await qblSource(ctx, args);
      if (!args.resource) {
        const s = summarizeQbl(src.text);
        const view = summaryView(s);
        if (args.type) view.resources = s.resources.filter((r) => r.type === args.type);
        return json(ctx, { source: src.from, ...view });
      }
      const r = extractQblResource(src.text, args.resource);
      if (!r) throw new Error(`No resource "${args.resource}" in ${src.from}. Use inspect_qbl without resource to list logical IDs.`);
      let saved: string | undefined;
      if (args.extractCodeTo && r.code) saved = ctx.workspace.display(await ctx.workspace.writeText(args.extractCodeTo, r.code));
      return text(`### ${args.resource} (${r.type}${r.name ? `, "${r.name}"` : ''})${saved ? `\nCode written to ${saved}` : ''}\n\n\`\`\`yaml\n${r.yaml.slice(0, ctx.config.maxOutputChars)}\n\`\`\``);
    }),
  );

  server.registerTool(
    'preview_solution_changes',
    {
      title: 'Preview solution changes',
      description: 'Dry run: the list of changes Quickbase would make if this QBL were applied to the solution. Nothing is changed. Always run before apply_solution.',
      inputSchema: z.object({ solutionId, path: z.string().optional(), qbl: z.string().optional(), ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const src = await qblSource(ctx, args);
      const res = await rt.json.put(`/solutions/${encodeURIComponent(args.solutionId)}/changeset`, {
        text: src.text,
        contentType: 'application/x-yaml',
        headers: qblHeaders(ctx),
        idempotent: true,
      });
      return json(ctx, res.data, 'Changes that would be applied');
    }),
  );

  if (!ctx.config.allowWrites) return;

  server.registerTool(
    'apply_solution',
    {
      title: 'Create or update a solution from QBL',
      description:
        'Apply QBL: create a new solution, or update an existing one. Run preview_solution_changes first and show the user the changes. Requires confirm "update:<solutionId>" or "create-solution" (prefixed with the environment name in protected environments).',
      inputSchema: z.object({
        mode: z.enum(['create', 'update']),
        solutionId: z.string().optional().describe('Required for update'),
        path: z.string().optional(),
        qbl: z.string().optional(),
        confirm: z.string().optional(),
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt: EnvRuntime = ctx.env(getEnvArg(args));
      const src = await qblSource(ctx, args);
      const summary = summarizeQbl(src.text);
      if (summary.errors.length) throw new Error(`QBL does not parse: ${summary.errors.join('; ')}`);
      if (summary.badRefs.length) throw new Error(`QBL contains ${summary.badRefs.length} !BadRef entr${summary.badRefs.length === 1 ? 'y' : 'ies'} (${summary.badRefs.slice(0, 5).map((b) => b.path).join(', ')}). Fix them before applying.`);
      if (args.mode === 'update') {
        if (!args.solutionId) throw new Error('mode "update" needs solutionId.');
        ctx.assertWritable(rt, { action: `update solution ${args.solutionId}`, confirm: args.confirm, expected: `update:${args.solutionId}` });
        const res = await rt.json.put(`/solutions/${encodeURIComponent(args.solutionId)}`, { text: src.text, contentType: 'application/x-yaml', headers: qblHeaders(ctx) });
        return json(ctx, res.data, 'Solution updated');
      }
      ctx.assertWritable(rt, { action: 'create a solution', confirm: args.confirm, expected: 'create-solution' });
      const res = await rt.json.post('/solutions', { text: src.text, contentType: 'application/x-yaml', headers: qblHeaders(ctx) });
      return json(ctx, res.data, 'Solution created');
    }),
  );
}
