#!/usr/bin/env node
/**
 * QuickBase MCP Server entry point.
 *
 * Serves MCP over stdio for any local AI agent (Claude Code, Claude Desktop,
 * VS Code / GitHub Copilot, Cursor, Codex CLI, Gemini CLI, Windsurf, Goose,
 * LM Studio, ...). serveStdio negotiates the protocol revision per client: it
 * answers 2026-07-28 clients (stateless, server/discover) and clients that
 * still open with the 2025-era initialize handshake.
 *
 * stdout carries JSON-RPC only; every log line goes to stderr.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { runCli } from './cli.js';
import { emptyConfig, loadConfig, type ServerConfig } from './config.js';
import { AppContext } from './context.js';
import { createLogger } from './logger.js';
import { ConfigError } from './quickbase/errors.js';
import { createServer } from './server.js';
import { SkillLibrary } from './skills.js';
import { VERSION } from './version.js';

const exitCode = await runCli(process.argv.slice(2));
if (exitCode !== null) process.exit(exitCode);

let config: ServerConfig;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  // Start anyway so the problem is visible in chat (test_connection reports it), not only in a log file.
  config = emptyConfig([err.message]);
}

const secrets = Object.values(config.environments).flatMap((e) => [e.userToken, e.appToken]).filter((s): s is string => Boolean(s));
const logger = createLogger(config.logLevel, () => secrets);
for (const w of config.warnings) logger.warn(w);

let skills: SkillLibrary | null = null;
try {
  skills = await SkillLibrary.load({ extraDir: config.extraSkillsDir, logger });
} catch (err) {
  logger.error('skills failed to load; continuing without them', err);
}

const ctx = new AppContext(config, logger, skills);

serveStdio(() => createServer(ctx), {
  onerror: (error) => logger.error('MCP transport error', error),
});

const mode = config.allowWrites ? (config.allowDestructive ? 'read-write+destructive' : 'read-write') : 'read-only';
logger.info(
  `QuickBase MCP Server ${VERSION} on stdio | envs: ${ctx.envNames.join(', ') || 'none'} | mode: ${mode} | workspace: ${config.workspaceRoot} | skills: ${skills?.list().length ?? 0}`,
);
