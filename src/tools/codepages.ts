/** Code pages over the XML API: pull, diff, analyze, discover, deploy (drift-protected). */

import { existsSync, readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext, EnvRuntime } from '../context.js';
import { analyzeCodePage, checkAgainstSchema } from '../codepages/analyze.js';
import { buildPage, findPlaceholders, gitSha, normalise, readStamp, stripStamp, type FieldMap } from '../codepages/build.js';
import { lineStats, unifiedDiff } from '../codepages/diff.js';
import { contentHash, loadState, saveState, stateKey } from '../codepages/state.js';
import { QuickbaseXmlError } from '../quickbase/errors.js';
import { mapLimit, toCamelKey } from '../quickbase/schema.js';
import { slugify } from '../workspace.js';
import { dbid, envParam, getEnvArg, json, LOCAL_WRITE, READ_ONLY, REMOTE_WRITE, safe, text } from './util.js';

const INLINE_LIMIT = 40_000;

const pageSelector = {
  pageId: z.number().int().positive().optional().describe('Code page ID (from the page URL: ?a=dbpage&pageID=12)'),
  pageName: z.string().optional().describe('Code page name, e.g. "KPI.html" (IDs are safer: names can be duplicated)'),
  target: z.string().optional().describe('A code page target from the config file (resolves the page ID per environment)'),
};

function pageUrl(rt: EnvRuntime, appId: string, pageId: string | number): string {
  return `https://${rt.config.realm}/db/${appId}?a=dbpage&pageID=${pageId}`;
}

function resolvePage(ctx: AppContext, rt: EnvRuntime, args: { pageId?: number; pageName?: string; target?: string }) {
  if (args.target) {
    const t = ctx.config.targets[args.target];
    if (!t) throw new Error(`Unknown target "${args.target}". Configured targets: ${Object.keys(ctx.config.targets).join(', ') || '(none)'}.`);
    const id = t.pageIds[rt.name];
    return { ref: id ? Number(id) : undefined, pageName: t.pageName ?? t.name, src: t.src, targetName: t.name };
  }
  if (args.pageId) return { ref: args.pageId, pageName: args.pageName, src: undefined, targetName: `page-${args.pageId}` };
  if (args.pageName) return { ref: undefined, pageName: args.pageName, src: undefined, targetName: slugify(args.pageName) };
  throw new Error('Pass pageId, pageName or target.');
}

