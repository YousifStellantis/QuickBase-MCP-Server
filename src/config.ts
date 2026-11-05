/**
 * Configuration: environment variables first, an optional JSON config file for
 * multi-environment setups (dev / test / prod), and a `.env` next to that file.
 *
 * The config file is deliberately compatible with qb-deploy's `qb.config.json`
 * (`defaultEnv`, `environments`, `targets`), so a repo that already deploys code
 * pages with qb-deploy can point this server at the same file.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from './quickbase/errors.js';
import type { LogLevel } from './logger.js';

export const TOOLSETS = ['apps', 'records', 'codepages', 'pipelines', 'solutions', 'schema', 'admin', 'skills'] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** Everything except `admin` (realm-level user/audit data) is on by default. Write tools additionally need QB_ALLOW_WRITES. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = ['apps', 'records', 'codepages', 'pipelines', 'solutions', 'schema', 'skills'];

export interface EnvironmentConfig {
  name: string;
  realm: string;
  appId?: string;
  userToken?: string;
  /** Name of the variable the token is expected in, for error messages. */
  tokenEnvVar: string;
  appToken?: string;
  /** Protected environments require `confirm: "<env name>"` on every write. */
  protected: boolean;
  /** Per-environment write switch. The global QB_ALLOW_WRITES switch must also be on. */
  allowWrites: boolean;
}

export interface CodePageTarget {
  name: string;
  src: string;
  pageName?: string;
  pageIds: Record<string, string>;
}

export interface PipelineWebhook {
  url: string;
  description?: string;
}

export interface ServerConfig {
  environments: Record<string, EnvironmentConfig>;
  defaultEnv: string;
  allowWrites: boolean;
  allowDestructive: boolean;
  /** null means no restriction beyond what the token can reach. */
  allowedApps: string[] | null;
  toolsets: Set<Toolset>;
  workspaceRoot: string;
  configPath?: string;
  targets: Record<string, CodePageTarget>;
  /** env name -> alias -> table id. The "*" env applies to every environment. */
  tableAliases: Record<string, Record<string, string>>;
  pipelineWebhooks: Record<string, PipelineWebhook>;
  rateLimitPer10s: number;
  timeoutMs: number;
  maxOutputChars: number;
  apiBaseUrl: string;
  xmlBaseUrl?: string;
  qblVersion?: string;
  extraSkillsDir?: string;
  logLevel: LogLevel;
  warnings: string[];
}

type Env = Record<string, string | undefined>;

interface ConfigFileShape {
  defaultEnv?: string;
  environments?: Record<
    string,
    {
      realm?: string;
      appId?: string;
      tokenEnvVar?: string;
      appTokenEnvVar?: string;
      protected?: boolean;
      allowWrites?: boolean;
      readOnly?: boolean;
    }
  >;
  targets?: Record<string, { src?: string; pageName?: string; pageIds?: Record<string, string | number> }>;
  tables?: Record<string, string | Record<string, string>>;
  pipelineWebhooks?: Record<string, string | { url: string; description?: string }>;
  allowedApps?: string[];
  workspace?: string;
  toolsets?: string[] | string;
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  return fallback;
}

