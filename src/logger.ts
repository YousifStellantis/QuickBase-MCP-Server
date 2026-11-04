/**
 * stderr-only logger.
 *
 * A stdio MCP server owns stdout for JSON-RPC; a single stray console.log
 * corrupts the stream. Everything here goes to stderr, which clients such as
 * Claude Desktop capture into mcp-server-<name>.log.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(level: LogLevel, secrets: () => string[] = () => []): Logger {
  const min = ORDER[level] ?? ORDER.info;

  const write = (lvl: LogLevel, msg: string, extra?: unknown) => {
    if (ORDER[lvl] < min) return;
    let line = `[quickbase-mcp] ${lvl.toUpperCase()} ${msg}`;
    if (extra !== undefined) {
      const detail = extra instanceof Error ? extra.message : safeStringify(extra);
      line += ` ${detail}`;
    }
    process.stderr.write(redact(line, secrets()) + '\n');
  };

  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
  };
}

/** Replace every occurrence of each secret with a fixed marker. Short strings are ignored to avoid mangling text. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('[REDACTED]');
  }
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
