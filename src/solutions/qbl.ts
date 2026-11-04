/**
 * QBL (Quickbase Language) helpers for the Solution APIs.
 *
 * QBL is CloudFormation-like YAML:
 *
 *   Resources:
 *     $App_Plant_Quality:
 *       Type: QB::Application
 *       Properties: { Name: ..., Manager: ... }
 *     $Table_Defects:
 *       Type: QB::Table
 *       ...
 *
 * with custom tags such as !Ref (a reference to another logical ID) and
 * !BadRef (a reference Quickbase could not resolve on export). The text is
 * never re-serialized here: a YAML round trip can change quoting, and the
 * Solution APIs are the source of truth. Resources are read, summarized and
 * extracted; edits happen on the exported file itself.
 */

import { Document, isMap, isPair, isScalar, isSeq, parseDocument, visit, type Node, type Pair } from 'yaml';

export interface QblResourceInfo {
  logicalId: string;
  type: string;
  name?: string;
}

export interface QblSummary {
  qblVersion?: string;
  topLevelKeys: string[];
  resources: QblResourceInfo[];
  countsByType: Record<string, number>;
  badRefs: Array<{ path: string; value: string }>;
  refCount: number;
  parameters: string[];
  errors: string[];
}

function load(text: string): Document.Parsed {
  return parseDocument(text, { uniqueKeys: false, strict: false });
}

function resourcesMap(doc: Document.Parsed) {
  const r = doc.get('Resources', true);
  return isMap(r) ? r : null;
}

function scalarString(node: unknown): string | undefined {
  if (isScalar(node)) return node.value === null || node.value === undefined ? undefined : String(node.value);
  return undefined;
}

export function summarizeQbl(text: string): QblSummary {
  const doc = load(text);
  const errors = doc.errors.map((e) => e.message.split('\n')[0]);
  const summary: QblSummary = { topLevelKeys: [], resources: [], countsByType: {}, badRefs: [], refCount: 0, parameters: [], errors };
  if (!isMap(doc.contents)) {
    if (!errors.length) summary.errors.push('QBL must be a YAML mapping with a Resources key.');
    return summary;
  }

  for (const pair of doc.contents.items) {
    const key = scalarString(pair.key) ?? '';
    summary.topLevelKeys.push(key);
    if (/qbl.?version/i.test(key)) summary.qblVersion = scalarString(pair.value);
    if (key === 'ParameterDefinitions' && isMap(pair.value)) {
      summary.parameters = pair.value.items.map((p) => scalarString(p.key) ?? '').filter(Boolean);
    }
  }

  const resources = resourcesMap(doc);
  if (!resources) summary.errors.push('No Resources mapping found.');
  for (const pair of resources?.items ?? []) {
    const logicalId = scalarString(pair.key) ?? '?';
    const value = pair.value;
    const type = isMap(value) ? (scalarString(value.get('Type', true)) ?? '?') : '?';
    let name: string | undefined;
    if (isMap(value)) {
      const props = value.get('Properties', true);
      if (isMap(props)) name = scalarString(props.get('Name', true)) ?? scalarString(props.get('Label', true));
    }
    summary.resources.push({ logicalId, type, name });
    summary.countsByType[type] = (summary.countsByType[type] ?? 0) + 1;
  }

  visit(doc, {
    Scalar(_key, node, path) {
      if (!node.tag) return;
      if (node.tag.includes('BadRef')) summary.badRefs.push({ path: describePath(path), value: String(node.value) });
      else if (node.tag.includes('Ref')) summary.refCount++;
    },
  });
  return summary;
}

function describePath(path: readonly unknown[]): string {
  const parts: string[] = [];
  for (const p of path) {
    if (isPair(p)) parts.push(scalarString((p as Pair).key) ?? '?');
    else if (isSeq(p)) parts.push('[]');
  }
  return parts.join('.').replace(/\.\[\]/g, '[]');
}

/** One resource as standalone YAML (tags preserved), plus its code for QB::CodePage resources. */
export function extractQblResource(text: string, logicalId: string): { type: string; name?: string; yaml: string; code?: string } | null {
  const doc = load(text);
  const resources = resourcesMap(doc);
  const node = resources?.get(logicalId, true);
  if (!node) return null;
  const out = new Document();
  out.contents = new Document().createNode({});
  if (isMap(out.contents)) out.contents.set(logicalId, node as Node);
  const yaml = out.toString({ lineWidth: 0 });
  let type = '?';
  let name: string | undefined;
  let code: string | undefined;
  if (isMap(node)) {
    type = scalarString(node.get('Type', true)) ?? '?';
    const props = node.get('Properties', true);
    if (isMap(props)) {
      name = scalarString(props.get('Name', true)) ?? scalarString(props.get('Label', true));
      for (const k of ['RawCode', 'Code', 'Content', 'Body']) {
        const v = scalarString(props.get(k, true));
        if (v) {
          code = v;
          break;
        }
      }
    }
  }
  return { type, name, yaml, code };
}

/** Resource types shown in summaries with a friendlier label. */
export const QBL_TYPE_HINTS: Record<string, string> = {
  'QB::Application': 'app',
  'QB::Table': 'table',
  'QB::Report': 'report',
  'QB::Form': 'form (legacy)',
  'QB::FormV2': 'form (new forms)',
  'QB::Dashboard': 'dashboard',
  'QB::Role': 'role',
  'QB::CodePage': 'code page',
  'QB::Pipeline': 'pipeline',
};
