/**
 * Tool fallback for skills. Clients that implement the MCP Skills extension
 * read skill:// resources directly; every other client (Claude Code, Claude
 * Desktop, Cursor, VS Code, Codex, Gemini CLI ... as of late 2026) can still
 * use the same skills through these two tools.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { json, READ_ONLY, safe, text } from './util.js';

export function registerSkillTools(server: McpServer, ctx: AppContext): void {
  const lib = ctx.skills;
  if (!lib) return;
  const names = lib.list().map((s) => s.name);
  if (!names.length) return;

  server.registerTool(
    'list_skills',
    {
      title: 'List built-in skills',
      description:
        'Skills are expert playbooks bundled with this server: Quickbase schema and query rules, code page engineering, a modern automotive UI design system (so pages do not look AI-generated), pipelines YAML, QBL, and automotive quality / plant / software domain knowledge. Load the relevant one before starting a task.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    safe(async () => json(ctx, lib.list().map((s) => ({ name: s.name, description: s.description, files: s.files, source: s.source })))),
  );

  server.registerTool(
    'load_skill',
    {
      title: 'Load a skill',
      description: `Load a skill's instructions (SKILL.md), or one of its reference files. Available: ${names.join(', ')}.`,
      inputSchema: z.object({
        name: z.enum(names as [string, ...string[]]),
        file: z.string().optional().describe('A file listed by list_skills, e.g. references/tokens.css (default SKILL.md)'),
      }),
      annotations: READ_ONLY,
    },
    safe(async (args) => {
      const content = lib.read(args.name, args.file ?? 'SKILL.md');
      if (content === null) {
        const info = lib.list().find((s) => s.name === args.name);
        throw new Error(`No file "${args.file}" in skill ${args.name}. Files: ${info?.files.join(', ')}`);
      }
      return text(content);
    }),
  );
}
