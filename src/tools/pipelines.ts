/**
 * Pipelines work on YAML in the workspace. Quickbase has no public API to
 * list, export or import pipelines one by one: export them in the UI
 * (Pipelines > ⋮ > Export > Download YAML) into the workspace `pipelines/`
 * folder, and import them back with Pipelines > Import. On Enterprise plans,
 * pipelines with supported channels also travel inside solutions (QBL).
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { lintPipeline } from '../pipelines/lint.js';
import { parsePipelineYaml } from '../pipelines/parse.js';
import { remapPipeline } from '../pipelines/remap.js';
import { dbid, envParam, getEnvArg, json, jsonObject, LOCAL_WRITE, READ_ONLY, safe, text } from './util.js';

const IMPORT_STEPS =
  'Import: Quickbase > Pipelines > My Pipelines > Import, paste or choose the YAML, replace any account placeholders, review, then turn the pipeline on (imports start disabled; the importing user becomes the owner; Quickbase auth tokens are never exported).';

export function registerPipelineTools(server: McpServer, ctx: AppContext): void {
  const envNames = ctx.envNames as [string, ...string[]];

  server.registerTool(
    'list_pipeline_files',
    {
      title: 'List pipeline YAML files',
      description: 'List pipeline YAML exports in the workspace (default folder pipelines/) with their pipeline names.',
      inputSchema: z.object({ dir: z.string().optional().describe('Workspace folder (default "pipelines")') }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const files = await ctx.workspace.list(args.dir ?? 'pipelines', /\.ya?ml$/i);
      const out = [];
      for (const f of files) {
        const head = (await ctx.workspace.readText(f.path)).slice(0, 4000);
        const name = head.match(/-\s+META:\s*\n\s+name:\s*(.+)/)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
        out.push({ ...f, pipeline: name ?? null });
      }
      return json(ctx, { folder: args.dir ?? 'pipelines', count: out.length, files: out }, undefined, out.length ? undefined : `No YAML files yet. Export pipelines from Quickbase into ${ctx.workspace.root}/pipelines/.`);
    }),
  );

  server.registerTool(
    'inspect_pipeline',
    {
      title: 'Inspect and lint a pipeline',
      description:
        'Parse a pipeline YAML export (file or text): steps, channels, account slugs, tables and fields touched, Jinja step references. With checkSchema (default true) every table ID and field ID is checked against the live realm, which catches pipelines broken by a DEV->PROD move or a solution install.',
      inputSchema: z.object({
        path: z.string().optional().describe('Workspace path to a .yaml export'),
        yaml: z.string().optional().describe('Raw YAML text'),
        checkSchema: z.boolean().optional(),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const source = args.yaml ?? (args.path ? await ctx.workspace.readText(args.path) : undefined);
      if (!source) throw new Error('Pass path or yaml.');
      const parsed = parsePipelineYaml(source);
      const rt = args.checkSchema === false ? null : ctx.env(getEnvArg(args));
      const lint = await lintPipeline(parsed, rt ? { fields: async (tableId) => rt.schema.fields(tableId).catch(() => null) } : undefined);
      const order = { error: 0, warning: 1, info: 2 } as const;
      lint.issues.sort((a, b) => order[a.severity] - order[b.severity]);
      const errors = lint.issues.filter((i) => i.severity === 'error').length;
      return json(
        ctx,
        {
          pipeline: parsed.name ?? null,
          enabled: parsed.enabled ?? null,
          accounts: parsed.accountSlugs,
          channels: parsed.channels,
          tables: lint.tables,
          steps: parsed.steps.map((s) => ({
            step: s.letter ?? null,
            kind: s.kind,
            on: s.target ? `${s.target}<>` : undefined,
            channel: s.channel,
            account: s.slug,
            resource: s.resource,
            action: s.action,
            table: s.tableId,
            exportFields: s.exportFieldIds.length ? s.exportFieldIds : undefined,
            triggerFields: s.triggerFieldIds.length ? s.triggerFieldIds : undefined,
            queryFields: s.queryFieldIds.length ? s.queryFieldIds : undefined,
            inputs: s.inputKeys.length ? s.inputKeys : undefined,
            refs: s.jinjaRefs.length ? [...new Set(s.jinjaRefs.map((r) => `${r.step}.${r.attr}`))] : undefined,
            conditions: s.conditions.length ? s.conditions : undefined,
          })),
          issues: lint.issues,
        },
        `${parsed.name ?? 'Pipeline'}: ${parsed.steps.length} step(s), ${errors} error(s)`,
      );
    }),
  );

  server.registerTool(
    'remap_pipeline',
    {
      title: 'Promote a pipeline to another app/environment',
      description:
        'Rewrite a pipeline export for another app or environment (DEV -> TEST -> PROD): table IDs, account slugs and (for mapped tables) field IDs in export_fields / trigger_fields / query. autoMap matches tables by name and fields by label between the source and target apps. Writes a new YAML file and reports every change plus anything needing manual review. Nothing is sent to Quickbase.',
      inputSchema: z.object({
        path: z.string().optional(),
        yaml: z.string().optional(),
        tableMap: z.record(z.string(), z.string()).optional().describe('{ "<source table id>": "<target table id>" }'),
        slugMap: z.record(z.string(), z.string()).optional().describe('{ "<old account slug>": "<new slug>" }, e.g. {"o4OvZbK": "Xy12AbC"}'),
        autoMap: z
          .object({
            sourceAppId: dbid('Source app ID'),
            targetAppId: dbid('Target app ID'),
            ...(ctx.multiEnv ? { sourceEnv: z.enum(envNames).optional(), targetEnv: z.enum(envNames).optional() } : {}),
          })
          .optional()
          .describe('Build tableMap/fieldMap by matching names between two apps'),
        rewriteFieldIds: z.boolean().optional().describe('Remap field IDs too (default true with autoMap)'),
        rename: z.string().optional().describe('New META name, e.g. "Create BOM Records (PROD)"'),
        saveTo: z.string().optional().describe('Output path (default: next to the input, suffixed .remapped.yaml)'),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const source = args.yaml ?? (args.path ? await ctx.workspace.readText(args.path) : undefined);
      if (!source) throw new Error('Pass path or yaml.');
      const parsed = parsePipelineYaml(source);
      const tableMap: Record<string, string> = { ...(args.tableMap ?? {}) };
      const fieldMap: Record<string, Record<string, number>> = {};
      const unmatched: string[] = [];

      if (args.autoMap) {
        const am = args.autoMap as { sourceAppId: string; targetAppId: string; sourceEnv?: string; targetEnv?: string };
        const src = ctx.env(am.sourceEnv);
        const dst = ctx.env(am.targetEnv);
        ctx.assertAppAllowed(am.sourceAppId);
        ctx.assertAppAllowed(am.targetAppId);
        const [srcTables, dstTables] = await Promise.all([src.schema.tables(am.sourceAppId), dst.schema.tables(am.targetAppId)]);
        const byName = new Map(dstTables.map((t) => [t.name.trim().toLowerCase(), t]));
        const used = new Set([...parsed.tables, ...parsed.steps.flatMap((s) => s.bodyDbids)]);
        for (const t of srcTables) {
          if (!used.has(t.id)) continue;
          const match = byName.get(t.name.trim().toLowerCase());
          if (!match) {
            unmatched.push(`table "${t.name}" (${t.id}) has no same-named table in ${am.targetAppId}`);
            continue;
          }
          tableMap[t.id] ??= match.id;
          if (args.rewriteFieldIds !== false) {
            const [sf, df] = await Promise.all([src.schema.fields(t.id), dst.schema.fields(match.id)]);
            const dstByLabel = new Map(df.map((f) => [f.label.trim().toLowerCase(), f.id]));
            const m: Record<string, number> = {};
            for (const f of sf) {
              const to = dstByLabel.get(f.label.trim().toLowerCase());
              if (to === undefined) {
                if (f.id > 5) unmatched.push(`field "${f.label}" (${t.name}.${f.id}) has no same-labeled field in the target table`);
              } else if (to !== f.id) m[String(f.id)] = to;
            }
            if (Object.keys(m).length) fieldMap[t.id] = m;
          }
        }
      }

      const result = remapPipeline(source, { tableMap, slugMap: args.slugMap, fieldMap: args.rewriteFieldIds === false ? undefined : fieldMap, rename: args.rename });
      const out = args.saveTo ?? (args.path ? args.path.replace(/\.ya?ml$/i, '') + '.remapped.yaml' : 'pipelines/remapped.yaml');
      const abs = await ctx.workspace.writeText(out, result.text);
      const after = parsePipelineYaml(result.text);
      return json(
        ctx,
        {
          saved: ctx.workspace.display(abs),
          changes: result.changes,
          review: [...result.review, ...unmatched],
          parsesCleanly: after.errors.length === 0,
          next: `Run inspect_pipeline on ${ctx.workspace.display(abs)} against the target environment, then import it. ${IMPORT_STEPS}`,
        },
        `${result.changes.length} change(s)`,
      );
    }),
  );

  server.registerTool(
    'save_pipeline',
    {
      title: 'Save pipeline YAML',
      description: 'Write pipeline YAML into the workspace after checking that it parses and is in export format. Use for new or edited pipelines you will import in the Quickbase UI.',
      inputSchema: z.object({
        path: z.string().describe('Workspace path, e.g. pipelines/defect-escalation.yaml'),
        yaml: z.string(),
        overwrite: z.boolean().optional(),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const parsed = parsePipelineYaml(args.yaml);
      if (parsed.errors.length) return text(`Not saved; the YAML has problems:\n- ${parsed.errors.join('\n- ')}`);
      if (!args.overwrite && ctx.workspace.exists(args.path)) return text(`Not saved: ${args.path} exists. Pass overwrite: true to replace it.`);
      const abs = await ctx.workspace.writeText(args.path, args.yaml.endsWith('\n') ? args.yaml : `${args.yaml}\n`);
      return text(`Saved ${ctx.workspace.display(abs)} (${parsed.steps.length} steps). ${IMPORT_STEPS}`);
    }),
  );

  const hooks = Object.keys(ctx.config.pipelineWebhooks);
  if (!ctx.config.allowWrites || hooks.length === 0) return;

  server.registerTool(
    'trigger_pipeline',
    {
      title: 'Trigger a pipeline webhook',
      description: `POST a JSON payload to a pipeline's incoming webhook. Only webhooks named in the config file can be called: ${hooks.join(', ')}.`,
      inputSchema: z.object({
        webhook: z.enum(hooks as [string, ...string[]]),
        payload: jsonObject.optional(),
        confirm: z.string().optional().describe('Protected environments: the environment name'),
        ...envParam(ctx),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      ctx.assertWritable(rt, { action: `trigger pipeline webhook "${args.webhook}"`, confirm: args.confirm });
      const hook = ctx.config.pipelineWebhooks[args.webhook];
      const res = await ctx.fetchImpl(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args.payload ?? {}),
        signal: AbortSignal.timeout(ctx.config.timeoutMs),
      });
      const body = (await res.text()).slice(0, 2000);
      return json(ctx, { webhook: args.webhook, status: res.status, body }, res.ok ? 'Triggered' : 'Webhook returned an error');
    }),
  );
}
