import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeCodePage, checkAgainstSchema } from '../src/codepages/analyze.js';
import { buildPage, injectFields, readStamp, stripStamp } from '../src/codepages/build.js';
import { lintPipeline } from '../src/pipelines/lint.js';
import { jinjaRefs, parseFieldList, parsePipelineYaml, parseStepHeader, parseTableRef } from '../src/pipelines/parse.js';
import { remapPipeline } from '../src/pipelines/remap.js';
import {
  formatSchemaMarkdown,
  generateFieldConstants,
  pipelineFieldKey,
  resolveFieldRef,
  rowsToCsv,
  rowsToLabeled,
  toCamelKey,
  toConstName,
} from '../src/quickbase/schema.js';
import type { QbField } from '../src/quickbase/types.js';
import { extractQblResource, summarizeQbl } from '../src/solutions/qbl.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const f = (id: number, label: string, fieldType = 'text', extra: Partial<QbField> = {}): QbField => ({ id, label, fieldType, ...extra });

describe('code page build (qb-deploy compatible)', () => {
  it('injects placeholders and fails loudly on missing ones', () => {
    const src = 'select: [__QB_FIELD:compDetails.firstName__, __QB_FIELD:compDetails.tid__]';
    expect(injectFields(src, { compDetails: { firstName: 16, tid: 18 } }, { target: 't', envName: 'dev' })).toBe('select: [16, 18]');
    expect(() => injectFields(src, { compDetails: { firstName: 16 } }, { target: 't', envName: 'dev' })).toThrow(/compDetails.tid/);
  });

  it('stamps, strips and reads the build stamp', () => {
    const built = buildPage({ source: '<html></html>\r\n', fieldMap: null, target: 'kpi', envName: 'dev', sha: 'abc1234', stamp: true });
    expect(built.body.startsWith('<!-- qb-deploy | kpi | dev | abc1234 |')).toBe(true);
    expect(readStamp(built.body)).toMatchObject({ target: 'kpi', env: 'dev', sha: 'abc1234' });
    expect(stripStamp(built.body)).toBe(built.bare);
  });
});

describe('analyzeCodePage', () => {
  const a = analyzeCodePage(fixture('codepage.html'));

  it('finds table IDs, field constants and query fields', () => {
    expect(a.title).toBe('Competency radar');
    expect(a.dbids.map((d) => d.id).sort()).toEqual(['bqh6r3m9w', 'bqh6r4tz7']);
    expect(a.fidConstants.map((c) => `${c.name}=${c.fid}`)).toEqual(['FID_FIRST_NAME=16', 'FID_LAST_NAME=17', 'FID_TID=99', 'FID_CURRENT_LEVEL=18']);
    expect(a.queryFieldIds).toEqual([18, 404]);
    expect(a.selectFieldIds).toEqual([16, 17, 18]);
    expect(a.usesTempToken).toBe(true);
    expect(a.realmHosts).toEqual(['acme.quickbase.com']);
  });

  it('flags unpinned CDNs and unescaped innerHTML but not pinned ones', () => {
    const codes = a.findings.map((x) => x.code);
    expect(codes).toContain('unpinned-cdn');
    expect(a.externalScripts.find((s) => s.src.includes('jspdf'))?.pinned).toBe(true);
    expect(codes).toContain('innerhtml-unescaped');
    expect(codes).not.toContain('embedded-user-token');
  });

  it('flags embedded user tokens as errors', () => {
    const bad = analyzeCodePage('<script>fetch(u,{headers:{Authorization:"QB-USER-TOKEN b5grq7_jxdx_0_bqzzzzzzzzzzzzzzzzzzzzzzz"}})</script>');
    expect(bad.findings.filter((x) => x.severity === 'error').map((x) => x.code).sort()).toEqual(['embedded-user-token', 'user-token-auth']);
  });

  it('cross-checks IDs against the live schema', async () => {
    const tables: Record<string, QbField[]> = {
      bqh6r4tz7: [f(16, 'First Name'), f(17, 'Surname'), f(18, 'Current Level', 'numeric')],
    };
    const check = await checkAgainstSchema(a, async (id) => (tables[id] ? { fields: tables[id] } : null));
    const byName = Object.fromEntries(check.fields.map((x) => [x.name, x.status]));
    expect(byName).toEqual({ FID_FIRST_NAME: 'ok', FID_LAST_NAME: 'label-mismatch', FID_TID: 'not-found', FID_CURRENT_LEVEL: 'ok' });
    expect(check.tables.find((t) => t.id === 'bqh6r3m9w')?.status).toBe('not-found');
    expect(check.queryFields).toEqual([{ fid: 18, status: 'ok' }, { fid: 404, status: 'not-found' }]);
  });
});

