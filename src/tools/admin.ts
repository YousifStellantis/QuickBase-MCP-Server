/** Realm/account administration reads (opt-in toolset "admin"). Requires the matching Quickbase admin rights. */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { dbid, envParam, getEnvArg, json, LOCAL_WRITE, READ_ONLY, safe } from './util.js';

export function registerAdminTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'get_users',
    {
      title: 'Get account users',
      description: 'Users in the account (account admin), optionally filtered by email or app. Paginated: pass nextPageToken from the previous result.',
      inputSchema: z.object({
        accountId: z.string().optional(),
        emails: z.array(z.string()).optional(),
        appIds: z.array(dbid('App ID')).optional(),
        nextPageToken: z.string().optional(),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const res = await rt.json.post('/users', {
        query: { accountId: args.accountId },
        body: { emails: args.emails, appIds: args.appIds, nextPageToken: args.nextPageToken },
        idempotent: true,
      });
      return json(ctx, res.data);
    }),
  );

  server.registerTool(
    'get_trustees',
    {
      title: 'Get app trustees',
      description: 'Users, groups and email-domain groups with access to an app, and their role IDs.',
      inputSchema: z.object({ appId: dbid('App ID').optional(), ...envParam(ctx) }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const appId = ctx.appId(rt, args.appId);
      return json(ctx, (await rt.json.get(`/app/${appId}/trustees`)).data);
    }),
  );

  server.registerTool(
    'get_audit_log',
    {
      title: 'Get audit logs (one day)',
      description: 'Realm audit log entries for one day (realm admin, Enterprise). Large: pass saveTo. Continue with nextToken / queryId from the previous result.',
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
        topics: z.array(z.string()).optional(),
        numRows: z.number().int().min(1).max(10000).optional(),
        nextToken: z.string().optional(),
        queryId: z.string().optional(),
        saveTo: z.string().optional(),
        ...envParam(ctx),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      const res = await rt.json.post<Record<string, unknown>>('/audit', {
        body: { date: args.date, topics: args.topics, numRows: args.numRows, nextToken: args.nextToken, queryId: args.queryId },
        idempotent: true,
      });
      if (args.saveTo) {
        const abs = await ctx.workspace.writeText(args.saveTo, JSON.stringify(res.data, null, 2) + '\n');
        const events = Array.isArray(res.data?.events) ? res.data.events.length : undefined;
        return json(ctx, { saved: ctx.workspace.display(abs), events, nextToken: res.data?.nextToken, queryId: res.data?.queryId });
      }
      return json(ctx, res.data);
    }),
  );

  server.registerTool(
    'get_platform_analytics',
    {
      title: 'Get platform analytics',
      description: 'Realm usage analytics (realm admin): daily read summaries, or event summaries over a date range grouped by app or user.',
      inputSchema: z.object({
        kind: z.enum(['reads', 'event-summaries']),
        day: z.string().optional().describe('reads: YYYY-MM-DD'),
        start: z.string().optional().describe('event-summaries: ISO start'),
        end: z.string().optional().describe('event-summaries: ISO end'),
        groupBy: z.enum(['app', 'user']).optional(),
        accountId: z.string().optional(),
        nextToken: z.string().optional(),
        ...envParam(ctx),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const rt = ctx.env(getEnvArg(args));
      if (args.kind === 'reads') {
        return json(ctx, (await rt.json.get('/analytics/reads', { query: { day: args.day, accountId: args.accountId } })).data);
      }
      const res = await rt.json.post('/analytics/events/summaries', {
        query: { accountId: args.accountId },
        body: { start: args.start, end: args.end, groupBy: args.groupBy ?? 'app', nextToken: args.nextToken },
        idempotent: true,
      });
      return json(ctx, res.data);
    }),
  );
}
