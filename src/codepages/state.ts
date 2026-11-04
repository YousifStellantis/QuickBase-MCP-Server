/**
 * Drift state: what was last deployed to each page, so a deploy can refuse to
 * overwrite a page someone edited in the browser. Code pages have no version
 * history and no rollback in Quickbase.
 *
 * Same file and key format as qb-deploy (`.qb-deploy-state.json`, keys
 * "<env>:<target>"), so both tools see each other's deploys.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DeployRecord {
  hash: string;
  pageId: string;
  at: string;
  sha?: string;
  by?: string;
}

export const STATE_FILE = '.qb-deploy-state.json';

export function contentHash(content: string): string {
  return createHash('sha256').update(String(content), 'utf8').digest('hex').slice(0, 16);
}

export function stateKey(envName: string, target: string): string {
  return `${envName}:${target}`;
}

export function loadState(root: string): Record<string, DeployRecord> {
  const path = join(root, STATE_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveState(root: string, state: Record<string, DeployRecord>): void {
  writeFileSync(join(root, STATE_FILE), JSON.stringify(state, null, 2) + '\n');
}
