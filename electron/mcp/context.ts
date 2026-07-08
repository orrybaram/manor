/**
 * "Which project am I running in?" — resolves the calling agent's Manor context
 * so tools can default `projectId` instead of demanding it (ADR-150).
 *
 * Runs inside the standalone MCP process, so it knows nothing of Manor's
 * internals: the control server answers `GET /context` and we render what it says.
 */

import type { Http } from "./types";

export interface CallerContext {
  projectId: string;
  projectName: string;
  projectPath: string;
  workspacePath: string;
  branch: string;
  isMain: boolean;
  sources: string[];
  /** Diagnostic — how the server matched us. Not for the model to condition on. */
  resolvedBy: "paneId" | "cwd";
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

/**
 * `Http.get` collapses a non-2xx into `Error("HTTP <status>: <raw body>")`. The
 * 404 body is the whole point of the route's contract — it carries the candidate
 * projects — so dig it back out rather than surfacing a wall of JSON.
 */
function candidateListing(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const match = /^HTTP 404: ([\s\S]*)$/.exec(err.message);
  if (!match) return null;

  let body: ContextNotFound;
  try {
    body = JSON.parse(match[1]) as ContextNotFound;
  } catch {
    return null;
  }
  if (!body?.error || !Array.isArray(body.candidates)) return null;

  const listing = body.candidates
    .map((c) => `  - ${c.projectId}: ${c.name} (${c.path})`)
    .join("\n");
  return listing ? `${body.error}\n${listing}` : body.error;
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
    const listing = candidateListing(err);
    if (!listing) throw err;
    // `cause` is attached by assignment rather than the ErrorOptions ctor arg:
    // this file compiles against `target: ES2020`, whose Error type predates both.
    const friendly: Error & { cause?: unknown } = new Error(listing);
    friendly.cause = err;
    throw friendly;
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
