/**
 * Parser for Quickbase Pipelines YAML exports.
 *
 * Shape of a real export (Pipelines > ⋮ > Export > Download YAML):
 *
 *   # Create BOM Records
 *   # Account slugs:
 *   #  - quickbase[o4OvZbK]: Pipeline Token <None>
 *   ---
 *   - META:
 *       name: Create BOM Records
 *       enabled: false
 *   - TRIGGER quickbase[o4OvZbK] record on_update -> a:
 *       inputs-meta:
 *         export_fields: '"Quick Fill Reference Fields, Fire Pipeline" <15, 19>'
 *         query: '{19.EX.1}'
 *         table: '"BOM Builder: BOM" <bsvvevad4>'
 *   - a<>ACTION quickbase record update -> c:
 *       inputs:
 *         fire_pipeline: 'false'
 *   ...
 *
 * Step headers: [<target>"<>"]<KIND> [<channel>[<slug>] <resource> <action>] [-> <letter>]
 * Control blocks (LOOP / IF / AND / OR / THEN / ELSE / DO) hold lists of steps or conditions.
 */

import { parse as parseYaml } from 'yaml';

export interface PipelineStep {
  key: string;
  path: string;
  depth: number;
  kind: string;
  letter?: string;
  target?: string;
  channel?: string;
  slug?: string;
  resource?: string;
  action?: string;
  tableId?: string;
  tableLabel?: string;
  exportFieldIds: number[];
  triggerFieldIds: number[];
  queryFieldIds: number[];
  inputKeys: string[];
  jinjaRefs: Array<{ step: string; attr: string }>;
  bodyDbids: string[];
  conditions: string[];
}

export interface ParsedPipeline {
  name?: string;
  enabled?: boolean;
  description?: string;
  accountSlugs: Array<{ channel: string; slug: string; label: string }>;
  steps: PipelineStep[];
  tables: string[];
  channels: string[];
  errors: string[];
  warnings: string[];
}

export const KNOWN_KINDS = new Set(['META', 'TRIGGER', 'ACTION', 'QUERY', 'LOOP', 'IF', 'AND', 'OR', 'THEN', 'ELSE', 'DO', 'ELIF', 'SWITCH', 'CASE', 'RETURN']);

const HEADER_RE =
  /^(?:(?<target>[a-z]+)<>)?(?<kind>[A-Z][A-Z_]*)(?:\s+(?<channel>[a-z0-9_]+)(?:\[(?<slug>[^\]]+)\])?(?:\s+(?<resource>[a-z0-9_]+))?(?:\s+(?<action>[a-z0-9_]+))?)?(?:\s*->\s*(?<letter>[a-z]+))?\s*$/;

