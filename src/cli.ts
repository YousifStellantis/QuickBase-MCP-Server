/**
 * Command-line entry points that are not the MCP server itself. These run in a
 * terminal, so they may print to stdout.
 *
 *   quickbase-mcp                 start the stdio MCP server (default)
 *   quickbase-mcp doctor          check config, network/proxy, tokens and apps
 *   quickbase-mcp print-config    show the resolved config (tokens redacted)
 *   quickbase-mcp skills          list bundled skills
 *   quickbase-mcp install-skills [--dir .claude/skills] [--force]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, redactedConfig } from './config.js';
import { AppContext } from './context.js';
import { createLogger, silentLogger } from './logger.js';
import { hasProxyEnv } from './quickbase/http.js';
import { SkillLibrary } from './skills.js';
import { VERSION } from './version.js';

const HELP = `QuickBase MCP Server ${VERSION}

Usage:
  quickbase-mcp                      Start the MCP server on stdio (what MCP clients run)
  quickbase-mcp doctor               Check configuration, network, tokens and apps
  quickbase-mcp print-config         Print the resolved configuration (tokens redacted)
  quickbase-mcp skills               List the bundled skills
  quickbase-mcp install-skills [--dir <path>] [--force]
                                     Copy the skills into a client's skills folder
                                     (default ./.claude/skills for Claude Code)

Environment (most common):
  QB_REALM            yourcompany.quickbase.com
  QB_USER_TOKEN       user token (use a service account)
  QB_APP_ID           default app ID
  QB_ALLOW_WRITES     true to enable write tools (default: read-only)
  QB_CONFIG           path to a multi-environment config file
  QB_WORKSPACE        folder for code pages, pipelines, QBL and snapshots
See README.md for the full list.`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runCli(argv: string[]): Promise<number | null> {
  const [cmd, ...rest] = argv;
  if (!cmd) return null;
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (cmd === 'print-config') {
    process.stdout.write(JSON.stringify(redactedConfig(loadConfig()), null, 2) + '\n');
    return 0;
  }
  if (cmd === 'skills') {
    const lib = await SkillLibrary.load({ extraDir: loadConfig().extraSkillsDir });
    for (const s of lib.list()) process.stdout.write(`${s.name}${s.source === 'custom' ? ' (custom)' : ''}\n  ${s.description}\n`);
    return 0;
  }
  if (cmd === 'install-skills') return installSkills(rest);
  if (cmd === 'doctor') return doctor();
  if (cmd === 'serve' || cmd === 'stdio') return null;
  process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}\n`);
  return 2;
}

async function installSkills(args: string[]): Promise<number> {
  const dir = resolve(flag(args, '--dir') ?? join(process.cwd(), '.claude', 'skills'));
  const force = args.includes('--force');
  const lib = await SkillLibrary.load({ extraDir: loadConfig().extraSkillsDir });
  let written = 0;
  let skipped = 0;
  for (const [name, files] of lib.allFiles()) {
    const target = join(dir, name);
    if (existsSync(target) && !force) {
      process.stdout.write(`skip  ${name} (exists; --force to overwrite)\n`);
      skipped++;
      continue;
    }
    for (const [path, bytes] of files) {
      const out = join(target, ...path.split('/'));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, bytes);
    }
    process.stdout.write(`wrote ${name}\n`);
    written++;
  }
  process.stdout.write(`\n${written} skill(s) installed into ${dir}${skipped ? `, ${skipped} skipped` : ''}.\n`);
  return 0;
}

async function doctor(): Promise<number> {
  const out = (s: string) => process.stdout.write(s + '\n');
  let failures = 0;
  const ok = (m: string) => out(`  OK    ${m}`);
  const warn = (m: string) => out(`  WARN  ${m}`);
  const fail = (m: string) => {
    failures++;
    out(`  FAIL  ${m}`);
  };

  out(`QuickBase MCP Server ${VERSION} doctor\n`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 20 || (major === 20 && minor >= 18)) ok(`Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node}; 20.18 or newer is required`);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
  ok(config.configPath ? `config file ${config.configPath}` : 'configuration from environment variables');
  for (const w of config.warnings) warn(w);
  if (hasProxyEnv()) {
    const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? '(unset)';
    ok(`proxy variables set (HTTPS_PROXY/HTTP_PROXY); NO_PROXY=${noProxy.length > 80 ? `${noProxy.slice(0, 80)}…` : noProxy}`);
  }
  if (process.env.NODE_EXTRA_CA_CERTS) ok(`NODE_EXTRA_CA_CERTS=${process.env.NODE_EXTRA_CA_CERTS}`);
  out(`  mode: ${config.allowWrites ? (config.allowDestructive ? 'read-write + destructive' : 'read-write') : 'read-only'}; toolsets: ${[...config.toolsets].join(', ')}`);

  try {
    mkdirSync(config.workspaceRoot, { recursive: true });
    const probe = join(config.workspaceRoot, '.quickbase', '.doctor');
    mkdirSync(dirname(probe), { recursive: true });
    writeFileSync(probe, new Date().toISOString());
    ok(`workspace ${config.workspaceRoot} is writable`);
  } catch (err) {
    fail(`workspace ${config.workspaceRoot} is not writable: ${(err as Error).message}`);
  }

  const lib = await SkillLibrary.load({ extraDir: config.extraSkillsDir, logger: createLogger('warn') });
  ok(`${lib.list().length} skill(s) loaded`);

  const ctx = new AppContext(config, silentLogger, lib);
  for (const name of ctx.envNames) {
    out(`\nEnvironment "${name}" (${config.environments[name].realm})`);
    try {
      const rt = ctx.env(name);
      const user = await rt.xml.getUserInfo();
      ok(`token accepted: ${[user.firstName, user.lastName].filter(Boolean).join(' ') || user.screenName} <${user.email ?? '?'}>`);
      if (rt.config.appId) {
        const [app, tables] = await Promise.all([rt.schema.app(rt.config.appId), rt.schema.tables(rt.config.appId)]);
        ok(`app ${rt.config.appId} "${app.name}": ${tables.length} table(s)`);
      } else {
        warn('no default appId; tools will need appId arguments');
      }
      if (rt.config.protected) out('  note  protected: writes need confirm with the environment name');
    } catch (err) {
      fail((err as Error).message);
    }
  }
  if (ctx.envNames.length === 0) fail('no environments configured (set QB_REALM and QB_USER_TOKEN)');
  out(failures ? `\n${failures} problem(s) found.` : '\nAll checks passed.');
  return failures ? 1 : 0;
}
