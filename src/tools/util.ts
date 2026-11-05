/** Shared helpers for tool handlers: result formatting, error mapping, common input schemas. */

import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ConfigError, GuardError, QuickbaseApiError, QuickbaseXmlError, WorkspaceError } from '../quickbase/errors.js';
import { FieldRefError } from '../quickbase/schema.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] };
}

/** Markdown heading + pretty JSON, truncated at the configured output budget. */
export function json(ctx: AppContext, data: unknown, heading?: string, note?: string): ToolResult {
  let body = JSON.stringify(data, null, 2) ?? 'null';
  const max = ctx.config.maxOutputChars;
  let truncated = '';
  if (body.length > max) {
    body = body.slice(0, max);
    truncated = `\n… output truncated at ${max} characters. Narrow the request, or pass saveTo to write the full result to the workspace.`;
  }
  const parts = [heading ? `### ${heading}` : '', note ?? '', body + truncated].filter(Boolean);
  return text(parts.join('\n\n'));
}

export function clip(ctx: AppContext, t: string): string {
  const max = ctx.config.maxOutputChars;
  return t.length > max ? `${t.slice(0, max)}\n… truncated at ${max} characters.` : t;
}

export function errorResult(err: unknown): ToolResult {
  let msg: string;
  if (err instanceof QuickbaseApiError) {
    msg = [`Quickbase API error: ${err.message}`, err.description ? `Details: ${err.description}` : '', err.hint ? `Hint: ${err.hint}` : ''].filter(Boolean).join('\n');
  } else if (err instanceof QuickbaseXmlError) {
    msg = `Quickbase XML API error: ${err.message}${err.isAuthError ? '\nHint: the user token (or app token) was rejected; check that it is valid and assigned to this app.' : ''}`;
  } else if (err instanceof GuardError) {
    msg = `Blocked by server guardrails: ${err.message}`;
  } else if (err instanceof ConfigError) {
    msg = `Configuration problem: ${err.message}`;
  } else if (err instanceof WorkspaceError || err instanceof FieldRefError) {
    msg = err.message;
  } else if (err instanceof Error) {
    msg = err.message;
  } else {
    msg = String(err);
  }
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

/** Wrap a handler so every failure becomes a tool result the model can read and act on. */
export function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

export const dbid = (what: string) =>
  z
    .string()
    .trim()
    .regex(/^[a-z0-9]{6,12}$/i, `${what} looks like "bqh6r4tz7" (letters and digits)`)
    .describe(`${what} (Quickbase dbid, e.g. "bqh6r4tz7")`);

/** Optional `env` parameter, only advertised when more than one environment is configured. */
export function envParam(ctx: AppContext) {
  return ctx.multiEnv
    ? { env: z.enum(ctx.envNames as [string, ...string[]]).optional().describe(`Environment (default "${ctx.config.defaultEnv}")`) }
    : {};
}

export function getEnvArg(args: unknown): string | undefined {
  return (args as { env?: string }).env;
}

/** JSON scalar / small structure, declared explicitly so strict function-calling clients get a real schema. */
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const jsonValue = z.union([scalar, z.array(z.union([z.string(), z.number()])), z.record(z.string(), scalar)]);
export const jsonObject = z.record(z.string(), jsonValue);

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const REMOTE_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
export const REMOTE_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
