/**
 * Promote a pipeline export between environments (e.g. DEV app -> PROD app).
 *
 * Table IDs and account slugs are replaced textually, so the output diff is
 * exactly those substitutions and nothing else. Field IDs are rewritten only in
 * the structured places (export_fields, trigger_fields, query) of steps whose
 * table is mapped; numeric field keys inside free-form JSON bodies are
 * reported for manual review rather than guessed at.
 */

import { parseTableRef } from './parse.js';

export interface RemapOptions {
  tableMap?: Record<string, string>;
  slugMap?: Record<string, string>;
  /** Source table ID -> (old FID -> new FID). */
  fieldMap?: Record<string, Record<string, number>>;
  rename?: string;
}

export interface RemapResult {
  text: string;
  changes: string[];
  review: string[];
}

const HEADER_LINE = /^(\s*)-\s+(?:[a-z]+<>)?[A-Z][A-Z_]*\b.*:\s*$/;

export function remapPipeline(source: string, opts: RemapOptions): RemapResult {
  const changes: string[] = [];
  const review: string[] = [];
  let text = source.replace(/\r\n/g, '\n');

  // 1. Field IDs, per step block, before table IDs change (fieldMap is keyed by source table).
  if (opts.fieldMap && Object.keys(opts.fieldMap).length) {
    const lines = text.split('\n');
    const starts: number[] = [];
    lines.forEach((l, i) => {
      if (HEADER_LINE.test(l)) starts.push(i);
    });
    starts.push(lines.length);
    for (let b = 0; b < starts.length - 1; b++) {
      const from = starts[b];
      const to = starts[b + 1];
      const tableLine = lines.slice(from, to).find((l) => /^\s*table:\s*/.test(l));
      const tableId = tableLine ? parseTableRef(tableLine.replace(/^\s*table:\s*/, '').replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')).id : undefined;
      const map = tableId ? opts.fieldMap[tableId] : undefined;
      const header = lines[from].trim();
      if (!map) {
        // Steps without a mapped table (e.g. quickbase_api make) can still write to a
        // remapped table through a JSON body; flag numeric field keys for review.
        for (let i = from + 1; i < to; i++) {
          if (/"\d+"\s*:\s*\{/.test(lines[i]) || /\\"\d+\\"\s*:/.test(lines[i])) {
            review.push(`${header}: a free-form body uses numeric field keys (${lines[i].trim().slice(0, 80)}…); check them against the target table.`);
            break;
          }
        }
        continue;
      }
      for (let i = from + 1; i < to; i++) {
        const line = lines[i];
        const fieldsLine = line.match(/^(\s*(?:export_fields|trigger_fields):\s*)(.*)$/);
        if (fieldsLine) {
          const value = fieldsLine[2].trimEnd();
          const q = value[0] === "'" || value[0] === '"' ? value[0] : '';
          if (q && (value.length < 2 || value[value.length - 1] !== q)) {
            review.push(`${header}: ${line.trim()} spans several lines; remap its field IDs by hand.`);
            continue;
          }
          const inner = q ? value.slice(1, -1) : value;
          const mapList = (list: string) =>
            list
              .split(',')
              .map((x) => x.trim())
              .map((x) => (map[x] !== undefined ? String(map[x]) : x))
              .join(', ');
          const mappedInner = /<[\d,\s]+>\s*$/.test(inner)
            ? inner.replace(/<([\d,\s]+)>\s*$/, (_, list: string) => `<${mapList(list)}>`)
            : /^[\d,\s]+$/.test(inner)
              ? mapList(inner)
              : inner;
          const replaced = q ? `${q}${mappedInner}${q}` : mappedInner;
          if (replaced !== value) {
            lines[i] = fieldsLine[1] + replaced;
            changes.push(`${header}: ${line.trim()} -> ${lines[i].trim()}`);
          }
          continue;
        }
        const queryLine = line.match(/^(\s*query:\s*)(.*)$/);
        if (queryLine) {
          const replaced = queryLine[2].replace(/\{(\s*'?)(\d+)('?\s*\.\s*[A-Z]{2,4}\s*\.)/g, (whole, pre: string, fid: string, post: string) =>
            map[fid] !== undefined ? `{${pre}${map[fid]}${post}` : whole,
          );
          if (replaced !== queryLine[2]) {
            lines[i] = queryLine[1] + replaced;
            changes.push(`${header}: query ${queryLine[2].trim()} -> ${replaced.trim()}`);
          }
          continue;
        }
        if (/"\d+"\s*:\s*\{/.test(line) || /\\"\d+\\"\s*:/.test(line)) {
          review.push(`${header}: a free-form body uses numeric field keys (${line.trim().slice(0, 80)}…); check them against the target table.`);
        }
      }
    }
    text = lines.join('\n');
  }

  // 2. Table IDs (anywhere: inputs-meta, JSON bodies, URLs).
  for (const [from, to] of Object.entries(opts.tableMap ?? {})) {
    if (!from || from === to) continue;
    const re = new RegExp(`\\b${escapeRe(from)}\\b`, 'g');
    const count = (text.match(re) ?? []).length;
    if (count) {
      text = text.replace(re, to);
      changes.push(`table ${from} -> ${to} (${count} occurrence${count > 1 ? 's' : ''})`);
    }
  }

  // 3. Account slugs, in step headers and the "# Account slugs" comment block.
  for (const [from, to] of Object.entries(opts.slugMap ?? {})) {
    if (!from || from === to) continue;
    const re = new RegExp(`\\[${escapeRe(from)}\\]`, 'g');
    const count = (text.match(re) ?? []).length;
    if (count) {
      text = text.replace(re, `[${to}]`);
      changes.push(`account slug [${from}] -> [${to}] (${count} occurrence${count > 1 ? 's' : ''})`);
    }
  }

  // 4. Optional rename of META.name.
  if (opts.rename) {
    const lines = text.split('\n');
    const metaAt = lines.findIndex((l) => /^\s*-\s+META:\s*$/.test(l));
    if (metaAt >= 0) {
      for (let i = metaAt + 1; i < lines.length && !/^\s*-\s+/.test(lines[i]); i++) {
        const m = lines[i].match(/^(\s*name:\s*)(.*)$/);
        if (m) {
          const quotedName = /[:#'"{}[\],&*!|>%@`]/.test(opts.rename) ? JSON.stringify(opts.rename) : opts.rename;
          changes.push(`META.name ${m[2].trim()} -> ${quotedName}`);
          lines[i] = m[1] + quotedName;
          break;
        }
      }
      text = lines.join('\n');
    }
  }

  if (/https?:\/\/[a-z0-9-]+\.quickbase\.com/i.test(text)) {
    review.push('The YAML contains realm-specific URLs; confirm they point at the target realm.');
  }
  return { text, changes, review };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
