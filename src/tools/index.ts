import type { McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { registerAdminTools } from './admin.js';
import { registerAppTools } from './apps.js';
import { registerCodePageTools } from './codepages.js';
import { registerConnectionTools } from './connection.js';
import { registerPipelineTools } from './pipelines.js';
import { registerRecordTools } from './records.js';
import { registerSchemaWriteTools } from './schema-write.js';
import { registerSkillTools } from './skills.js';
import { registerSolutionTools } from './solutions.js';

/** Register tools by toolset. Order is stable so tools/list is deterministic (2026-07-28 SHOULD). */
export function registerTools(server: McpServer, ctx: AppContext): void {
  const on = (t: Parameters<AppContext['config']['toolsets']['has']>[0]) => ctx.config.toolsets.has(t);
  registerConnectionTools(server, ctx);
  if (on('apps')) registerAppTools(server, ctx);
  if (on('records')) registerRecordTools(server, ctx);
  if (on('codepages')) registerCodePageTools(server, ctx);
  if (on('pipelines')) registerPipelineTools(server, ctx);
  if (on('solutions')) registerSolutionTools(server, ctx);
  if (on('schema')) registerSchemaWriteTools(server, ctx);
  if (on('admin')) registerAdminTools(server, ctx);
  if (on('skills')) registerSkillTools(server, ctx);
}
