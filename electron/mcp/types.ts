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
