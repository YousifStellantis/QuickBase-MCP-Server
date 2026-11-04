/**
 * Local workspace: the only directory this server reads or writes on disk.
 *
 * Code pages, pipeline YAML exports, QBL snapshots, schema snapshots and
 * downloaded files all live under one root. Every path an agent supplies is
 * resolved against it and rejected if it escapes (including via symlinks).
 */

import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WorkspaceError } from './quickbase/errors.js';

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute path for `p` (relative to the root, or absolute inside it). Throws if it leaves the workspace. */
  resolve(p: string): string {
    if (!p || typeof p !== 'string') throw new WorkspaceError('A file path is required.');
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.root, p);
    if (!this.isInside(abs, this.root)) {
      throw new WorkspaceError(`Path "${p}" is outside the workspace (${this.root}). Use a path inside it, or set QB_WORKSPACE.`);
    }
    // Symlink escape check against the nearest existing ancestor.
    const realRoot = existsSync(this.root) ? realpathSync(this.root) : this.root;
    let probe = abs;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    if (existsSync(probe)) {
      const realProbe = realpathSync(probe);
      if (!this.isInside(realProbe, realRoot)) {
        throw new WorkspaceError(`Path "${p}" resolves through a symlink to outside the workspace.`);
      }
    }
    return abs;
  }

  /** Path relative to the root, with forward slashes, for display. */
  display(abs: string): string {
    const rel = relative(this.root, abs);
    return (rel || '.').split(sep).join('/');
  }

  exists(p: string): boolean {
    return existsSync(this.resolve(p));
  }

  async readText(p: string): Promise<string> {
    const abs = this.resolve(p);
    if (!existsSync(abs)) throw new WorkspaceError(`File not found in workspace: ${this.display(abs)}`);
    return readFile(abs, 'utf8');
  }

  async writeText(p: string, content: string): Promise<string> {
    const abs = this.resolve(p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return abs;
  }

  async writeBytes(p: string, content: Uint8Array): Promise<string> {
    const abs = this.resolve(p);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return abs;
  }

  /** Recursively list files under `dir` whose names match `pattern`. Skips node_modules and dot-directories except `.quickbase`. */
  async list(dir: string, pattern?: RegExp, maxFiles = 500): Promise<Array<{ path: string; bytes: number; modified: string }>> {
    const start = this.resolve(dir);
    if (!existsSync(start)) return [];
    const out: Array<{ path: string; bytes: number; modified: string }> = [];
    const walk = async (d: string) => {
      if (out.length >= maxFiles) return;
      for (const entry of await readdir(d, { withFileTypes: true })) {
        if (out.length >= maxFiles) return;
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || (entry.name.startsWith('.') && entry.name !== '.quickbase')) continue;
          await walk(full);
        } else if (entry.isFile() && (!pattern || pattern.test(entry.name))) {
          const s = await stat(full);
          out.push({ path: this.display(full), bytes: s.size, modified: s.mtime.toISOString() });
        }
      }
    };
    await walk(start);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  }
}

/** Filesystem-safe slug for generated file names. */
export function slugify(value: string, fallback = 'item'): string {
  const s = String(value)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return s || fallback;
}
