/**
 * Schema discovery and formatting.
 *
 * The point of this module: an agent should never guess a table ID or field
 * ID. It asks for the schema map, gets every DBID and FID in a compact form,
 * and generates constants from it.
 */

import type { QuickbaseJsonClient } from './json-client.js';
import { BUILT_IN_FIELDS, type QbApp, type QbField, type QbRelationship, type QbTable } from './types.js';

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

export class SchemaService {
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly json: QuickbaseJsonClient,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  app(appId: string): Promise<QbApp> {
    return this.cached(`app:${appId}`, async () => (await this.json.get<QbApp>(`/apps/${appId}`)).data);
  }

  tables(appId: string): Promise<QbTable[]> {
    return this.cached(`tables:${appId}`, async () => (await this.json.get<QbTable[]>('/tables', { query: { appId } })).data ?? []);
  }

  table(appId: string, tableId: string): Promise<QbTable> {
    return this.cached(`table:${tableId}`, async () => (await this.json.get<QbTable>(`/tables/${tableId}`, { query: { appId } })).data);
  }

  fields(tableId: string, opts: { includeFieldPerms?: boolean } = {}): Promise<QbField[]> {
    const key = `fields:${tableId}:${opts.includeFieldPerms ? 'perms' : 'plain'}`;
    return this.cached(key, async () =>
      ((await this.json.get<QbField[]>('/fields', { query: { tableId, includeFieldPerms: opts.includeFieldPerms ? true : undefined } })).data ?? []).sort(
        (a, b) => a.id - b.id,
      ),
    );
  }

  relationships(tableId: string): Promise<QbRelationship[]> {
    return this.cached(`rels:${tableId}`, async () => {
      const out: QbRelationship[] = [];
      let skip = 0;
      for (let page = 0; page < 50; page++) {
        const res = await this.json.get<{ relationships: QbRelationship[]; metadata?: { numRelationships: number; totalRelationships: number } }>(
          `/tables/${tableId}/relationships`,
          { query: { skip: skip || undefined } },
        );
        const rels = res.data?.relationships ?? [];
        out.push(...rels);
        skip += rels.length;
        const total = res.data?.metadata?.totalRelationships ?? out.length;
        if (rels.length === 0 || skip >= total) break;
      }
      return out;
    });
  }

  /** Full schema for an app: tables, fields and (optionally) relationships. */
  async appSchema(appId: string, opts: { tableIds?: string[]; includeRelationships?: boolean } = {}): Promise<AppSchema> {
    const [app, tables] = await Promise.all([this.app(appId), this.tables(appId)]);
    const wanted = opts.tableIds?.length ? tables.filter((t) => opts.tableIds!.includes(t.id)) : tables;
    const missing = opts.tableIds?.filter((id) => !tables.some((t) => t.id === id)) ?? [];

    const withFields = await mapLimit(wanted, 4, async (t) => {
      const [fields, relationships] = await Promise.all([
        this.fields(t.id),
        opts.includeRelationships === false ? Promise.resolve([] as QbRelationship[]) : this.relationships(t.id).catch(() => [] as QbRelationship[]),
      ]);
      return { ...t, fields, relationships };
    });

    return {
      realm: this.json.realm,
      generatedAt: new Date().toISOString(),
      app: { id: app.id ?? appId, name: app.name, description: app.description, dateFormat: app.dateFormat, timeZone: app.timeZone, variables: app.variables ?? [] },
      tables: withFields,
      missingTableIds: missing,
    };
  }

  /** Which of the candidate apps contains this table (used by allowlist checks). */
  async appOfTable(tableId: string, candidateAppIds: string[]): Promise<string | undefined> {
    for (const appId of candidateAppIds) {
      try {
        if ((await this.tables(appId)).some((t) => t.id === tableId)) return appId;
      } catch {
        /* inaccessible app; try the next */
      }
    }
    return undefined;
  }

  invalidateTable(tableId: string): void {
    for (const key of [...this.cache.keys()]) if (key.includes(`:${tableId}`)) this.cache.delete(key);
  }

  invalidateApp(appId: string): void {
    this.cache.delete(`app:${appId}`);
    this.cache.delete(`tables:${appId}`);
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key) as CacheEntry<T> | undefined;
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = load();
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }
}

