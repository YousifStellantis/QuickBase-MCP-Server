import { readFileSync } from 'node:fs';

/** Package metadata, read once from package.json so the version has a single source of truth. */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

export const SERVER_NAME = 'quickbase-mcp-server';
export const SERVER_TITLE = 'QuickBase MCP Server';
export const VERSION = pkg.version;
export const USER_AGENT = `${SERVER_NAME}/${VERSION}`;
