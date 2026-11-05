import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, normalizeRealm, redactedConfig } from '../src/config.js';
import { AppContext } from '../src/context.js';
import { silentLogger } from '../src/logger.js';
import { GuardError } from '../src/quickbase/errors.js';
import { Workspace } from '../src/workspace.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'qbmcp-'));

describe('loadConfig', () => {
  it('builds a single default environment from env vars (read-only by default)', () => {
    const c = loadConfig({ QB_REALM: 'acme', QB_USER_TOKEN: 'tok_123456789', QB_APP_ID: 'bqh6r2kxa' }, tmp());
    expect(c.environments.default).toMatchObject({ realm: 'acme.quickbase.com', appId: 'bqh6r2kxa', userToken: 'tok_123456789', protected: false });
    expect(c.allowWrites).toBe(false);
    expect(c.allowDestructive).toBe(false);
    expect([...c.toolsets]).not.toContain('admin');
  });

  it('accepts the community server variable names', () => {
    const c = loadConfig({ QUICKBASE_REALM_HOST: 'https://demo.quickbase.com/', QUICKBASE_USER_TOKEN: 'tok_abcdefgh' }, tmp());
    expect(c.environments.default.realm).toBe('demo.quickbase.com');
  });

  it('reads a qb-deploy style config file with per-environment tokens and a .env', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'qb.config.json'),
      JSON.stringify({
        defaultEnv: 'dev',
        environments: {
          dev: { realm: 'acme.quickbase.com', appId: 'bdevapp01', tokenEnvVar: 'QB_USER_TOKEN_DEV' },
          prod: { realm: 'acme.quickbase.com', appId: 'bprdapp01', tokenEnvVar: 'QB_USER_TOKEN_PROD', protected: true },
        },
        targets: { kpi: { src: 'KPI.html', pageName: 'KPI.html', pageIds: { dev: '12', prod: '' } } },
      }),
    );
    writeFileSync(join(dir, '.env'), 'QB_USER_TOKEN_DEV="dev_token_1234567"\n# comment\n');
    const c = loadConfig({ QB_USER_TOKEN: 'generic_token_xyz' }, dir);
    expect(c.defaultEnv).toBe('dev');
    expect(c.environments.dev.userToken).toBe('dev_token_1234567');
    // Explicit tokenEnvVar never falls back to the generic token.
    expect(c.environments.prod.userToken).toBeUndefined();
    expect(c.environments.prod.protected).toBe(true);
    expect(c.targets.kpi.pageIds).toEqual({ dev: '12' });
    expect(c.warnings.some((w) => w.includes('QB_USER_TOKEN_PROD'))).toBe(true);
    expect(c.workspaceRoot).toBe(dir);
    const red = JSON.stringify(redactedConfig(c));
    expect(red).not.toContain('dev_token_1234567');
  });

  it('parses toolsets, allowlist and table aliases', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'tables.json'), JSON.stringify({ compDetails: 'bqh6r4tz7' }));
    const c = loadConfig({ QB_REALM: 'acme', QB_USER_TOKEN: 't_12345678', QB_APP_ID: 'bqh6r2kxa', QB_TOOLSETS: 'apps,admin,bogus', QB_ALLOWED_APPS: 'bother0001', QB_WORKSPACE: dir }, tmp());
    expect([...c.toolsets].sort()).toEqual(['admin', 'apps']);
    expect(c.warnings.some((w) => w.includes('bogus'))).toBe(true);
    expect(c.allowedApps?.sort()).toEqual(['bother0001', 'bqh6r2kxa']);
    expect(c.tableAliases['*']).toEqual({ compDetails: 'bqh6r4tz7' });
  });

  it('normalizes realms', () => {
    expect(normalizeRealm('ACME')).toBe('acme.quickbase.com');
    expect(normalizeRealm('https://acme.quickbase.com/db/main')).toBe('acme.quickbase.com');
  });
});

describe('guardrails', () => {
  const ctxWith = (env: Record<string, string>) => new AppContext(loadConfig({ QB_REALM: 'acme', QB_USER_TOKEN: 'tok_12345678', QB_APP_ID: 'bqh6r2kxa', ...env }, tmp()), silentLogger, null);

  it('refuses writes when read-only', () => {
    const ctx = ctxWith({});
    expect(() => ctx.assertWritable(ctx.env(), { action: 'x' })).toThrow(GuardError);
  });

  it('refuses destructive actions without QB_ALLOW_DESTRUCTIVE', () => {
    const ctx = ctxWith({ QB_ALLOW_WRITES: 'true' });
    expect(() => ctx.assertWritable(ctx.env(), { action: 'x' })).not.toThrow();
    expect(() => ctx.assertWritable(ctx.env(), { action: 'x', destructive: true })).toThrow(/QB_ALLOW_DESTRUCTIVE/);
  });

  it('requires the exact confirm phrase, prefixed in protected environments', () => {
    const ctx = ctxWith({ QB_ALLOW_WRITES: 'true', QB_ALLOW_DESTRUCTIVE: 'true', QB_PROTECTED: 'true' });
    const rt = ctx.env();
    expect(ctx.expectedConfirm(rt)).toBe('default');
    expect(ctx.expectedConfirm(rt, 'delete:bq1:3')).toBe('default:delete:bq1:3');
    expect(() => ctx.assertWritable(rt, { action: 'x' })).toThrow(/confirm: "default"/);
    expect(() => ctx.assertWritable(rt, { action: 'x', confirm: 'default' })).not.toThrow();
    expect(() => ctx.assertWritable(rt, { action: 'x', destructive: true, expected: 'delete:bq1:3', confirm: 'delete:bq1:3' })).toThrow(GuardError);
    expect(() => ctx.assertWritable(rt, { action: 'x', destructive: true, expected: 'delete:bq1:3', confirm: 'default:delete:bq1:3' })).not.toThrow();
  });

  it('enforces the app allowlist', () => {
    const ctx = ctxWith({ QB_ALLOWED_APPS: 'bqh6r2kxa' });
    expect(() => ctx.appId(ctx.env(), 'bnotallow1')).toThrow(/QB_ALLOWED_APPS/);
    expect(ctx.appId(ctx.env())).toBe('bqh6r2kxa');
  });

  it('explains a missing token', () => {
    const ctx = new AppContext(loadConfig({ QB_REALM: 'acme' }, tmp()), silentLogger, null);
    expect(() => ctx.env()).toThrow(/no user token/);
  });
});

describe('Workspace', () => {
  it('rejects paths that escape the root', () => {
    const ws = new Workspace(tmp());
    expect(() => ws.resolve('../outside.txt')).toThrow(/outside the workspace/);
    expect(() => ws.resolve('/etc/passwd')).toThrow(/outside the workspace/);
    expect(ws.resolve('pipelines/a.yaml')).toBe(join(ws.root, 'pipelines', 'a.yaml'));
  });
});
