/**
 * "Which project am I running in?" — resolves the calling agent's Manor context
 * so tools can default `projectId` instead of demanding it (ADR-150).
 *
 * Runs inside the standalone MCP process, so it knows nothing of Manor's
 * internals: the control server answers `GET /context` and we render what it says.
 */

import type { Http } from "./types";
import { HttpError } from "./types";

export interface CallerContext {
  projectId: string;
  projectName: string;
  projectPath: string;
  workspacePath: string;
  branch: string;
  isMain: boolean;
  sources: string[];
}

interface ContextCandidate {
  projectId: string;
  name: string;
  path: string;
}

interface ContextNotFound {
  error: string;
  candidates: ContextCandidate[];
}

export async function resolveContext(http: Http): Promise<CallerContext> {
  const params = new URLSearchParams();
  // Omit `paneId` entirely when unset — an empty value would read as a real
  // pane id the server then fails to find, skipping the cwd fallback.
  const paneId = process.env.MANOR_PANE_ID;
  if (paneId) params.set("paneId", paneId);
  params.set("cwd", process.cwd());

  try {
    return (await http.get(`/context?${params.toString()}`)) as CallerContext;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      const body = err.body as ContextNotFound | null;
      if (body?.error && Array.isArray(body.candidates)) {
        const listing = body.candidates
          .map((c) => `  - ${c.projectId}: ${c.name} (${c.path})`)
          .join("\n");
        const message = listing ? `${body.error}\n${listing}` : body.error;
        // `cause` is attached by assignment rather than the ErrorOptions ctor arg:
        // this file compiles against `target: ES2020`, whose Error type predates both.
        const friendly: Error & { cause?: unknown } = new Error(message);
        friendly.cause = err;
        throw friendly;
      }
    }
    throw err;
  }
}

/** Explicit `projectId` always wins; otherwise infer it from the caller's context. */
export async function resolveProjectId(
  http: Http,
  projectId?: string,
): Promise<string> {
  if (projectId) return projectId;
  return (await resolveContext(http)).projectId;
}

/** Explicit `workspacePath` always wins; otherwise infer it from the caller's context. */
export async function resolveWorkspacePath(
  http: Http,
  workspacePath?: string,
): Promise<string> {
  if (workspacePath) return workspacePath;
  return (await resolveContext(http)).workspacePath;
}
