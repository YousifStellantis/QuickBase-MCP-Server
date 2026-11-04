/**
 * Runtime context shared by every tool: per-environment API clients (created
 * lazily, so a missing prod token only matters when prod is used), the
 * workspace, and the guardrails.
 */

import type { EnvironmentConfig, ServerConfig } from './config.js';
import type { Logger } from './logger.js';
import { ConfigError, GuardError } from './quickbase/errors.js';
import { createFetch, type FetchLike } from './quickbase/http.js';
import { QuickbaseJsonClient } from './quickbase/json-client.js';
import { SlidingWindowLimiter } from './quickbase/rate-limiter.js';
import { SchemaService } from './quickbase/schema.js';
import { QuickbaseXmlClient } from './quickbase/xml-client.js';
import { USER_AGENT } from './version.js';
import { Workspace } from './workspace.js';
import type { SkillLibrary } from './skills.js';

export interface EnvRuntime {
  name: string;
  config: EnvironmentConfig;
  json: QuickbaseJsonClient;
  xml: QuickbaseXmlClient;
  schema: SchemaService;
}

export interface WriteCheck {
  /** Short description used in error messages, e.g. "deploy code page 12". */
  action: string;
  destructive?: boolean;
  /** What the caller passed as `confirm`. */
  confirm?: string;
  /** Confirmation phrase the operation requires (before the protected-env prefix is added). */
  expected?: string;
}

export class AppContext {
  readonly workspace: Workspace;
  private readonly runtimes = new Map<string, EnvRuntime>();
  private readonly limiters = new Map<string, SlidingWindowLimiter>();
  readonly fetchImpl: FetchLike;

  constructor(
    readonly config: ServerConfig,
    readonly logger: Logger,
    readonly skills: SkillLibrary | null,
    deps: { fetchImpl?: FetchLike } = {},
  ) {
    this.workspace = new Workspace(config.workspaceRoot);
    this.fetchImpl = deps.fetchImpl ?? createFetch();
  }

  get envNames(): string[] {
    return Object.keys(this.config.environments);
  }

  get multiEnv(): boolean {
    return this.envNames.length > 1;
  }

  /** Runtime for an environment (default when omitted). */
  env(name?: string): EnvRuntime {
    const envName = name ?? this.config.defaultEnv;
    const cfg = this.config.environments[envName];
    if (!cfg) {
      const known = this.envNames;
      const startup = this.config.warnings.length ? ` Startup problems: ${this.config.warnings.join(' | ')}` : '';
      throw new ConfigError(
        known.length
          ? `Unknown environment "${envName}". Configured: ${known.join(', ')}.`
          : `No Quickbase environment is configured. Set QB_REALM and QB_USER_TOKEN in the MCP server config (or QB_CONFIG for multiple environments).${startup}`,
      );
    }
    if (!cfg.userToken) {
      throw new ConfigError(
        `Environment "${envName}" has no user token. Set ${cfg.tokenEnvVar} (Quickbase: My preferences > Manage user tokens). Prefer a service-account token.`,
      );
    }
    const existing = this.runtimes.get(envName);
    if (existing) return existing;

    // One limiter per token: JSON and XML calls share Quickbase's per-token budget.
    let limiter = this.limiters.get(cfg.userToken);
    if (!limiter) {
      limiter = new SlidingWindowLimiter(this.config.rateLimitPer10s);
      this.limiters.set(cfg.userToken, limiter);
    }
    const common = { realm: cfg.realm, userToken: cfg.userToken, limiter, timeoutMs: this.config.timeoutMs, userAgent: USER_AGENT, fetchImpl: this.fetchImpl, logger: this.logger };
    const json = new QuickbaseJsonClient({ ...common, baseUrl: this.config.apiBaseUrl });
    const xml = new QuickbaseXmlClient({ ...common, appToken: cfg.appToken, baseUrl: this.config.xmlBaseUrl });
    const rt: EnvRuntime = { name: envName, config: cfg, json, xml, schema: new SchemaService(json) };
    this.runtimes.set(envName, rt);
    return rt;
  }

  /** The app ID to use: explicit argument, else the environment's default app. */
  appId(rt: EnvRuntime, appId?: string): string {
    const id = appId?.trim() || rt.config.appId;
    if (!id) throw new ConfigError(`No appId given and environment "${rt.name}" has no default app. Pass appId, or set QB_APP_ID / "appId" in the config.`);
    this.assertAppAllowed(id);
    return id;
  }

  assertAppAllowed(appId: string): void {
    const allowed = this.config.allowedApps;
    if (allowed && !allowed.includes(appId)) {
      throw new GuardError(`App ${appId} is not in QB_ALLOWED_APPS (${allowed.join(', ')}). Add it there to let this server touch it.`);
    }
  }

  /** With an allowlist in place, a table must belong to one of the allowed apps. */
  async assertTableAllowed(rt: EnvRuntime, tableId: string): Promise<void> {
    const allowed = this.config.allowedApps;
    if (!allowed) return;
    if (allowed.includes(tableId)) return;
    const app = await rt.schema.appOfTable(tableId, allowed);
    if (!app) throw new GuardError(`Table ${tableId} is not in any app listed in QB_ALLOWED_APPS (${allowed.join(', ')}).`);
  }

  /** Exact confirmation phrase for an operation in this environment. Protected environments prefix the env name. */
  expectedConfirm(rt: EnvRuntime, base?: string): string | undefined {
    if (base) return rt.config.protected ? `${rt.name}:${base}` : base;
    return rt.config.protected ? rt.name : undefined;
  }

  assertWritable(rt: EnvRuntime, check: WriteCheck): void {
    if (!this.config.allowWrites) {
      throw new GuardError(`Refused to ${check.action}: this server is read-only. Set QB_ALLOW_WRITES=true in the MCP server environment to enable writes.`);
    }
    if (!rt.config.allowWrites) throw new GuardError(`Refused to ${check.action}: environment "${rt.name}" is configured read-only.`);
    if (check.destructive && !this.config.allowDestructive) {
      throw new GuardError(`Refused to ${check.action}: destructive operations are disabled. Set QB_ALLOW_DESTRUCTIVE=true to enable deletes.`);
    }
    const expected = this.expectedConfirm(rt, check.expected);
    if (expected !== undefined && check.confirm !== expected) {
      const why = rt.config.protected ? `"${rt.name}" is a protected environment` : 'this operation needs an explicit confirmation';
      throw new GuardError(`Not executed: ${why}. Review the details above with the user, then call again with confirm: "${expected}".`);
    }
  }
}
