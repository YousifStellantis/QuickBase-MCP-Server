import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { VERSION } from '../version.js';
import { envParam, getEnvArg, json, READ_ONLY, safe } from './util.js';

export function registerConnectionTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'test_connection',
    {
      title: 'Check Quickbase connection',
      description:
        'Verify the user token and realm, and report what this server is allowed to do (read-only or writes, protected environments, toolsets, workspace folder, skills). Call this first in a new session.',
      inputSchema: z.object({ ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const user = await rt.xml.getUserInfo();
      let defaultApp: { id: string; name: string } | null = null;
      let appError: string | undefined;
      if (rt.config.appId) {
        try {
          const app = await rt.schema.app(rt.config.appId);
          defaultApp = { id: rt.config.appId, name: app.name };
        } catch (err) {
          appError = (err as Error).message;
        }
      }
      const writes = ctx.config.allowWrites && rt.config.allowWrites;
      return json(ctx, {
        server: `quickbase-mcp-server ${VERSION}`,
        environment: rt.name,
        environments: ctx.envNames,
        realm: rt.config.realm,
        user: { name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.screenName, email: user.email, id: user.id },
        defaultApp,
        defaultAppError: appError,
        mode: writes ? (ctx.config.allowDestructive ? 'read-write (destructive operations enabled)' : 'read-write (no deletes)') : 'read-only',
        protectedEnvironment: rt.config.protected,
        allowedApps: ctx.config.allowedApps ?? 'any app the token can reach',
        toolsets: [...ctx.config.toolsets],
        workspace: ctx.workspace.root,
        codePageTargets: Object.keys(ctx.config.targets),
        skills: ctx.skills?.list().map((s) => s.name) ?? [],
        howToEnableWrites: writes ? undefined : 'Set QB_ALLOW_WRITES=true (and QB_ALLOW_DESTRUCTIVE=true for deletes) in the MCP server env, then restart the client.',
        configWarnings: ctx.config.warnings.length ? ctx.config.warnings : undefined,
      }, 'Connection OK');
    }),
  );

  server.registerTool(
    'list_apps',
    {
      title: 'List Quickbase apps',
      description:
        'List the apps the token user can access in this realm (XML API_GrantedDBs; the JSON API has no app listing). Note: a user token can only call apps it has been assigned to, so an app listed here may still return 403.',
      inputSchema: z.object({
        nameContains: z.string().optional().describe('Case-insensitive filter on the app name'),
        includeTables: z.boolean().optional().describe('Also list each app\'s tables (default false)'),
        adminOnly: z.boolean().optional().describe('Only apps where the user is an admin'),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const dbs = await rt.xml.grantedDbs({ includeTables: args.includeTables, adminOnly: args.adminOnly });
      const filter = args.nameContains?.toLowerCase();
      // ancestorAppId is the app this one was copied from (useful for spotting DEV/PROD copies).
      const rows = dbs
        .filter((d) => !filter || d.name.toLowerCase().includes(filter))
        .map((d) => ({
          id: d.dbid,
          name: d.name,
          copiedFrom: d.ancestorAppId && d.ancestorAppId !== d.dbid ? d.ancestorAppId : undefined,
          allowed: ctx.config.allowedApps ? ctx.config.allowedApps.includes(d.dbid) : true,
        }));
      return json(ctx, { realm: rt.config.realm, count: rows.length, apps: rows }, `${rows.length} item(s)`);
    }),
  );
}
