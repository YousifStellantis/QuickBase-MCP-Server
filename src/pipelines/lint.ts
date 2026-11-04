/**
 * Pipeline lint: structural checks, plus (optionally) every table and field
 * the pipeline touches checked against the live realm. This catches the
 * classic failure after a solution install or DEV->PROD copy: the YAML still
 * points at old table IDs or field IDs, imports cleanly, and fails at run time.
 */

import { BUILT_IN_FIELDS, type QbField } from '../quickbase/types.js';
import { pipelineFieldKey } from '../quickbase/schema.js';
import { KNOWN_KINDS, type ParsedPipeline, type PipelineStep } from './parse.js';

export interface LintIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  step?: string;
}

export interface FieldsLookup {
  /** Fields of a table, or null if the table does not exist / is not readable with this token. */
  fields(tableId: string): Promise<QbField[] | null>;
}

/** Non-field inputs on common actions (they must not be reported as unknown fields). */
const NON_FIELD_INPUTS = new Set(['body', 'content_type', 'method', 'url', 'headers', 'duration', 'query', 'table', 'export_fields', 'merge_field', 'note', 'pipeline_note']);

function stepLabel(s: PipelineStep): string {
  return s.letter ? `${s.letter} (${s.kind}${s.channel ? ` ${s.channel}` : ''}${s.resource ? ` ${s.resource}` : ''}${s.action ? ` ${s.action}` : ''})` : `${s.kind} at ${s.path}`;
}

export async function lintPipeline(
  parsed: ParsedPipeline,
  lookup?: FieldsLookup,
): Promise<{ issues: LintIssue[]; tables: Array<{ tableId: string; status: 'ok' | 'not-found' | 'unchecked'; fieldCount?: number }> }> {
  const issues: LintIssue[] = [];
  for (const e of parsed.errors) issues.push({ severity: 'error', code: 'parse', message: e });
  for (const w of parsed.warnings) issues.push({ severity: 'warning', code: 'structure', message: w });

  if (parsed.enabled === true) {
    issues.push({ severity: 'info', code: 'enabled-on-import', message: 'META.enabled is true. Imported pipelines start disabled; enable it after reviewing the steps.' });
  }

  // Letters: unique, and references must point at earlier steps.
  const order = new Map<string, number>();
  parsed.steps.forEach((s, i) => {
    if (!s.letter) return;
    if (order.has(s.letter)) issues.push({ severity: 'error', code: 'duplicate-letter', message: `Step letter "${s.letter}" is used more than once.`, step: s.letter });
    else order.set(s.letter, i);
  });
  parsed.steps.forEach((s, i) => {
    if (!KNOWN_KINDS.has(s.kind)) issues.push({ severity: 'info', code: 'unknown-kind', message: `Step kind "${s.kind}" is not one this linter knows; it was not checked.`, step: s.letter ?? s.path });
    const refs = [...s.jinjaRefs.map((r) => r.step), ...(s.target ? [s.target] : [])];
    for (const ref of new Set(refs)) {
      const at = order.get(ref);
      if (at === undefined) {
        issues.push({ severity: 'error', code: 'unknown-step-ref', message: `${stepLabel(s)} references step "${ref}", which does not exist.`, step: s.letter ?? s.path });
      } else if (at > i) {
        issues.push({ severity: 'warning', code: 'forward-ref', message: `${stepLabel(s)} references step "${ref}", which runs later.`, step: s.letter ?? s.path });
      }
    }
  });

  // Account slugs: every slug used should be declared in the header.
  const declared = new Set(parsed.accountSlugs.map((a) => `${a.channel}[${a.slug}]`));
  const used = new Set(parsed.steps.filter((s) => s.slug).map((s) => `${s.channel}[${s.slug}]`));
  for (const u of used) {
    if (!declared.has(u)) issues.push({ severity: 'warning', code: 'undeclared-slug', message: `Account ${u} is used by a step but not listed in the "# Account slugs" header.` });
  }
  if (used.size > 1 && [...used].some((u) => u.startsWith('quickbase['))) {
    issues.push({ severity: 'info', code: 'multiple-accounts', message: `Steps use ${used.size} different accounts (${[...used].join(', ')}). A single service account is easier to promote between environments.` });
  }

  const tables: Array<{ tableId: string; status: 'ok' | 'not-found' | 'unchecked'; fieldCount?: number }> = [];
  if (!lookup) {
    for (const t of parsed.tables) tables.push({ tableId: t, status: 'unchecked' });
    return { issues, tables };
  }

  const fieldCache = new Map<string, QbField[] | null>();
  const getFields = async (tableId: string) => {
    if (!fieldCache.has(tableId)) fieldCache.set(tableId, await lookup.fields(tableId).catch(() => null));
    return fieldCache.get(tableId) ?? null;
  };

  const allTableIds = [...new Set([...parsed.tables, ...parsed.steps.flatMap((s) => s.bodyDbids)])];
  for (const tableId of allTableIds) {
    const fields = await getFields(tableId);
    tables.push({ tableId, status: fields ? 'ok' : 'not-found', fieldCount: fields?.length });
    if (!fields) {
      issues.push({ severity: 'error', code: 'table-not-found', message: `Table ${tableId} does not exist in this realm or this token cannot read it. After a DEV->PROD move, remap it with remap_pipeline.` });
    }
  }

  const tableOfStep = new Map<string, string>();
  for (const s of parsed.steps) if (s.letter && s.tableId) tableOfStep.set(s.letter, s.tableId);

  for (const s of parsed.steps) {
    const tableId = s.tableId ?? (s.target ? tableOfStep.get(s.target) : undefined);
    if (!tableId) continue;
    const fields = await getFields(tableId);
    if (!fields) continue;
    const ids = new Set(fields.map((f) => f.id));
    const check = (list: number[], where: string) => {
      for (const fid of list) {
        if (!ids.has(fid) && !(fid in BUILT_IN_FIELDS)) {
          issues.push({ severity: 'error', code: 'field-not-found', message: `${stepLabel(s)}: ${where} uses field ${fid}, which table ${tableId} does not have.`, step: s.letter ?? s.path });
        }
      }
    };
    check(s.exportFieldIds, 'export_fields');
    check(s.triggerFieldIds, 'trigger_fields');
    check(s.queryFieldIds, 'query');

    // record create/update/upsert inputs are snake_case field labels.
    if (s.channel === 'quickbase' && s.resource === 'record' && s.inputKeys.length) {
      const keys = new Set(fields.map((f) => pipelineFieldKey(f.label)));
      keys.add('id');
      for (const k of s.inputKeys) {
        if (NON_FIELD_INPUTS.has(k)) continue;
        if (!keys.has(k)) {
          issues.push({
            severity: 'warning',
            code: 'input-field-unknown',
            message: `${stepLabel(s)}: input "${k}" does not match any field label on table ${tableId} (pipelines use snake_case labels, e.g. "Fire Pipeline" -> fire_pipeline).`,
            step: s.letter ?? s.path,
          });
        }
      }
    }
  }

  return { issues, tables };
}