function parseIntSafe(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** "acme" -> "acme.quickbase.com"; strips scheme and trailing slashes. */
export function normalizeRealm(realm: string): string {
  let r = realm.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (r && !r.includes('.')) r = `${r}.quickbase.com`;
  return r.toLowerCase();
}

/** Minimal .env reader: KEY=value, comments, one layer of quotes. Never overrides real environment variables. */
export function readDotEnv(path: string): Env {
  const out: Env = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function findConfigFile(env: Env, cwd: string): string | undefined {
  if (env.QB_CONFIG) {
    const p = isAbsolute(env.QB_CONFIG) ? env.QB_CONFIG : resolve(cwd, env.QB_CONFIG);
    if (!existsSync(p)) throw new ConfigError(`QB_CONFIG points to ${p}, which does not exist.`);
    return p;
  }
  for (const name of ['quickbase-mcp.config.json', 'qb.config.json']) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function parseToolsets(raw: string | string[] | undefined, warnings: string[]): Set<Toolset> {
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return new Set(DEFAULT_TOOLSETS);
  const items = (Array.isArray(raw) ? raw : raw.split(',')).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.includes('all')) return new Set(TOOLSETS);
  const out = new Set<Toolset>();
  for (const item of items) {
    if ((TOOLSETS as readonly string[]).includes(item)) out.add(item as Toolset);
    else warnings.push(`Unknown toolset "${item}" ignored. Valid: ${TOOLSETS.join(', ')}, all.`);
  }
  return out;
}

function chooseWorkspace(env: Env, cwd: string, configPath: string | undefined, fileWorkspace: string | undefined): string {
  if (env.QB_WORKSPACE) return isAbsolute(env.QB_WORKSPACE) ? env.QB_WORKSPACE : resolve(cwd, env.QB_WORKSPACE);
  if (configPath) {
    const dir = dirname(configPath);
    return fileWorkspace ? (isAbsolute(fileWorkspace) ? fileWorkspace : resolve(dir, fileWorkspace)) : dir;
  }
  // Desktop clients often launch servers with cwd "/"; never use the filesystem root as a workspace.
  const isRoot = resolve(cwd) === resolve('/') || /^[A-Za-z]:\\?$/.test(cwd);
  return isRoot ? join(homedir(), 'QuickbaseWorkspace') : cwd;
}

export function loadConfig(processEnv: Env = process.env, cwd: string = process.cwd()): ServerConfig {
  const warnings: string[] = [];
  const configPath = findConfigFile(processEnv, cwd);

  let file: ConfigFileShape = {};
  let env: Env = { ...processEnv };
  if (configPath) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8')) as ConfigFileShape;
    } catch (err) {
      throw new ConfigError(`${configPath} is not valid JSON: ${(err as Error).message}`);
    }
    // .env beside the config file; real environment variables win.
    env = { ...readDotEnv(join(dirname(configPath), '.env')), ...processEnv };
  }

  const environments: Record<string, EnvironmentConfig> = {};
  const fileEnvs = file.environments ?? {};

  if (Object.keys(fileEnvs).length > 0) {
    for (const [name, e] of Object.entries(fileEnvs)) {
      if (!e.realm) {
        warnings.push(`Environment "${name}" has no "realm" and was skipped.`);
        continue;
      }
      // An explicit tokenEnvVar is honored strictly (no fallback), so a prod
      // environment never silently borrows the dev token.
      const tokenEnvVar = e.tokenEnvVar ?? `QB_USER_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const userToken = env[tokenEnvVar] ?? (e.tokenEnvVar ? undefined : env.QB_USER_TOKEN ?? env.QUICKBASE_USER_TOKEN);
      environments[name] = {
        name,
        realm: normalizeRealm(e.realm),
        appId: e.appId || undefined,
        userToken: userToken || undefined,
        tokenEnvVar: e.tokenEnvVar ?? (env[tokenEnvVar] ? tokenEnvVar : 'QB_USER_TOKEN'),
        appToken: e.appTokenEnvVar ? env[e.appTokenEnvVar] : undefined,
        protected: Boolean(e.protected),
        allowWrites: e.readOnly ? false : e.allowWrites !== false,
      };
    }
  } else {
    const realm = env.QB_REALM ?? env.QUICKBASE_REALM_HOST ?? env.QB_REALM_HOSTNAME;
    if (realm) {
      environments.default = {
        name: 'default',
        realm: normalizeRealm(realm),
        appId: env.QB_APP_ID ?? env.QUICKBASE_APP_ID ?? undefined,
        userToken: env.QB_USER_TOKEN ?? env.QUICKBASE_USER_TOKEN ?? undefined,
        tokenEnvVar: env.QB_USER_TOKEN ? 'QB_USER_TOKEN' : env.QUICKBASE_USER_TOKEN ? 'QUICKBASE_USER_TOKEN' : 'QB_USER_TOKEN',
        appToken: env.QB_APP_TOKEN ?? undefined,
        protected: parseBool(env.QB_PROTECTED, false),
        allowWrites: true,
      };
    }
  }

  const envNames = Object.keys(environments);
  if (envNames.length === 0) {
    warnings.push(
      'No Quickbase environment configured. Set QB_REALM and QB_USER_TOKEN (and optionally QB_APP_ID), or point QB_CONFIG at a config file.',
    );
  }

  let defaultEnv = env.QB_ENV ?? file.defaultEnv ?? envNames[0] ?? 'default';
  if (envNames.length > 0 && !environments[defaultEnv]) {
    warnings.push(`Default environment "${defaultEnv}" is not configured; using "${envNames[0]}".`);
    defaultEnv = envNames[0];
  }

  for (const e of Object.values(environments)) {
    if (!e.userToken) warnings.push(`Environment "${e.name}" has no user token (expected in ${e.tokenEnvVar}).`);
  }

  // Allowlist: explicit list plus every configured environment's app.
  const allowedRaw = env.QB_ALLOWED_APPS ?? (file.allowedApps ? file.allowedApps.join(',') : undefined);
  let allowedApps: string[] | null = null;
  if (allowedRaw && allowedRaw.trim()) {
    const set = new Set(allowedRaw.split(',').map((s) => s.trim()).filter(Boolean));
    for (const e of Object.values(environments)) if (e.appId) set.add(e.appId);
    allowedApps = [...set];
  }

  const targets: Record<string, CodePageTarget> = {};
  for (const [name, t] of Object.entries(file.targets ?? {})) {
    if (!t.src) {
      warnings.push(`Code page target "${name}" has no "src" and was skipped.`);
      continue;
    }
    const pageIds: Record<string, string> = {};
    for (const [envName, id] of Object.entries(t.pageIds ?? {})) if (id !== '' && id !== undefined && id !== null) pageIds[envName] = String(id);
    targets[name] = { name, src: t.src, pageName: t.pageName, pageIds };
  }

  const workspaceRoot = chooseWorkspace(env, cwd, configPath, file.workspace);

  const tableAliases: Record<string, Record<string, string>> = {};
  const addAliases = (source: Record<string, string | Record<string, string>> | undefined) => {
    if (!source) return;
    for (const [k, v] of Object.entries(source)) {
      if (typeof v === 'string') (tableAliases['*'] ??= {})[k] = v;
      else if (v && typeof v === 'object') tableAliases[k] = { ...(tableAliases[k] ?? {}), ...v };
    }
  };
  addAliases(file.tables);
  // qb-deploy keeps aliases in config/tables.json.
  const tablesJson = join(workspaceRoot, 'config', 'tables.json');
  if (existsSync(tablesJson)) {
    try {
      addAliases(JSON.parse(readFileSync(tablesJson, 'utf8')));
    } catch {
      warnings.push(`${tablesJson} is not valid JSON and was ignored.`);
    }
  }

  const pipelineWebhooks: Record<string, PipelineWebhook> = {};
  for (const [name, w] of Object.entries(file.pipelineWebhooks ?? {})) {
    const hook = typeof w === 'string' ? { url: w } : w;
    if (!/^https:\/\//i.test(hook.url ?? '')) {
      warnings.push(`Pipeline webhook "${name}" must use an https:// URL; ignored.`);
      continue;
    }
    pipelineWebhooks[name] = { url: hook.url, description: hook.description };
  }

  const extraSkillsDir = env.QB_SKILLS_DIR
    ? isAbsolute(env.QB_SKILLS_DIR)
      ? env.QB_SKILLS_DIR
      : resolve(cwd, env.QB_SKILLS_DIR)
    : undefined;
  if (extraSkillsDir && (!existsSync(extraSkillsDir) || !statSync(extraSkillsDir).isDirectory())) {
    warnings.push(`QB_SKILLS_DIR ${extraSkillsDir} is not a directory; only built-in skills are served.`);
  }

  const logLevel = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === (env.QB_LOG_LEVEL ?? '').toLowerCase()) ?? 'info';

  return {
    environments,
    defaultEnv,
    allowWrites: parseBool(env.QB_ALLOW_WRITES, false),
    allowDestructive: parseBool(env.QB_ALLOW_DESTRUCTIVE, false),
    allowedApps,
    toolsets: parseToolsets(env.QB_TOOLSETS ?? file.toolsets, warnings),
    workspaceRoot,
    configPath,
    targets,
    tableAliases,
    pipelineWebhooks,
    rateLimitPer10s: parseIntSafe(env.QB_RATE_LIMIT, 90, 1, 100),
    timeoutMs: parseIntSafe(env.QB_TIMEOUT_MS, 30_000, 1_000, 300_000),
    maxOutputChars: parseIntSafe(env.QB_MAX_OUTPUT_CHARS, 60_000, 2_000, 2_000_000),
    apiBaseUrl: (env.QB_API_BASE_URL ?? 'https://api.quickbase.com/v1').replace(/\/+$/, ''),
    xmlBaseUrl: env.QB_XML_BASE_URL ? env.QB_XML_BASE_URL.replace(/\/+$/, '') : undefined,
    qblVersion: env.QB_QBL_VERSION || undefined,
    extraSkillsDir: extraSkillsDir && existsSync(extraSkillsDir) ? extraSkillsDir : undefined,
    logLevel,
    warnings,
  };
}