/** Field map for __QB_FIELD:table.field__ placeholders: config/fields.<env>.json, else built live from table aliases. */
async function fieldMapFor(ctx: AppContext, rt: EnvRuntime): Promise<FieldMap | null> {
  const file = ctx.workspace.resolve(`config/fields.${rt.name}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as FieldMap;
  const aliases = { ...(ctx.config.tableAliases['*'] ?? {}), ...(ctx.config.tableAliases[rt.name] ?? {}) };
  if (!Object.keys(aliases).length) return null;
  const map: FieldMap = {};
  for (const [alias, tableId] of Object.entries(aliases)) {
    map[alias] = {};
    for (const f of await rt.schema.fields(tableId)) map[alias][toCamelKey(f.label) || `field${f.id}`] = f.id;
  }
  return map;
}

export function registerCodePageTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'get_code_page',
    {
      title: 'Get a code page',
      description:
        'Read a code page (HTML/JS stored in the app) via the XML API. Small pages are returned inline; large ones are saved to the workspace and summarized (title, stamp, size). Pass saveTo to pull the page into your repo, e.g. DEVEnvironment/DevKPI.html.',
      inputSchema: z.object({
        ...pageSelector,
        appId: dbid('App ID').optional(),
        saveTo: z.string().optional().describe('Workspace path to write the page to'),
        inline: z.enum(['auto', 'always', 'never']).optional().describe(`auto (default): inline when under ${INLINE_LIMIT} characters`),
        ...envParam(ctx),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      const page = resolvePage(ctx, rt, args);
      const ref = page.ref ?? page.pageName;
      if (ref === undefined) throw new Error(`Target "${args.target}" has no page ID for environment "${rt.name}".`);
      const content = await rt.xml.getPage(appId, ref);
      const stamp = readStamp(content);
      const info = {
        appId,
        page: ref,
        url: typeof ref === 'number' ? pageUrl(rt, appId, ref) : undefined,
        bytes: Buffer.byteLength(content),
        lines: content.split('\n').length,
        title: content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null,
        stamp,
      };
      let saved: string | undefined;
      const inline = args.inline ?? 'auto';
      if (args.saveTo || inline === 'never' || (inline === 'auto' && content.length > INLINE_LIMIT)) {
        const target = args.saveTo ?? `.quickbase/codepages/${rt.name}/${appId}/${typeof ref === 'number' ? ref : slugify(String(ref))}.html`;
        saved = ctx.workspace.display(await ctx.workspace.writeText(target, content));
      }
      const showInline = inline === 'always' || (inline === 'auto' && content.length <= INLINE_LIMIT);
      const head = json(ctx, { ...info, saved }, `Code page ${ref}`).content[0].text;
      return text(showInline ? `${head}\n\n\`\`\`html\n${content}\n\`\`\`` : `${head}\n\nContent not inlined (${info.bytes} bytes). Read ${saved} with your file tools, or call again with inline: "always".`);
    }),
  );

  server.registerTool(
    'diff_code_page',
    {
      title: 'Diff local file vs live code page',
      description: 'Compare a workspace file with the live page (build stamps ignored, __QB_FIELD__ placeholders resolved). Also reports drift: whether the live page changed since the last deploy from this workspace.',
      inputSchema: z.object({
        localPath: z.string().optional().describe('Workspace file (default: the target\'s src)'),
        ...pageSelector,
        appId: dbid('App ID').optional(),
        context: z.number().int().min(0).max(20).optional().describe('Context lines (default 3)'),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      const page = resolvePage(ctx, rt, args);
      const localPath = args.localPath ?? page.src;
      if (!localPath) throw new Error('Pass localPath (or a target with src).');
      const ref = page.ref ?? page.pageName;
      if (ref === undefined) throw new Error('The page has no ID in this environment yet; nothing to diff against.');
      const source = await ctx.workspace.readText(localPath);
      const map = findPlaceholders(source).length ? await fieldMapFor(ctx, rt) : null;
      const local = buildPage({ source, fieldMap: map, target: page.targetName, envName: rt.name, sha: 'diff', stamp: false }).bare;
      const live = await rt.xml.getPage(appId, ref);
      const liveBare = normalise(stripStamp(live));
      const stats = lineStats(liveBare, local);
      const prev = loadState(ctx.workspace.root)[stateKey(rt.name, page.targetName)];
      const drift = prev ? (prev.hash === contentHash(liveBare) ? 'none (live page matches the last deploy)' : 'DRIFT: the live page changed since the last deploy') : 'unknown (no deploy recorded from this workspace)';
      const diff = stats.unchanged ? '' : unifiedDiff(liveBare, local, { before: `live:${ref}`, after: localPath }, args.context ?? 3);
      return text(
        [`Live page ${ref} vs ${localPath}: ${stats.unchanged ? 'identical' : `+${stats.added} / -${stats.removed} lines`}.`, `Live stamp: ${JSON.stringify(readStamp(live))}`, `Drift: ${drift}`, diff ? '```diff\n' + diff + '\n```' : '']
          .filter(Boolean)
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'analyze_code_page',
    {
      title: 'Review a code page',
      description:
        'Static review of a code page (workspace file, live page, or raw content): every table ID and field ID it uses checked against the live schema, embedded user tokens, missing temp-token auth, unpinned CDN scripts, unescaped innerHTML, hardcoded FIDs. Run before every deploy.',
      inputSchema: z.object({
        localPath: z.string().optional(),
        content: z.string().optional().describe('Raw page content'),
        ...pageSelector,
        appId: dbid('App ID').optional(),
        checkSchema: z.boolean().optional().describe('Cross-check IDs against the live schema (default true)'),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      let source = args.content;
      let label = 'content';
      if (!source && args.localPath) {
        source = await ctx.workspace.readText(args.localPath);
        label = args.localPath;
      }
      if (!source && (args.pageId || args.pageName || args.target)) {
        const appId = ctx.appId(rt, args.appId);
        const page = resolvePage(ctx, rt, args);
        const ref = page.ref ?? page.pageName;
        if (ref === undefined) throw new Error('That target has no page ID in this environment.');
        source = await rt.xml.getPage(appId, ref);
        label = `live page ${ref}`;
      }
      if (!source) throw new Error('Pass localPath, content, pageId, pageName or target.');
      const analysis = analyzeCodePage(source);
      let schemaCheck;
      if (args.checkSchema !== false && analysis.dbids.length) {
        const names = new Map<string, string>();
        if (rt.config.appId || args.appId) {
          try {
            for (const t of await rt.schema.tables(ctx.appId(rt, args.appId))) names.set(t.id, t.name);
          } catch {
            /* names are a nicety */
          }
        }
        schemaCheck = await checkAgainstSchema(analysis, async (tableId) => {
          try {
            return { name: names.get(tableId), fields: await rt.schema.fields(tableId) };
          } catch {
            return null;
          }
        });
      }
      const findings = [...analysis.findings, ...(schemaCheck?.findings ?? [])].sort((a, b) => rank(a.severity) - rank(b.severity));
      const counts = { error: findings.filter((f) => f.severity === 'error').length, warning: findings.filter((f) => f.severity === 'warning').length };
      return json(
        ctx,
        {
          source: label,
          summary: { bytes: analysis.bytes, lines: analysis.lines, title: analysis.title, stamp: analysis.stamp, ...counts },
          findings,
          tables: schemaCheck?.tables ?? analysis.dbids,
          fieldConstants: schemaCheck?.fields ?? analysis.fidConstants,
          queryFieldIds: analysis.queryFieldIds,
          placeholders: analysis.placeholders,
          externalScripts: analysis.externalScripts,
          externalFetchHosts: analysis.externalFetchHosts,
          realmHosts: analysis.realmHosts,
        },
        `Review: ${counts.error} error(s), ${counts.warning} warning(s)`,
      );
    }),
  );

  server.registerTool(
    'discover_code_pages',
    {
      title: 'Discover code pages by ID',
      description:
        'Quickbase has no API to list code pages, so this probes a range of page IDs with API_GetDBPage and reports the ones that exist (ID, title, size, build stamp). Bounded and rate-limited; use a small range first.',
      inputSchema: z.object({
        appId: dbid('App ID').optional(),
        fromId: z.number().int().min(1).optional().describe('Default 1'),
        toId: z.number().int().min(1).optional().describe('Default 40; at most 300 IDs per call'),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      const from = args.fromId ?? 1;
      const to = Math.min(args.toId ?? 40, from + 299);
      const ids = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      let authError: string | undefined;
      const found = (
        await mapLimit(ids, 3, async (id) => {
          if (authError) return null;
          try {
            const content = await rt.xml.getPage(appId, id);
            if (!content.trim()) return null;
            return {
              pageId: id,
              title: content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null,
              bytes: Buffer.byteLength(content),
              stamp: readStamp(content),
              url: pageUrl(rt, appId, id),
            };
          } catch (err) {
            if (err instanceof QuickbaseXmlError && err.isAuthError) authError = err.message;
            return null;
          }
        })
      ).filter(Boolean);
      if (authError) throw new Error(`Stopped: ${authError}`);
      return json(ctx, { appId, scanned: `${from}-${to}`, found }, `${found.length} code page(s) found`, found.length === 0 ? 'None in this range; try a higher range.' : undefined);
    }),
  );

  if (!ctx.config.allowWrites) return;

  server.registerTool(
    'deploy_code_page',
    {
      title: 'Deploy a code page',
      description:
        'Create or replace a code page from a workspace file (or content). Resolves __QB_FIELD:table.field__ placeholders, adds a build stamp (git SHA), and refuses to overwrite a page edited in the browser since the last deploy (drift) unless force is set. Use dryRun to see the diff first. Replacing requires pageId/target; creating requires pageName.',
      inputSchema: z.object({
        localPath: z.string().optional(),
        content: z.string().optional(),
        ...pageSelector,
        appId: dbid('App ID').optional(),
        stamp: z.boolean().optional().describe('Add the qb-deploy build stamp (default true)'),
        dryRun: z.boolean().optional().describe('Show what would change; send nothing'),
        force: z.boolean().optional().describe('Overwrite even if drift was detected'),
        confirm: z.string().optional().describe('Protected environments: the environment name'),
        ...envParam(ctx),
      }),
      annotations: REMOTE_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      const page = resolvePage(ctx, rt, args);
      const localPath = args.localPath ?? page.src;
      const source = args.content ?? (localPath ? await ctx.workspace.readText(localPath) : undefined);
      if (source === undefined) throw new Error('Pass localPath, content, or a target with src.');
      const map = findPlaceholders(source).length ? await fieldMapFor(ctx, rt) : null;
      const sha = gitSha(ctx.workspace.root);
      const built = buildPage({ source, fieldMap: map, target: page.targetName, envName: rt.name, sha, stamp: args.stamp !== false });
      const review = analyzeCodePage(built.body).findings.filter((f) => f.severity === 'error');
      if (review.length) throw new Error(`Deploy blocked by review errors:\n- ${review.map((f) => f.message).join('\n- ')}`);

      const state = loadState(ctx.workspace.root);
      const key = stateKey(rt.name, page.targetName);

      if (page.ref === undefined) {
        const pageName = page.pageName;
        if (!pageName) throw new Error('Creating a page needs pageName (or a target with pageName).');
        const warn = /\.[a-z0-9]+$/i.test(pageName) ? '' : ' Warning: the name has no extension, so Quickbase will serve it as plain text.';
        if (args.dryRun) return text(`Dry run: would CREATE "${pageName}" in ${appId} (${built.bare.split('\n').length} lines).${warn}`);
        ctx.assertWritable(rt, { action: `create code page "${pageName}"`, confirm: args.confirm });
        const pageId = await rt.xml.putPage(appId, { pageName, body: built.body });
        if (pageId) {
          // Later deploys address an ad-hoc page by ID (target "page-<id>"), so record it under that key.
          const createdKey = args.target ? key : stateKey(rt.name, `page-${pageId}`);
          state[createdKey] = { hash: contentHash(built.bare), pageId, at: new Date().toISOString(), sha, by: 'quickbase-mcp-server' };
          saveState(ctx.workspace.root, state);
        }
        return json(ctx, { created: true, pageId, url: pageId ? pageUrl(rt, appId, pageId) : undefined, stamp: built.stamp, note: `Record pageIds.${rt.name} = "${pageId}" for this target in the config so later deploys replace it.${warn}` }, 'Code page created');
      }

      const live = await rt.xml.getPage(appId, page.ref);
      const liveBare = normalise(stripStamp(live));
      if (liveBare === built.bare) return text(`Page ${page.ref} is already up to date; nothing deployed.`);
      const stats = lineStats(liveBare, built.bare);
      const prev = state[key];
      const drifted = Boolean(prev && prev.hash !== contentHash(liveBare));
      if (drifted && !args.force) {
        const who = readStamp(live);
        return text(
          `Not deployed: page ${page.ref} changed since the last deploy from this workspace (live stamp: ${who ? `${who.sha} at ${who.when}` : 'none'}; last deploy ${prev?.at}). ` +
            'Someone may have edited it in the browser, and code pages have no version history. Pull it with get_code_page and merge, or call again with force: true.',
        );
      }
      if (args.dryRun) {
        return text(`Dry run: page ${page.ref} would change by +${stats.added} / -${stats.removed} lines.\n\`\`\`diff\n${unifiedDiff(liveBare, built.bare, { before: `live:${page.ref}`, after: localPath ?? 'content' })}\n\`\`\``);
      }
      ctx.assertWritable(rt, { action: `replace code page ${page.ref}`, confirm: args.confirm });
      await rt.xml.putPage(appId, { pageId: page.ref, body: built.body });
      state[key] = { hash: contentHash(built.bare), pageId: String(page.ref), at: new Date().toISOString(), sha, by: 'quickbase-mcp-server' };
      saveState(ctx.workspace.root, state);
      return json(ctx, { deployed: true, pageId: page.ref, url: pageUrl(rt, appId, page.ref), lines: `+${stats.added} / -${stats.removed}`, stamp: built.stamp, forcedOverDrift: drifted || undefined }, 'Code page deployed');
    }),
  );
}

function rank(s: 'error' | 'warning' | 'info'): number {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}