export interface AppSchema {
  realm: string;
  generatedAt: string;
  app: { id: string; name: string; description?: string; dateFormat?: string; timeZone?: string; variables: Array<{ name: string; value: string }> };
  tables: Array<QbTable & { fields: QbField[]; relationships: QbRelationship[] }>;
  missingTableIds: string[];
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */
/* Field presentation                                                  */
/* ------------------------------------------------------------------ */

export interface CompactField {
  id: number;
  label: string;
  type: string;
  mode?: string;
  flags?: string[];
  formula?: string;
  lookup?: { referenceFid?: number; targetFid?: number };
  summary?: { fn?: string; referenceFid?: number; targetFid?: number };
  choices?: string[];
  help?: string;
}

export function compactField(f: QbField, opts: { includeFormula?: boolean; includeHelp?: boolean } = {}): CompactField {
  const flags: string[] = [];
  if (f.required) flags.push('required');
  if (f.unique) flags.push('unique');
  if (f.properties?.primaryKey) flags.push('key');
  if (f.properties?.foreignKey) flags.push('reference');
  if (f.id in BUILT_IN_FIELDS) flags.push('built-in');
  const out: CompactField = { id: f.id, label: f.label, type: f.fieldType };
  if (f.mode) out.mode = f.mode;
  if (flags.length) out.flags = flags;
  if (opts.includeFormula && f.properties?.formula) out.formula = f.properties.formula;
  if (f.mode === 'lookup') out.lookup = { referenceFid: f.properties?.lookupReferenceFieldId, targetFid: f.properties?.lookupTargetFieldId };
  if (f.mode === 'summary') {
    out.summary = {
      fn: f.properties?.summaryFunction,
      referenceFid: f.properties?.summaryReferenceFieldId,
      targetFid: f.properties?.summaryTargetFieldId,
    };
  }
  if (Array.isArray(f.properties?.choices) && f.properties.choices.length) out.choices = f.properties.choices.slice(0, 25);
  if (opts.includeHelp && f.fieldHelp) out.help = f.fieldHelp;
  return out;
}

export function formatSchemaMarkdown(
  schema: AppSchema,
  opts: { includeBuiltIns?: boolean; includeFormulas?: boolean; maxFieldsPerTable?: number } = {},
): string {
  const lines: string[] = [];
  const fieldCount = schema.tables.reduce((n, t) => n + t.fields.length, 0);
  const tableName = new Map(schema.tables.map((t) => [t.id, t.name]));
  lines.push(`# ${schema.app.name} (\`${schema.app.id}\`)`);
  lines.push(`Realm \`${schema.realm}\` · ${schema.tables.length} tables · ${fieldCount} fields · generated ${schema.generatedAt}`);
  if (!opts.includeBuiltIns) {
    lines.push('Built-in fields on every table (omitted below): 1 Date Created, 2 Date Modified, 3 Record ID#, 4 Record Owner, 5 Last Modified By.');
  }
  if (schema.app.variables.length) {
    lines.push(`App variables: ${schema.app.variables.map((v) => `\`${v.name}\``).join(', ')}`);
  }
  if (schema.missingTableIds.length) lines.push(`Not found in this app: ${schema.missingTableIds.join(', ')}`);

  for (const t of schema.tables) {
    lines.push('');
    const meta = [
      `\`${t.id}\``,
      t.alias ? `alias \`${t.alias}\`` : null,
      t.keyFieldId && t.keyFieldId !== 3 ? `**key field ${t.keyFieldId}**` : 'key 3',
      t.singleRecordName ? `record: ${t.singleRecordName}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(`## ${t.name} — ${meta}`);
    const fields = t.fields.filter((f) => opts.includeBuiltIns || !(f.id in BUILT_IN_FIELDS));
    const max = opts.maxFieldsPerTable ?? 400;
    lines.push('| FID | Label | Type | Notes |');
    lines.push('|---:|---|---|---|');
    for (const f of fields.slice(0, max)) {
      const c = compactField(f, { includeFormula: opts.includeFormulas });
      const notes: string[] = [];
      if (c.mode) notes.push(c.mode);
      if (c.flags) notes.push(...c.flags.filter((x) => x !== 'built-in'));
      if (c.lookup) notes.push(`via ${c.lookup.referenceFid}→${c.lookup.targetFid}`);
      if (c.summary) notes.push(`${c.summary.fn ?? 'summary'} of ${c.summary.targetFid ?? '?'}`);
      if (c.choices) notes.push(`choices: ${c.choices.slice(0, 8).join(' / ')}${c.choices.length > 8 ? ' …' : ''}`);
      if (c.formula) notes.push(`\`${c.formula.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 160)}\``);
      lines.push(`| ${c.id} | ${escapeCell(c.label)} | ${c.type} | ${escapeCell(notes.join('; '))} |`);
    }
    if (fields.length > max) lines.push(`… ${fields.length - max} more fields (use get_fields for the full list)`);
    const parents = t.relationships.filter((r) => r.childTableId === t.id);
    for (const r of parents) {
      const lookups = (r.lookupFields ?? []).map((l) => `${l.id} ${l.label}`).join(', ');
      lines.push(
        `- Parent: **${tableName.get(r.parentTableId) ?? r.parentTableId}** \`${r.parentTableId}\` via reference FID ${r.foreignKeyField?.id ?? '?'}` +
          (lookups ? ` · lookups: ${lookups}` : '') +
          (r.isCrossApp ? ' · cross-app' : ''),
      );
    }
  }
  return lines.join('\n');
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/* ------------------------------------------------------------------ */
/* Names and field resolution                                          */
/* ------------------------------------------------------------------ */

/** qb-deploy's key style: "First Name" -> "firstName". */
export function toCamelKey(label: string): string {
  const words = String(label).replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
}

/** "Record ID#" -> "RECORD_ID", "% Complete" -> "PCT_COMPLETE". */
export function toConstName(label: string): string {
  let s = String(label)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase aliases: compDetails -> comp Details
    .replace(/%/g, ' pct ')
    .replace(/&/g, ' and ')
    .replace(/#/g, ' ');
  s = s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  if (!s) return '';
  return /^[0-9]/.test(s) ? `F_${s}` : s;
}

/** Pipelines refer to fields by snake_case label: "Fire Pipeline" -> "fire_pipeline". */
export function pipelineFieldKey(label: string): string {
  return String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function normalizeLabel(s: string): string {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export class FieldRefError extends Error {}

/** Resolve a FID, numeric string or label to a field ID. Labels match case-insensitively, then by camelCase key. */
export function resolveFieldRef(fields: QbField[], ref: number | string): number {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) {
    const id = Number(ref);
    if (fields.length && !fields.some((f) => f.id === id)) throw new FieldRefError(`Field ID ${id} does not exist on this table.`);
    return id;
  }
  const wanted = String(ref).trim();
  const exact = fields.find((f) => f.label.trim().toLowerCase() === wanted.toLowerCase());
  if (exact) return exact.id;
  const byKey = fields.filter((f) => toCamelKey(f.label) === toCamelKey(wanted) || normalizeLabel(f.label) === normalizeLabel(wanted));
  if (byKey.length === 1) return byKey[0].id;
  const suggestions = suggestLabels(fields, wanted);
  throw new FieldRefError(
    `No field labeled "${wanted}"${byKey.length > 1 ? ' (ambiguous)' : ''}.` + (suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''),
  );
}

export function suggestLabels(fields: QbField[], wanted: string, max = 5): string[] {
  const w = normalizeLabel(wanted);
  return fields
    .map((f) => ({ f, score: similarity(normalizeLabel(f.label), w) }))
    .filter((x) => x.score > 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => `"${x.f.label}" (${x.f.id})`);
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/* ------------------------------------------------------------------ */
/* Field constants for code pages                                      */
/* ------------------------------------------------------------------ */

export type ConstantsStyle = 'js-const' | 'js-object' | 'typescript' | 'qb-deploy-json';

export interface ConstantsInput {
  table: QbTable;
  alias: string;
  fields: QbField[];
}

export function generateFieldConstants(
  inputs: ConstantsInput[],
  style: ConstantsStyle,
  meta: { realm: string; appId: string; prefixWithTable?: boolean; includeBuiltIns?: boolean },
): { code: string; collisions: string[] } {
  const collisions: string[] = [];
  const header = `Generated by quickbase-mcp-server from ${meta.realm} app ${meta.appId} on ${new Date().toISOString().slice(0, 10)}. Regenerate instead of editing by hand.`;
  // Built-ins 1, 2, 4, 5 are noise in most pages; Record ID# (3) is always useful.
  const keep = (f: QbField) => meta.includeBuiltIns === true || !(f.id in BUILT_IN_FIELDS) || f.id === 3;

  if (style === 'qb-deploy-json') {
    const map: Record<string, Record<string, number>> = {};
    for (const { alias, fields } of inputs) {
      map[alias] = {};
      for (const f of fields.filter(keep)) {
        const key = toCamelKey(f.label) || `field${f.id}`;
        if (key in map[alias]) collisions.push(`${alias}.${key} (fids ${map[alias][key]} and ${f.id})`);
        map[alias][key] = f.id;
      }
    }
    return { code: JSON.stringify(map, null, 2) + '\n', collisions };
  }

  const lines: string[] = [];
  const prefix = meta.prefixWithTable ?? inputs.length > 1;

  if (style === 'js-const') {
    lines.push(`// ${header}`);
    lines.push(`const QB_REALM_HOSTNAME = "${meta.realm}";`, '');
    for (const { table, alias, fields } of inputs) {
      const tconst = toConstName(alias) || toConstName(table.name) || table.id.toUpperCase();
      lines.push(`// ${table.name}`);
      lines.push(`const DBID_${tconst} = "${table.id}";`);
      const seen = new Map<string, number>();
      for (const f of fields.filter(keep)) {
        let name = `FID_${prefix ? `${tconst}_` : ''}${toConstName(f.label) || `FIELD_${f.id}`}`;
        if (seen.has(name)) {
          collisions.push(`${name} (fids ${seen.get(name)} and ${f.id})`);
          name = `${name}_${f.id}`;
        }
        seen.set(name, f.id);
        lines.push(`const ${name} = ${f.id};${f.mode ? ` // ${f.mode}` : ''}`);
      }
      lines.push('');
    }
    return { code: lines.join('\n'), collisions };
  }

  // js-object / typescript
  const ts = style === 'typescript';
  lines.push(`// ${header}`);
  lines.push(`${ts ? 'export ' : ''}const QB = Object.freeze({`);
  lines.push(`  realm: "${meta.realm}",`);
  lines.push(`  appId: "${meta.appId}",`);
  lines.push('  tables: {');
  for (const { table, alias, fields } of inputs) {
    lines.push(`    ${jsKey(alias)}: {`);
    lines.push(`      id: "${table.id}", // ${table.name}`);
    lines.push('      fields: {');
    const seen = new Map<string, number>();
    for (const f of fields.filter(keep)) {
      let key = toCamelKey(f.label) || `field${f.id}`;
      if (seen.has(key)) {
        collisions.push(`${alias}.${key} (fids ${seen.get(key)} and ${f.id})`);
        key = `${key}${f.id}`;
      }
      seen.set(key, f.id);
      lines.push(`        ${jsKey(key)}: ${f.id},`);
    }
    lines.push('      },');
    lines.push('    },');
  }
  lines.push('  },');
  lines.push(ts ? '} as const);' : '});');
  return { code: lines.join('\n') + '\n', collisions };
}

function jsKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

/* ------------------------------------------------------------------ */
/* Records presentation                                                */
/* ------------------------------------------------------------------ */

export function simplifyValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if ('email' in v && ('name' in v || 'id' in v)) return v.name ? `${v.name} <${v.email}>` : v.email;
    if ('url' in v && 'versions' in v) {
      const versions = Array.isArray(v.versions) ? v.versions : [];
      const latest = versions[versions.length - 1] as Record<string, unknown> | undefined;
      return { file: latest?.fileName ?? null, versions: versions.length, url: v.url };
    }
  }
  if (Array.isArray(value)) return value.map(simplifyValue);
  return value;
}

export function rowsToLabeled(
  data: Array<Record<string, { value: unknown }>>,
  fields: Array<{ id: number; label: string }>,
): Array<Record<string, unknown>> {
  const label = new Map(fields.map((f) => [String(f.id), f.label]));
  return data.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [fid, cell] of Object.entries(row)) out[label.get(fid) ?? `fid ${fid}`] = simplifyValue(cell?.value);
    return out;
  });
}

export function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}
