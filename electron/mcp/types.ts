/**
 * Shared types for MCP tool modules.
 */

export interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
}

export interface Http {
  get(path: string): Promise<unknown>;
  post(
    path: string,
    body?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  del(path: string, body?: Record<string, unknown>): Promise<unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolModule {
  tools: ToolDef[];
  handlers: Record<
    string,
    (args: Record<string, unknown>, http: Http) => Promise<ToolResult>
  >;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text" as const, text: value }] };
}

/**
 * Thrown by `Http` implementations when a request completes with a non-2xx
 * status. Carries the parsed JSON body (when parseable) alongside the raw
 * text, so callers that care about a structured error contract (e.g. the
 * `/context` 404 candidate listing) don't have to regex it back out of a
 * formatted message string.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly rawBody: string,
  ) {
    super(`HTTP ${status}: ${rawBody}`);
    this.name = "HttpError";
  }
}