const QUERY_FID_RE = /\{\s*'?(\d+)'?\s*\.\s*[A-Z]{2,4}\s*\./g;

export function parseStepHeader(key: string): Omit<PipelineStep, 'path' | 'depth' | 'exportFieldIds' | 'triggerFieldIds' | 'queryFieldIds' | 'inputKeys' | 'jinjaRefs' | 'bodyDbids' | 'conditions' | 'key'> | null {
  const m = key.trim().match(HEADER_RE);
  if (!m?.groups) return null;
  const g = m.groups;
  return {
    kind: g.kind,
    letter: g.letter,
    target: g.target,
    channel: g.channel,
    slug: g.slug,
    resource: g.resource,
    action: g.action,
  };
}

/** '"Label A, Label B" <15, 19>' -> [15, 19]; '6, 8' -> [6, 8]; '19' -> [19]. */
export function parseFieldList(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  const s = String(value);
  const inner = s.match(/<([\d,\s]+)>\s*$/)?.[1] ?? (/^[\d,\s]+$/.test(s.trim()) ? s : '');
  return inner
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** '"BOM Builder: BOM" <bsvvevad4>' -> { id, label }; 'bsxhcgm73' -> { id }. */
export function parseTableRef(value: unknown): { id?: string; label?: string } {
  if (value === undefined || value === null) return {};
  const s = String(value).trim();
  const withLabel = s.match(/^"?(.*?)"?\s*<([a-z0-9]{6,12})>$/i);
  if (withLabel) return { id: withLabel[2], label: withLabel[1] || undefined };
  if (/^[a-z0-9]{6,12}$/i.test(s)) return { id: s };
  return {};
}

export function queryFieldIds(query: unknown): number[] {
  if (typeof query !== 'string') return [];
  return [...new Set([...query.matchAll(QUERY_FID_RE)].map((m) => Number(m[1])))];
}

/** Step references inside Jinja blocks: {{ a.name }}, {% for x in b %} ... -> [{step:'a', attr:'name'}]. */
export function jinjaRefs(text: string): Array<{ step: string; attr: string }> {
  const out: Array<{ step: string; attr: string }> = [];
  for (const block of text.matchAll(/\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g)) {
    const inner = block[1] ?? block[2] ?? '';
    // Single-letter step names only, not preceded by a word char or dot (so loop.last, ns.x are ignored).
    for (const m of inner.matchAll(/(?<![\w.])([a-z]{1,2})\.([a-z_][a-z0-9_]*)/g)) out.push({ step: m[1], attr: m[2] });
  }
  return out;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

export function parseAccountSlugs(text: string): ParsedPipeline['accountSlugs'] {
  const out: ParsedPipeline['accountSlugs'] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '---') break;
    const m = line.match(/^#\s*-\s*([a-z0-9_]+)\[([^\]]+)\]:\s*(.*)$/i);
    if (m) out.push({ channel: m[1], slug: m[2], label: m[3].trim() });
  }
  return out;
}

export function parsePipelineYaml(text: string): ParsedPipeline {
  const result: ParsedPipeline = { accountSlugs: parseAccountSlugs(text), steps: [], tables: [], channels: [], errors: [], warnings: [] };

  let doc: unknown;
  try {
    doc = parseYaml(text, { uniqueKeys: false });
  } catch (err) {
    result.errors.push(`YAML does not parse: ${(err as Error).message.split('\n')[0]}`);
    return result;
  }
  if (!Array.isArray(doc)) {
    result.errors.push('A pipeline export is a YAML list (META first, then steps). This document is not a list.');
    return result;
  }

  const walk = (items: unknown[], path: string, depth: number) => {
    items.forEach((item, index) => {
      const here = `${path}[${index}]`;
      if (typeof item === 'string') {
        // A condition inside AND / OR, e.g. "b<> !empty".
        const parent = result.steps[result.steps.length - 1];
        if (parent) parent.conditions.push(item);
        return;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        result.warnings.push(`${here}: unexpected item (${typeof item}).`);
        return;
      }
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        if (key === 'META') {
          const meta = (value ?? {}) as Record<string, unknown>;
          result.name = typeof meta.name === 'string' ? meta.name : result.name;
          result.enabled = typeof meta.enabled === 'boolean' ? meta.enabled : result.enabled;
          result.description = typeof meta.description === 'string' ? meta.description : result.description;
          continue;
        }
        const header = parseStepHeader(key);
        if (!header) {
          result.errors.push(`${here}: step header "${key}" is not in the export format (e.g. "ACTION quickbase[slug] record create -> b").`);
          continue;
        }
        const step: PipelineStep = {
          key,
          path: here,
          depth,
          ...header,
          exportFieldIds: [],
          triggerFieldIds: [],
          queryFieldIds: [],
          inputKeys: [],
          jinjaRefs: [],
          bodyDbids: [],
          conditions: [],
        };
        result.steps.push(step);
        if (step.channel && !result.channels.includes(step.channel)) result.channels.push(step.channel);

        if (Array.isArray(value)) {
          walk(value, `${here}.${header.kind}`, depth + 1);
        } else if (value && typeof value === 'object') {
          const body = value as Record<string, unknown>;
          const meta = (body['inputs-meta'] ?? {}) as Record<string, unknown>;
          const inputs = (body.inputs ?? {}) as Record<string, unknown>;
          const table = parseTableRef(meta.table);
          step.tableId = table.id;
          step.tableLabel = table.label;
          if (table.id && !result.tables.includes(table.id)) result.tables.push(table.id);
          step.exportFieldIds = parseFieldList(meta.export_fields);
          step.triggerFieldIds = parseFieldList(meta.trigger_fields);
          step.queryFieldIds = [...new Set([...queryFieldIds(meta.query), ...queryFieldIds(inputs.query)])];
          step.inputKeys = Object.keys(inputs);
          const strings = collectStrings([inputs, meta]);
          step.jinjaRefs = strings.flatMap(jinjaRefs);
          step.bodyDbids = [...new Set(strings.flatMap((s) => [...s.matchAll(/"(?:to|from)"\s*:\s*"(b[a-z0-9]{7,9})"/g)].map((m) => m[1])))];
          for (const [k, v] of Object.entries(body)) {
            if (Array.isArray(v)) walk(v, `${here}.${k}`, depth + 1);
          }
        }
      }
    });
  };

  walk(doc, 'steps', 0);
  if (result.name === undefined) result.warnings.push('No META block with a pipeline name.');
  return result;
}
