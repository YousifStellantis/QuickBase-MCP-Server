/**
 * End-to-end: spawn the built server (build/index.js) over stdio against a fake
 * Quickbase, and drive it with the official MCP client in both protocol eras.
 * Run `npm run build` first (npm test does).
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ID, DEFECTS, REALM, startFakeQuickbase, TOKEN } from './helpers/fake-quickbase.js';

const SERVER = fileURLToPath(new URL('../build/index.js', import.meta.url));

let fake: Awaited<ReturnType<typeof startFakeQuickbase>>;
let workspace: string;

function serverEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: workspace,
    QB_REALM: REALM,
    QB_USER_TOKEN: TOKEN,
    QB_APP_ID: APP_ID,
    QB_API_BASE_URL: `${fake.url}/v1`,
    QB_XML_BASE_URL: fake.url,
    QB_WORKSPACE: workspace,
    QB_LOG_LEVEL: 'warn',
    ...extra,
  };
}

async function connect(era: 'legacy' | 'modern', extra: Record<string, string> = {}) {
  const client = new Client(
    { name: 'e2e-test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env: serverEnv(extra), stderr: 'pipe' }));
  return client;
}

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text?: string }> };
  return r.content.map((c) => c.text ?? '').join('\n');
}

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error('build/index.js missing: run npm run build');
  fake = await startFakeQuickbase();
  workspace = mkdtempSync(join(tmpdir(), 'qbmcp-e2e-'));
  mkdirSync(join(workspace, 'pipelines'), { recursive: true });
  copyFileSync(fileURLToPath(new URL('./fixtures/pipeline-escalation.yaml', import.meta.url)), join(workspace, 'pipelines', 'escalation.yaml'));
});

afterAll(async () => {
  await fake?.close();
});

describe.each(['legacy', 'modern'] as const)('stdio server (%s era)', (era) => {
  let client: Client;
  beforeAll(async () => {
    client = await connect(era);
  });
  afterAll(async () => {
    await client?.close();
  });

  it('lists read-only tools and no write tools by default', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['test_connection', 'get_schema_map', 'generate_field_constants', 'query_records', 'get_code_page', 'analyze_code_page', 'inspect_pipeline', 'export_solution', 'list_skills', 'load_skill']) {
      expect(names).toContain(n);
    }
    for (const n of ['upsert_records', 'deploy_code_page', 'delete_records', 'create_field']) expect(names).not.toContain(n);
    expect(tools.find((t) => t.name === 'get_fields')?.annotations?.readOnlyHint).toBe(true);
  });

  it('checks the connection through the XML and JSON APIs', async () => {
    const out = textOf(await client.callTool({ name: 'test_connection', arguments: {} }));
    expect(out).toContain('Connection OK');
    expect(out).toContain('test.engineer@example.com');
    expect(out).toContain('"mode": "read-only"');
    expect(out).toContain('Plant Quality');
  });

  it('returns the schema map with every table and field ID', async () => {
    const out = textOf(await client.callTool({ name: 'get_schema_map', arguments: {} }));
    expect(out).toContain(`## Defects — \`${DEFECTS}\``);
    expect(out).toContain('| 7 | Status | text-multiple-choice |');
    expect(out).toContain('| 9 | Days Open | numeric | formula |');
    expect(existsSync(join(workspace, '.quickbase', 'schema', `default-${APP_ID}.json`))).toBe(true);
  });

  it('queries records by field label', async () => {
    const out = textOf(await client.callTool({ name: 'query_records', arguments: { tableId: DEFECTS, select: ['Record ID#', 'Line', 'status'], maxRecords: 3 } }));
    expect(out).toContain('3 of 7 row(s)');
    expect(out).toContain('"Line": "Line 1"');
    const bad = await client.callTool({ name: 'query_records', arguments: { tableId: DEFECTS, select: ['Stauts'] } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Did you mean: "Status" (7)');
  });

  it('reads and reviews a code page', async () => {
    const page = textOf(await client.callTool({ name: 'get_code_page', arguments: { pageId: 12 } }));
    expect(page).toContain('<title>Line board</title>');
    const review = textOf(await client.callTool({ name: 'analyze_code_page', arguments: { content: `<script>const DBID_DEFECTS = "${DEFECTS}"; const FID_STATUS = 7; const FID_LINE = 8;</script>` } }));
    expect(review).toContain('"status": "ok"');
    expect(review).toContain('fid-label-mismatch');
  });

  it('lints a pipeline export against the live schema', async () => {
    const out = textOf(await client.callTool({ name: 'inspect_pipeline', arguments: { path: 'pipelines/escalation.yaml' } }));
    expect(out).toContain('Escalate overdue containment');
    expect(out).toContain('table-not-found');
  });

  it('serves skills through tools, prompts and resources', async () => {
    const list = textOf(await client.callTool({ name: 'list_skills', arguments: {} }));
    expect(list).toContain('automotive-ui-design-system');
    const skill = textOf(await client.callTool({ name: 'load_skill', arguments: { name: 'automotive-ui-design-system', file: 'references/anti-patterns.md' } }));
    expect(skill).toContain('look AI-generated');
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['build-code-page', 'promote-pipeline', 'quickbase-code-pages']));
    const prompt = await client.getPrompt({ name: 'build-code-page', arguments: { goal: 'Andon board for Line 2' } });
    expect(JSON.stringify(prompt.messages)).toContain('Andon board for Line 2');
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(expect.arrayContaining(['quickbase://capabilities', 'skill://quickbase/quickbase-code-pages/SKILL.md']));
    const cap = await client.readResource({ uri: 'quickbase://capabilities' });
    expect(JSON.stringify(cap.contents)).toContain('Pipelines');
  });
});

describe('Skills extension (2026-07-28)', () => {
  it('lists and reads verified skills with the SDK SkillsClient', async () => {
    const client = await connect('modern');
    try {
      const skills = new SkillsClient(client);
      expect(skills.supported).toBe(true);
      const listing = await skills.list();
      expect(listing.skills.length).toBeGreaterThanOrEqual(10);
      const design = listing.skills.find((s) => s.frontmatter.name === 'automotive-ui-design-system')!;
      const file = await skills.read(design);
      expect(file.verified).toBe(true);
      expect(file.body).toContain('# Automotive UI design system');
      const tokens = await skills.read(design, 'references/tokens.css');
      expect(tokens.verified).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe('writes (QB_ALLOW_WRITES=true)', () => {
  it('deploys a code page with field injection, a stamp and drift protection', async () => {
    mkdirSync(join(workspace, 'config'), { recursive: true });
    writeFileSync(join(workspace, 'config', 'fields.default.json'), JSON.stringify({ defects: { status: 7 } }));
    writeFileSync(join(workspace, 'board.html'), '<!DOCTYPE html>\n<html><head><title>Line board</title></head><body>v2 status=__QB_FIELD:defects.status__</body></html>\n');

    const client = await connect('legacy', { QB_ALLOW_WRITES: 'true' });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('deploy_code_page');
      expect(names).not.toContain('delete_records');

      const dry = textOf(await client.callTool({ name: 'deploy_code_page', arguments: { localPath: 'board.html', pageId: 12, dryRun: true } }));
      expect(dry).toContain('Dry run');
      expect(dry).toContain('+<html><head><title>Line board</title></head><body>v2 status=7</body></html>');
      expect(fake.state.pages.get(12)).toContain('v1');

      const done = textOf(await client.callTool({ name: 'deploy_code_page', arguments: { localPath: 'board.html', pageId: 12 } }));
      expect(done).toContain('Code page deployed');
      const live = fake.state.pages.get(12)!;
      expect(live).toMatch(/^<!-- qb-deploy \| page-12 \| default \| /);
      expect(live).toContain('v2 status=7');
      const state = JSON.parse(readFileSync(join(workspace, '.qb-deploy-state.json'), 'utf8'));
      expect(state['default:page-12'].pageId).toBe('12');

      // Someone edits the page in the browser: the next deploy must refuse.
      fake.state.pages.set(12, live.replace('v2', 'v2-edited-in-browser'));
      writeFileSync(join(workspace, 'board.html'), '<!DOCTYPE html>\n<html><head><title>Line board</title></head><body>v3</body></html>\n');
      const blocked = textOf(await client.callTool({ name: 'deploy_code_page', arguments: { localPath: 'board.html', pageId: 12 } }));
      expect(blocked).toContain('Not deployed');
      expect(fake.state.pages.get(12)).toContain('v2-edited-in-browser');

      const forced = textOf(await client.callTool({ name: 'deploy_code_page', arguments: { localPath: 'board.html', pageId: 12, force: true } }));
      expect(forced).toContain('"forcedOverDrift": true');
      expect(fake.state.pages.get(12)).toContain('v3');

      // A page with an embedded user token is never deployed.
      const leaky = await client.callTool({ name: 'deploy_code_page', arguments: { content: `<script>const t = "${TOKEN}";</script>`, pageName: 'leak.html' } });
      expect(leaky.isError).toBe(true);
      expect(textOf(leaky)).toContain('Deploy blocked');
    } finally {
      await client.close();
    }
  });
});
