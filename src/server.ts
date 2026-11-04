import { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from './context.js';
import { buildInstructions } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools/index.js';
import { SERVER_NAME, SERVER_TITLE, VERSION } from './version.js';

/**
 * Build one MCP server instance. serveStdio() calls this whenever it needs an
 * instance (including a discarded `server/discover` probe when a client falls
 * back to the 2025 `initialize` handshake), so it must return a fresh server
 * each time. All state that should outlive an instance lives in AppContext.
 */
export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: VERSION },
    {
      instructions: buildInstructions(ctx),
      cacheHints: {
        'tools/list': { ttlMs: 300_000, cacheScope: 'private' },
        'prompts/list': { ttlMs: 300_000, cacheScope: 'private' },
      },
    },
  );
  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  // MCP Skills extension (SEP-2640): skills/list, skills/get, skill:// resources.
  ctx.skills?.catalog.attach(server);
  return server;
}
