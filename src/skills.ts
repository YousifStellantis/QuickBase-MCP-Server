/**
 * Skill library: the Agent Skills (SKILL.md folders) this server ships, plus
 * an optional folder of your own (QB_SKILLS_DIR), e.g. official brand rules.
 *
 * Exposed four ways so every client gets them:
 *  1. The MCP Skills extension (io.modelcontextprotocol/skills, SEP-2640):
 *     skills/list, skills/get, resources/read skill://quickbase/<name>/SKILL.md
 *  2. Plain MCP resources (the same skill:// URIs appear in resources/list)
 *  3. MCP prompts, one per skill (slash commands in Claude Code, VS Code, ...)
 *  4. Tools (list_skills / load_skill) for clients that only support tools
 *
 * Folders can also be copied straight into a client's native skills directory
 * with `quickbase-mcp install-skills`.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillsExtension, memorySkillFiles, type SkillCatalog } from '@modelcontextprotocol/server/ext/skills';
import type { Logger } from './logger.js';

export const SKILL_PREFIX = 'quickbase';
export const BUILT_IN_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url));

export interface SkillInfo {
  name: string;
  description: string;
  uri: string;
  files: string[];
  source: 'built-in' | 'custom';
  metadata?: Record<string, unknown>;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function readSkillFolders(root: string): Promise<Map<string, Map<string, Uint8Array>>> {
  const skills = new Map<string, Map<string, Uint8Array>>();
  if (!existsSync(root)) return skills;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, 'SKILL.md'))) continue;
    const files = new Map<string, Uint8Array>();
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && (await stat(full)).size <= MAX_FILE_BYTES) {
          files.set(relative(dir, full).split(sep).join('/'), new Uint8Array(await readFile(full)));
        }
      }
    };
    await walk(dir);
    skills.set(entry.name, files);
  }
  return skills;
}

export class SkillLibrary {
  private constructor(
    readonly catalog: SkillCatalog,
    private readonly files: Map<string, Map<string, Uint8Array>>,
    private readonly sources: Map<string, 'built-in' | 'custom'>,
  ) {}

  static async load(opts: { builtInDir?: string; extraDir?: string; logger?: Logger } = {}): Promise<SkillLibrary> {
    const builtIn = await readSkillFolders(opts.builtInDir ?? BUILT_IN_SKILLS_DIR);
    const sources = new Map<string, 'built-in' | 'custom'>([...builtIn.keys()].map((k) => [k, 'built-in' as const]));
    if (opts.extraDir) {
      for (const [name, files] of await readSkillFolders(opts.extraDir)) {
        if (builtIn.has(name)) opts.logger?.info(`custom skill "${name}" overrides the built-in one`);
        builtIn.set(name, files);
        sources.set(name, 'custom');
      }
    }
    const record: Record<string, Uint8Array> = {};
    for (const [name, files] of builtIn) for (const [path, bytes] of files) record[`${name}/${path}`] = bytes;
    const catalog = await SkillsExtension.load(memorySkillFiles(record), {
      prefix: SKILL_PREFIX,
      cacheHint: { ttlMs: 300_000, cacheScope: 'public' },
      onWarning: (w) => opts.logger?.warn(`skill ${w.path}: ${w.message}`),
    });
    return new SkillLibrary(catalog, builtIn, sources);
  }

  list(): SkillInfo[] {
    return this.catalog.entries.map((e) => {
      const name = String(e.frontmatter.name);
      const files = Array.isArray(e.resources) ? e.resources.map((r) => r.uri.replace(`skill://${SKILL_PREFIX}/${name}/`, '')) : [];
      const { name: _n, description: _d, ...rest } = e.frontmatter as Record<string, unknown>;
      return {
        name,
        description: String(e.frontmatter.description),
        uri: e.uri,
        files,
        source: this.sources.get(name) ?? 'built-in',
        metadata: Object.keys(rest).length ? rest : undefined,
      };
    });
  }

  has(name: string): boolean {
    return this.catalog.entries.some((e) => e.frontmatter.name === name);
  }

  /** A skill file as text; null when the skill or file does not exist. Paths are relative to the skill folder. */
  read(name: string, file = 'SKILL.md'): string | null {
    if (!this.has(name)) return null;
    const normalized = file.replace(/^\.\//, '').replace(/\\/g, '/');
    if (normalized.split('/').includes('..')) return null;
    const bytes = this.files.get(name)?.get(normalized);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  /** SKILL.md without its YAML frontmatter. */
  body(name: string): string | null {
    const md = this.read(name);
    return md === null ? null : md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  }

  /** Copy-ready view of every skill (used by `quickbase-mcp install-skills`). */
  allFiles(): Map<string, Map<string, Uint8Array>> {
    return this.files;
  }
}
