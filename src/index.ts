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
 *
 * `quickbase-mcp http` serves the same server over Streamable HTTP at
 * http://localhost:8080/mcp instead, for clients that connect to a local URL
 * (see http-server.ts).
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { flag, runCli } from './cli.js';
import { emptyConfig, loadConfig, type ServerConfig } from './config.js';
import { AppContext } from './context.js';
import { HttpStartError, parsePort, serveHttp } from './http-server.js';
import { createLogger } from './logger.js';
import { ConfigError } from './quickbase/errors.js';
import { createServer } from './server.js';
import { SkillLibrary } from './skills.js';
import { VERSION } from './version.js';

const args = process.argv.slice(2);
const exitCode = await runCli(args);
if (exitCode !== null) process.exit(exitCode);
const httpMode = args[0] === 'http';

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
const mode = config.allowWrites ? (config.allowDestructive ? 'read-write+destructive' : 'read-write') : 'read-only';
const summary = `envs: ${ctx.envNames.join(', ') || 'none'} | mode: ${mode} | workspace: ${config.workspaceRoot} | skills: ${skills?.list().length ?? 0}`;

if (httpMode) {
  let running: Awaited<ReturnType<typeof serveHttp>>;
  try {
    running = await serveHttp(() => createServer(ctx), { port: parsePort(flag(args, '--port') ?? process.env.QB_HTTP_PORT), logger });
  } catch (err) {
    if (!(err instanceof HttpStartError)) throw err;
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  logger.info(`QuickBase MCP Server ${VERSION} on ${running.url} | ${summary}`);
  process.stdout.write(
    `QuickBase MCP Server is running at ${running.url}\nOnly this computer can connect. Keep this window open while you use it; press Ctrl+C to stop.\n`,
  );
  const stop = () => void running.close().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} else {
  serveStdio(() => createServer(ctx), {
    onerror: (error) => logger.error('MCP transport error', error),
  });
  logger.info(`QuickBase MCP Server ${VERSION} on stdio | ${summary}`);
}
