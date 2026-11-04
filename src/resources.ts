import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { redactedConfig } from './config.js';
import type { AppContext } from './context.js';
import { compactField, formatSchemaMarkdown } from './quickbase/schema.js';

const CAPABILITIES_DOC = fileURLToPath(new URL('../docs/CAPABILITIES.md', import.meta.url));

export function capabilitiesMarkdown(): string {
  return existsSync(CAPABILITIES_DOC)
    ? readFileSync(CAPABILITIES_DOC, 'utf8')
    : '# Quickbase API capabilities\n\nSee docs/CAPABILITIES.md in the quickbase-mcp-server package.';
}

export function registerResources(server: McpServer, ctx: AppContext): void {
  server.registerResource(
    'capabilities',
    'quickbase://capabilities',
    {
      title: 'What the Quickbase APIs can and cannot do',
      description: 'Capability matrix: JSON API, XML API, Solutions/QBL, pipelines, forms, code pages, limits and plan requirements.',
      mimeType: 'text/markdown',
      cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: capabilitiesMarkdown() }] }),
  );

  server.registerResource(
    'config',
    'quickbase://config',
    { title: 'Server configuration (redacted)', description: 'Environments, modes, toolsets and workspace, with tokens removed.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(redactedConfig(ctx.config), null, 2) }] }),
  );

  server.registerResource(
    'app-schema',
    new ResourceTemplate('quickbase://apps/{appId}/schema', {
      list: async () => ({
        resources: Object.values(ctx.config.environments)
          .filter((e) => e.appId)
          .map((e) => ({
            uri: `quickbase://apps/${e.appId}/schema`,
            name: `schema-${e.name}`,
            title: `Schema map (${e.name})`,
            description: `Every table and field ID in app ${e.appId} (${e.realm})`,
            mimeType: 'text/markdown',
          })),
      }),
    }),
    { title: 'App schema map', description: 'Markdown map of every table ID and field ID in an app.', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const appId = String(vars.appId);
      const envName = Object.values(ctx.config.environments).find((e) => e.appId === appId)?.name;
      const rt = ctx.env(envName);
      ctx.assertAppAllowed(appId);
      const schema = await rt.schema.appSchema(appId);
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: formatSchemaMarkdown(schema) }] };
    },
  );

  server.registerResource(
    'table-fields',
    new ResourceTemplate('quickbase://tables/{tableId}/fields', { list: undefined }),
    { title: 'Table fields', description: 'Compact field list (IDs, labels, types) for one table.', mimeType: 'application/json' },
    async (uri, vars) => {
      const rt = ctx.env();
      const tableId = String(vars.tableId);
      await ctx.assertTableAllowed(rt, tableId);
      const fields = (await rt.schema.fields(tableId)).map((f) => compactField(f));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(fields, null, 2) }] };
    },
  );
}
