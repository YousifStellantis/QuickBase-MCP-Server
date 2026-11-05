/** Error types with enough context for an agent to fix the call instead of guessing. */

export class QuickbaseApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly description?: string;
  readonly body?: unknown;

  constructor(opts: { status: number; method: string; path: string; message: string; description?: string; body?: unknown }) {
    super(opts.message);
    this.name = 'QuickbaseApiError';
    this.status = opts.status;
    this.method = opts.method;
    this.path = opts.path;
    this.description = opts.description;
    this.body = opts.body;
  }

  /** A one-line, actionable hint keyed off the HTTP status. */
  get hint(): string | undefined {
    switch (this.status) {
      case 400:
        return 'Quickbase rejected the request body or parameters. Check field IDs, query syntax ({fid.OP.value}) and value types.';
      case 401:
        return 'The user token was rejected. Check QB_USER_TOKEN (expired or deactivated?) and that QB_REALM is the right hostname, e.g. yourcompany.quickbase.com.';
      case 403:
        return 'Access denied. The token user may lack role permissions, or the token is not assigned to this app (Quickbase: My preferences > Manage user tokens > Assign token to apps).';
      case 404:
        return 'Not found. Check the app/table/field/report ID. Table and app IDs (dbids) look like "bqh6r4tz7"; field IDs are integers.';
      case 429:
        return 'Rate limited by Quickbase (about 100 requests per 10 seconds per user token). The server already retried; slow down or narrow the request.';
      default:
        return this.status >= 500 ? 'Quickbase returned a server error. Retry later; if it persists, check status.quickbase.com.' : undefined;
    }
  }
}

export class QuickbaseXmlError extends Error {
  readonly action: string;
  readonly code: number;
  readonly text: string;
  readonly detail?: string;

  constructor(action: string, code: number, text: string, detail?: string) {
    super(`${action} failed (errcode ${code}): ${text}${detail ? ` -- ${detail}` : ''}`);
    this.name = 'QuickbaseXmlError';
    this.action = action;
    this.code = code;
    this.text = text;
    this.detail = detail;
  }

  /** errcode 4 = bad/expired ticket or token, 24 = invalid app token. Everything else is reported verbatim. */
  get isAuthError(): boolean {
    return this.code === 4 || this.code === 22 || this.code === 24;
  }
}

/** Raised by the server's own guardrails (read-only mode, allowlists, confirmations). */
export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardError';
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