/** A config with no environments, used when the real one cannot be loaded (the error is surfaced as a warning). */
export function emptyConfig(warnings: string[], cwd: string = process.cwd()): ServerConfig {
  return {
    environments: {},
    defaultEnv: 'default',
    allowWrites: false,
    allowDestructive: false,
    allowedApps: null,
    toolsets: new Set(DEFAULT_TOOLSETS),
    workspaceRoot: chooseWorkspace({}, cwd, undefined, undefined),
    targets: {},
    tableAliases: {},
    pipelineWebhooks: {},
    rateLimitPer10s: 90,
    timeoutMs: 30_000,
    maxOutputChars: 60_000,
    apiBaseUrl: 'https://api.quickbase.com/v1',
    logLevel: 'info',
    warnings,
  };
}

/** Config with tokens removed, for diagnostics and the quickbase://config resource. */
export function redactedConfig(config: ServerConfig): Record<string, unknown> {
  return {
    configPath: config.configPath ?? null,
    defaultEnv: config.defaultEnv,
    environments: Object.fromEntries(
      Object.values(config.environments).map((e) => [
        e.name,
        {
          realm: e.realm,
          appId: e.appId ?? null,
          token: e.userToken ? `set (${e.tokenEnvVar})` : `missing (${e.tokenEnvVar})`,
          appToken: e.appToken ? 'set' : 'not set',
          protected: e.protected,
          writable: config.allowWrites && e.allowWrites,
        },
      ]),
    ),
    allowWrites: config.allowWrites,
    allowDestructive: config.allowDestructive,
    allowedApps: config.allowedApps,
    toolsets: [...config.toolsets],
    workspaceRoot: config.workspaceRoot,
    codePageTargets: Object.keys(config.targets),
    pipelineWebhooks: Object.keys(config.pipelineWebhooks),
    rateLimitPer10s: config.rateLimitPer10s,
    qblVersion: config.qblVersion ?? null,
    extraSkillsDir: config.extraSkillsDir ?? null,
    warnings: config.warnings,
  };
}
