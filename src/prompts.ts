/**
 * Prompts: reusable starting points that clients surface as slash commands
 * (Claude Code: /mcp__quickbase__<name>). Workflow prompts chain the right
 * tools and skills; skill prompts load one skill into the conversation.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AppContext } from './context.js';

const user = (t: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: t } }] });

export function registerPrompts(server: McpServer, ctx: AppContext): void {
  server.registerPrompt(
    'build-code-page',
    {
      title: 'Build a Quickbase code page',
      description: 'Design and build a code page (dashboard, form, tool) that uses real table/field IDs and the automotive design system.',
      argsSchema: z.object({ goal: z.string().describe('What the page should do, for whom'), appId: z.string().optional() }),
    },
    ({ goal, appId }) =>
      user(
        [
          `Build a Quickbase code page: ${goal}`,
          appId ? `App: ${appId}.` : 'Use the default app unless I say otherwise.',
          '',
          'Work in this order:',
          '1. load_skill quickbase-code-pages and automotive-ui-design-system (follow both; the page must not look AI-generated).',
          '2. get_schema_map, then generate_field_constants for the tables the page needs. Never type IDs by hand.',
          '3. Sketch the layout and data flow in a few lines and ask me to confirm before writing code.',
          '4. Write the page as one self-contained HTML file in the workspace (temp-token auth, pagination, error states, empty states, print styles).',
          '5. analyze_code_page on the file and fix every error and warning.',
          '6. Show me the result; deploy only when I ask (deploy_code_page with dryRun first).',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'review-code-page',
    {
      title: 'Review a code page',
      description: 'Engineering + design review of an existing code page against the live schema and the design system.',
      argsSchema: z.object({ pageOrPath: z.string().describe('Page ID, page name, target, or workspace path') }),
    },
    ({ pageOrPath }) =>
      user(
        `Review the code page "${pageOrPath}". Run analyze_code_page (IDs checked against the live schema), then load automotive-ui-design-system and review the visual design against its checklist. ` +
          'Report findings by severity with concrete fixes (file and line). Do not change anything until I approve.',
      ),
  );

  server.registerPrompt(
    'explain-app',
    {
      title: 'Explain an app',
      description: 'Architecture overview of an app: tables, relationships (Mermaid ER diagram), key fields, automations and roles.',
      argsSchema: z.object({ appId: z.string().optional() }),
    },
    ({ appId }) =>
      user(
        `Explain the Quickbase app ${appId ?? '(default app)'}. Use get_schema_map, list_app_events and list_app_roles. ` +
          'Give: purpose (inferred), a Mermaid erDiagram of tables and relationships, the key fields per table, automations (webhooks, notifications, automations), roles, and risks (formula fields with heavy lookups, missing keys, unused tables).',
      ),
  );

  server.registerPrompt(
    'promote-pipeline',
    {
      title: 'Promote a pipeline DEV -> PROD',
      description: 'Remap a pipeline YAML export to another app/environment, lint it against the target schema, and prepare it for import.',
      argsSchema: z.object({ file: z.string().describe('Workspace path to the exported YAML'), sourceAppId: z.string(), targetAppId: z.string() }),
    },
    ({ file, sourceAppId, targetAppId }) =>
      user(
        `Promote the pipeline in ${file} from app ${sourceAppId} to app ${targetAppId}. Load quickbase-pipelines-yaml first. ` +
          'Run inspect_pipeline on the source, then remap_pipeline with autoMap, then inspect_pipeline on the result against the target. ' +
          'List every change and every item needing manual review, ask me for the target account slug if it differs, and finish with the exact import steps.',
      ),
  );

  server.registerPrompt(
    'design-app',
    {
      title: 'Design a Quickbase app for an automotive workflow',
      description: 'Turn a workflow (8D, PPAP tracker, launch readiness, competency matrix, maintenance) into tables, fields, relationships, reports and automations.',
      argsSchema: z.object({ workflow: z.string().describe('e.g. "8D problem solving for supplier quality escapes"') }),
    },
    ({ workflow }) =>
      user(
        `Design a Quickbase app for: ${workflow}. Load the relevant automotive skill (automotive-quality-core-tools, plant-competency-matrix, plant-kpi-dictionary or automotive-software-compliance) and quickbase-schema-design. ` +
          'Propose tables, key fields, field types, relationships, formula fields (test with run_formula if an app exists), reports, and pipelines/notifications. Present it as a reviewable spec; create nothing until I approve.',
      ),
  );

  const lib = ctx.skills;
  if (!lib) return;
  for (const skill of lib.list()) {
    server.registerPrompt(
      skill.name,
      { title: `Skill: ${skill.name}`, description: skill.description.slice(0, 300) },
      () => {
        const body = lib.body(skill.name) ?? '';
        const extra = skill.files.filter((f) => f !== 'SKILL.md');
        return user(
          `Use this skill for the rest of the task.\n\n${body}` +
            (extra.length ? `\n\nSupporting files (load_skill name="${skill.name}" file="..."): ${extra.join(', ')}` : ''),
        );
      },
    );
  }
}