describe('pipelines', () => {
  const yaml = fixture('pipeline-escalation.yaml');
  const parsed = parsePipelineYaml(yaml);

  it('parses headers, slugs, tables, fields and Jinja refs', () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.name).toBe('Escalate overdue containment');
    expect(parsed.enabled).toBe(false);
    expect(parsed.accountSlugs).toEqual([{ channel: 'quickbase', slug: 'Qa1B2c3', label: 'Pipelines service account <None>' }]);
    expect(parsed.tables).toEqual(['bq8drpt01', 'bq8cnta02']);
    const a = parsed.steps.find((s) => s.letter === 'a')!;
    expect(a).toMatchObject({ kind: 'TRIGGER', channel: 'quickbase', slug: 'Qa1B2c3', resource: 'record', action: 'on_update', tableId: 'bq8drpt01' });
    expect(a.exportFieldIds).toEqual([6, 11, 24, 7]);
    expect(a.triggerFieldIds).toEqual([24]);
    expect(a.queryFieldIds).toEqual([7]);
    const b = parsed.steps.find((s) => s.letter === 'b')!;
    expect(b.exportFieldIds).toEqual([8, 9]);
    expect(b.queryFieldIds).toEqual([8, 9]);
    expect(b.jinjaRefs).toEqual([{ step: 'a', attr: 'id' }]);
    const c = parsed.steps.find((s) => s.letter === 'c')!;
    expect(c).toMatchObject({ kind: 'ACTION', target: 'a', resource: 'record', action: 'update' });
    expect(parsed.steps.find((s) => s.kind === 'AND')?.conditions).toEqual(['b<> !empty']);
    expect(parsed.steps.find((s) => s.letter === 'e')?.bodyDbids).toEqual(['bq8cnta02']);
  });

  it('parses header and value helpers', () => {
    expect(parseStepHeader('QUERY quickbase[PoAvqbr#dlarson] record search -> a')).toMatchObject({ kind: 'QUERY', slug: 'PoAvqbr#dlarson', letter: 'a' });
    expect(parseStepHeader('b<>LOOP')).toMatchObject({ kind: 'LOOP', target: 'b' });
    expect(parseFieldList('"A, B" <15, 19>')).toEqual([15, 19]);
    expect(parseFieldList('19')).toEqual([19]);
    expect(parseTableRef('"BOM Builder: BOM" <bsvvevad4>')).toEqual({ id: 'bsvvevad4', label: 'BOM Builder: BOM' });
    expect(jinjaRefs('{%- for x in plist if x|trim != "" %}{{ loop.last }} {{a.quick_fill}}{% endfor %}')).toEqual([{ step: 'a', attr: 'quick_fill' }]);
  });

  it('lints against a schema: missing tables, fields and input keys', async () => {
    const schema: Record<string, QbField[]> = {
      bq8drpt01: [f(6, 'Report Number'), f(7, 'Status'), f(11, 'Owner', 'user'), f(24, 'Containment Due', 'datetime'), f(30, 'Escalation Level', 'numeric')],
    };
    const { issues, tables } = await lintPipeline(parsed, { fields: async (id) => schema[id] ?? null });
    const codes = issues.map((i) => i.code);
    expect(tables.find((t) => t.tableId === 'bq8cnta02')?.status).toBe('not-found');
    expect(codes).toContain('table-not-found');
    expect(issues.find((i) => i.code === 'input-field-unknown')?.message).toContain('not_a_field');
    expect(codes).not.toContain('unknown-step-ref');
    expect(codes).not.toContain('field-not-found');
  });

  it('reports references to undefined steps', async () => {
    const broken = parsePipelineYaml("- META:\n    name: x\n- TRIGGER quickbase[s1] record on_create -> a:\n    inputs-meta:\n      table: bq8drpt01\n- ACTION quickbase[s1] record create -> b:\n    inputs:\n      note: '{{ z.name }}'\n");
    const { issues } = await lintPipeline(broken);
    expect(issues.find((i) => i.code === 'unknown-step-ref')?.message).toContain('"z"');
    expect(issues.find((i) => i.code === 'undeclared-slug')).toBeDefined();
  });

  it('remaps tables, slugs and field IDs with minimal changes', () => {
    const r = remapPipeline(yaml, {
      tableMap: { bq8drpt01: 'bq9prod001', bq8cnta02: 'bq9prod002' },
      slugMap: { Qa1B2c3: 'Zz9Yy8x' },
      fieldMap: { bq8drpt01: { '24': 124, '7': 107 }, bq8cnta02: { '9': 19 } },
      rename: 'Escalate overdue containment (PROD)',
    });
    expect(r.text).toContain("<bq9prod001>'");
    expect(r.text).toContain('table: bq9prod002');
    expect(r.text).toContain('quickbase[Zz9Yy8x] record on_update');
    expect(r.text).toContain('#  - quickbase[Zz9Yy8x]:');
    expect(r.text).toContain("trigger_fields: '\"Containment Due\" <124>'");
    expect(r.text).toContain("export_fields: '\"Report Number, Owner, Containment Due, Status\" <6, 11, 124, 107>'");
    expect(r.text).toContain("query: '{107.XEX.''Closed''}'");
    expect(r.text).toContain("export_fields: '8, 19'");
    expect(r.text).toContain('name: Escalate overdue containment (PROD)');
    expect(r.text).not.toContain('bq8drpt01');
    expect(r.review.some((x) => x.includes('numeric field keys'))).toBe(true);
    expect(parsePipelineYaml(r.text).errors).toEqual([]);
  });
});

