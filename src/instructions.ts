import type { AppContext } from './context.js';

/** Server instructions sent to the client (server/discover and the 2025-era initialize result). Keep them short. */
export function buildInstructions(ctx: AppContext): string {
  const writes = ctx.config.allowWrites;
  const envs = ctx.envNames;
  const skills = ctx.skills?.list().map((s) => s.name) ?? [];
  return [
    'Quickbase MCP server. Quickbase is a low-code database: apps contain tables; tables and apps have dbids like "bqh6r4tz7"; fields have integer IDs (FIDs); 1-5 are built-ins (3 = Record ID#).',
    'Rules: never guess a table or field ID. Call get_schema_map (or get_fields) first and reuse the IDs it returns; generate code constants with generate_field_constants.',
    'Code pages are read/written through the XML API (get_code_page, diff_code_page, analyze_code_page, deploy_code_page). Pages authenticate with temporary tokens, never user tokens.',
    'Pipelines have no public API: work on exported YAML in the workspace (inspect_pipeline, remap_pipeline, save_pipeline), then import in the Quickbase UI. Forms, dashboards and roles are reachable only through Solutions/QBL (export_solution, inspect_qbl; Enterprise plans).',
    writes
      ? 'Writes are enabled. Before any change, say what will change and wait for the user. Protected environments and deletes need an exact confirm phrase that the tool returns.'
      : 'This server is read-only (QB_ALLOW_WRITES is off); write tools are not available.',
    envs.length > 1 ? `Environments: ${envs.join(', ')} (default ${ctx.config.defaultEnv}). Pass env to target another.` : '',
    skills.length
      ? `Skills (expert playbooks): ${skills.join(', ')}. Load the relevant skill (load_skill, or the matching prompt / skill:// resource) before building code pages, pipelines, apps or automotive workflows. For any UI, follow automotive-ui-design-system.`
      : '',
    'See the quickbase://capabilities resource for what the Quickbase APIs can and cannot do.',
  ]
    .filter(Boolean)
    .join('\n');
}
