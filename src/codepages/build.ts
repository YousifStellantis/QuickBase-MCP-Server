/**
 * Code page build steps, compatible with qb-deploy:
 *  - `__QB_FIELD:table.field__` placeholders become field IDs at deploy time,
 *    so a solution install that reassigns FIDs is a regenerate-and-redeploy
 *    instead of an archaeology project.
 *  - A leading build stamp `<!-- qb-deploy | target | env | sha | time -->`
 *    is the only way to tell which commit a live page came from.
 */

import { execFileSync } from 'node:child_process';

export const FIELD_RE = /__QB_FIELD:([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)__/g;
const STAMP_RE = /^[ \t]*<!--\s*qb-deploy\s*\|[^\n]*?-->[ \t]*\n?/;

export type FieldMap = Record<string, Record<string, number>>;

/** Normalise line endings and trailing whitespace so comparisons are stable. */
export function normalise(s: string): string {
  return String(s).replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

export function findPlaceholders(source: string): string[] {
  return [...new Set([...source.matchAll(FIELD_RE)].map((m) => `${m[1]}.${m[2]}`))];
}

/** Replace every placeholder or fail: a page querying "__QB_FIELD:x.y__" loads fine and silently shows nothing. */
export function injectFields(source: string, map: FieldMap | null, ctx: { target: string; envName: string }): string {
  const missing: string[] = [];
  const out = source.replace(FIELD_RE, (whole, table: string, field: string) => {
    const fid = map?.[table]?.[field];
    if (fid === undefined) {
      missing.push(`${table}.${field}`);
      return whole;
    }
    return String(fid);
  });
  if (missing.length) {
    const unique = [...new Set(missing)];
    throw new Error(
      `${ctx.target}: unresolved field reference${unique.length > 1 ? 's' : ''}: ${unique.join(', ')}. ` +
        `Regenerate the field map for "${ctx.envName}" (generate_field_constants style=qb-deploy-json) or fix the placeholder.`,
    );
  }
  return out;
}

export function makeStamp(s: { target: string; envName: string; sha: string; when: string }): string {
  return `<!-- qb-deploy | ${s.target} | ${s.envName} | ${s.sha} | ${s.when} -->`;
}

export function stripStamp(content: string): string {
  return String(content).replace(/\r\n/g, '\n').replace(STAMP_RE, '');
}

export function readStamp(content: string): { target: string; env: string; sha: string; when: string } | null {
  const m = String(content).match(/<!--\s*qb-deploy\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*-->/);
  return m ? { target: m[1], env: m[2], sha: m[3], when: m[4] } : null;
}

/** Short git SHA of the workspace, "-dirty" when uncommitted changes exist, "nogit" outside a repo. */
export function gitSha(root: string): string {
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const sha = run(['rev-parse', '--short', 'HEAD']);
    const dirty = run(['status', '--porcelain']);
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'nogit';
  }
}

export function buildPage(opts: {
  source: string;
  fieldMap: FieldMap | null;
  target: string;
  envName: string;
  sha: string;
  stamp: boolean;
}): { bare: string; body: string; stamp?: string } {
  const injected = findPlaceholders(opts.source).length ? injectFields(opts.source, opts.fieldMap, opts) : opts.source;
  const bare = normalise(stripStamp(injected));
  if (!opts.stamp) return { bare, body: bare };
  const stamp = makeStamp({ target: opts.target, envName: opts.envName, sha: opts.sha, when: new Date().toISOString() });
  return { bare, body: `${stamp}\n${bare}`, stamp };
}