describe('QBL', () => {
  const qbl = fixture('solution.qbl.yaml');

  it('summarizes resources, refs and bad refs', () => {
    const s = summarizeQbl(qbl);
    expect(s.errors).toEqual([]);
    expect(s.qblVersion).toBe('0.12');
    expect(s.countsByType).toEqual({ 'QB::Application': 1, 'QB::Table': 1, 'QB::FormV2': 1, 'QB::CodePage': 1 });
    expect(s.parameters).toEqual(['RealmHost']);
    expect(s.refCount).toBe(1);
    expect(s.badRefs).toEqual([{ path: 'Resources.$Table_Defects.Properties.Fields[].Formula', value: '17' }]);
  });

  it('extracts one resource with tags and code page source', () => {
    const page = extractQblResource(qbl, '$CodePage_Line_Board');
    expect(page?.type).toBe('QB::CodePage');
    expect(page?.code).toContain('<title>Line board</title>');
    const form = extractQblResource(qbl, '$Form_Defect_Entry');
    expect(form?.yaml).toContain('!Ref $Table_Defects');
    expect(extractQblResource(qbl, '$Nope')).toBeNull();
  });
});

describe('schema helpers', () => {
  const fields = [f(3, 'Record ID#', 'recordid'), f(6, 'First Name'), f(7, 'Required Level', 'numeric'), f(8, '% Complete', 'percent'), f(9, 'first name')];

  it('derives names', () => {
    expect(toCamelKey('Required Level')).toBe('requiredLevel');
    expect(toConstName('Record ID#')).toBe('RECORD_ID');
    expect(toConstName('% Complete')).toBe('PCT_COMPLETE');
    expect(toConstName('2nd Shift')).toBe('F_2ND_SHIFT');
    expect(pipelineFieldKey('Fire Pipeline')).toBe('fire_pipeline');
  });

  it('resolves field references by ID or label with suggestions', () => {
    expect(resolveFieldRef(fields, 7)).toBe(7);
    expect(resolveFieldRef(fields, 'required level')).toBe(7);
    expect(() => resolveFieldRef(fields, 42)).toThrow(/does not exist/);
    expect(() => resolveFieldRef(fields, 'Requird Level')).toThrow(/Did you mean: "Required Level" \(7\)/);
  });

  it('generates constants in every style and reports collisions', () => {
    const table = { id: 'bqh6r4tz7', name: 'Comp Details' };
    const js = generateFieldConstants([{ table, alias: 'compDetails', fields }], 'js-const', { realm: 'acme.quickbase.com', appId: 'bqh6r2kxa' });
    expect(js.code).toContain('const DBID_COMP_DETAILS = "bqh6r4tz7";');
    expect(js.code).toContain('const FID_REQUIRED_LEVEL = 7;');
    expect(js.code).toContain('const FID_FIRST_NAME_9 = 9;');
    expect(js.collisions).toHaveLength(1);
    const json = JSON.parse(generateFieldConstants([{ table, alias: 'compDetails', fields }], 'qb-deploy-json', { realm: 'r', appId: 'a' }).code);
    expect(json.compDetails.requiredLevel).toBe(7);
    const ts = generateFieldConstants([{ table, alias: 'compDetails', fields }], 'typescript', { realm: 'r', appId: 'a' }).code;
    expect(ts).toContain('} as const);');
    // '% Complete' has no letters before the word, so its key is just `complete`.
    expect(ts).toContain('complete: 8,');
  });

  it('formats records and schema maps', () => {
    const rows = rowsToLabeled([{ '6': { value: 'Ana' }, '11': { value: { email: 'a@x.com', name: 'Ana B', id: '1' } } }], [f(6, 'First Name'), f(11, 'Owner')]);
    expect(rows).toEqual([{ 'First Name': 'Ana', Owner: 'Ana B <a@x.com>' }]);
    expect(rowsToCsv([{ a: 'x,y', b: 1 }])).toBe('a,b\n"x,y",1\n');
    const md = formatSchemaMarkdown({
      realm: 'acme.quickbase.com',
      generatedAt: '2026-11-04T00:00:00Z',
      app: { id: 'bqh6r2kxa', name: 'Plant Skills', variables: [] },
      tables: [{ id: 'bqh6r4tz7', name: 'Comp Details', alias: '_DBID_COMP_DETAILS', keyFieldId: 3, fields: [f(1, 'Date Created'), f(16, 'First Name', 'text', { required: true })], relationships: [{ id: 1, parentTableId: 'bqh6r3m9w', childTableId: 'bqh6r4tz7', foreignKeyField: { id: 32, label: 'Related Position', type: 'numeric' } }] }],
      missingTableIds: [],
    });
    expect(md).toContain('## Comp Details — `bqh6r4tz7`');
    expect(md).toContain('| 16 | First Name | text | required |');
    expect(md).not.toContain('| 1 | Date Created');
    expect(md).toContain('via reference FID 32');
  });
});
