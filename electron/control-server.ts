/**
 * Manor-control HTTP routes — project/workspace management, GitHub issue
 * listing, batch issue→workspace fan-out, and agent launching.
 *
 * Extracted from WebviewServer (which is about webview inspection) so each
 * module stays cohesive. Consumed by webview-server.ts, which owns the HTTP
 * listener and delegates any `/projects…` or `/agents` request here.
 */

import crypto from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import type {
  ProjectManager,
  ProjectInfo,
  WorkspaceInfo,
  IssueSeed,
  WorkspaceFromIssue,
} from "./persistence";
import type { GitHubManager } from "./github";
import type { LinearManager, LinearAssociation } from "./linear";
import type {
  LayoutPersistence,
  PersistedLayout,
} from "./terminal-host/layout-persistence";
import { findWorkspaceForPane, matchProjectByPath } from "./pane-context";
import {
  isIssueSource,
  linearStateTypes,
  normalizeGitHubIssue,
  normalizeGitHubIssueDetail,
  normalizeLinearIssue,
  normalizeLinearIssueDetail,
  parseIssueState,
} from "./issue-sources";
import type { IssueSource } from "./issue-sources";

export interface ControlDeps {
  projectManager: ProjectManager | null;
  githubManager: GitHubManager | null;
  linearManager: LinearManager | null;
  layoutPersistence: LayoutPersistence | null;
}

/**
 * Payload of the main→renderer "app-command" channel.
 *
 * Two semantics share this channel. Without a `requestId` the send is
 * fire-and-forget (`start-agent`, `run-setup-script` — the renderer has nothing
 * meaningful to report back). With one, the renderer *must* reply on
 * "app-command-result" and main awaits it; see `requestRenderer`.
 */
export interface AppCommand {
  cmd: string;
  /** Present iff main expects a reply on "app-command-result". */
  requestId?: string;
  workspacePath?: string;
  prompt?: string;
  script?: string;
  /** Free-form args for correlated pane/tab commands. */
  args?: Record<string, unknown>;
}

/** Payload of the renderer→main "app-command-result" channel. */
export interface AppCommandResult {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Settled shape of a `requestRenderer` call. Never rejects — see below. */
export interface RendererResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

type Json = (status: number, body: unknown) => void;
type ReadBody = () => Promise<Record<string, unknown>>;

interface PendingRequest {
  resolve: (response: RendererResponse<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-flight `requestRenderer` calls, keyed by `requestId`. */
const pendingRequests = new Map<string, PendingRequest>();
let resultListenerInstalled = false;

/**
 * Install the single "app-command-result" listener, lazily, on first use.
 *
 * Deliberately `ipcMain.on` and not `ipcMain.once`: a `once` per request leaks
 * a listener for every request that times out before the renderer answers.
 * One listener routes every reply through `pendingRequests` instead.
 */
function installResultListener(): void {
  if (resultListenerInstalled) return;
  resultListenerInstalled = true;
  ipcMain.on(
    "app-command-result",
    (_event: unknown, result: AppCommandResult) => {
      if (!result || typeof result.requestId !== "string") return;
      const pending = pendingRequests.get(result.requestId);
      // Unknown id: a reply that arrived after its request timed out, or a
      // renderer replying to a command that never asked for one. Drop it.
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(result.requestId);
      pending.resolve({ ok: result.ok, data: result.data, error: result.error });
    },
  );
}

/**
 * Send an "app-command" the renderer must answer, and await the answer.
 *
 * Resolves rather than rejects on every failure path (no window, timeout,
 * handler error) — callers are HTTP route handlers that map `ok: false` onto a
 * status code, and an unhandled rejection there would surface as a 500.
 */
export function requestRenderer<T>(
  cmd: string,
  args?: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<RendererResponse<T>> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    return Promise.resolve({ ok: false, error: "No Manor window is open" });
  }
  installResultListener();

  const requestId = crypto.randomUUID();
  return new Promise<RendererResponse<T>>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ ok: false, error: "Renderer did not respond" });
    }, timeoutMs);
    pendingRequests.set(requestId, {
      resolve: resolve as PendingRequest["resolve"],
      timer,
    });
    const command: AppCommand = { cmd, requestId, ...(args ? { args } : {}) };
    win.webContents.send("app-command", command);
  });
}

/**
 * Map a `requestRenderer` failure onto an HTTP status. The two renderer-side
 * failure modes (`requestRenderer` never rejects) get `503`; anything else is
 * a handler throw — bad `paneId`, unknown workspace, invalid enum — and is the
 * caller's fault, `400`.
 */
function rendererErrorStatus(error: string | undefined): number {
  return error === "No Manor window is open" ||
    error === "Renderer did not respond"
    ? 503
    : 400;
}

interface BatchResultEntry {
  number: number;
  title: string;
  workspacePath?: string;
  started: boolean;
  error?: string;
}

/**
 * Ask the renderer to open a new agent pane in the given workspace. Agents are
 * launched by the renderer (App.tsx seeds a shell command), so main round-trips
 * the request over the "app-command" channel.
 */
export function startAgent(
  workspacePath: string,
  prompt?: string,
): { ok: boolean; error?: string } {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    return { ok: false, error: "No Manor window is open" };
  }
  const command: AppCommand = { cmd: "start-agent", workspacePath, prompt };
  win.webContents.send("app-command", command);
  return { ok: true };
}

/**
 * Ask the renderer to run the project's worktree start script in a new
 * workspace. Like agents, the script needs a PTY the renderer owns, so main
 * hands it off over the "app-command" channel. Best-effort: with no window
 * open there is nowhere to run it.
 */
export function runSetupScript(workspacePath: string, script: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  const command: AppCommand = { cmd: "run-setup-script", workspacePath, script };
  win.webContents.send("app-command", command);
}

/**
 * Tell the renderer its project list is stale. Mutations that originate in the
 * renderer fold the result straight into the store, but ones that arrive over
 * the control server (MCP, `manor` CLI) have no such return path — without this
 * the sidebar keeps showing the pre-mutation list until something else refetches.
 */
export function notifyProjectsChanged(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  win.webContents.send("projects-changed");
}

/** Render the launch prompt for an issue-backed workspace. */
function renderPrompt(
  template: string | undefined,
  ws: WorkspaceFromIssue,
): string {
  if (template) {
    return template
      .replace(/\{number\}/g, String(ws.number))
      .replace(/\{title\}/g, ws.title)
      .replace(/\{body\}/g, ws.body ?? "");
  }
  return `Work on GitHub issue #${ws.number}: ${ws.title}.\n\n${ws.body ?? ""}`;
}

/**
 * Read `?source=` off an issue route. Absent means GitHub, so existing callers
 * that predate Linear support keep working untouched.
 */
function parseSource(
  url: URL,
): { ok: true; source: IssueSource } | { ok: false; error: string } {
  const raw = url.searchParams.get("source");
  if (raw === null) return { ok: true, source: "github" };
  if (isIssueSource(raw)) return { ok: true, source: raw };
  return {
    ok: false,
    error: `Unknown source '${raw}'. Use 'github' or 'linear'.`,
  };
}

/**
 * Resolve the Linear manager and the project's team ids together. A missing
 * connection (503) and a project with no team associated (400) are different
 * failures — one is a capability gap, the other a configuration gap.
 */
function resolveLinear(
  linearManager: LinearManager | null,
  project: { linearAssociations?: LinearAssociation[] },
):
  | { ok: true; linear: LinearManager; teamIds: string[] }
  | { ok: false; status: number; error: string } {
  if (!linearManager || !linearManager.isConnected()) {
    return {
      ok: false,
      status: 503,
      error: "Linear is not connected. Connect Linear in Manor settings.",
    };
  }
  const associations = project.linearAssociations ?? [];
  if (associations.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "Project has no Linear team associated.",
    };
  }
  return {
    ok: true,
    linear: linearManager,
    teamIds: associations.map((a) => a.teamId),
  };
}

/**
 * Handle a Manor-control route. Returns true if the route matched (`/projects…`
 * or `/agents`) and a response was written, false if the caller should try
 * other routes.
 */
export async function handleControlRequest(
  deps: ControlDeps,
  method: string,
  url: URL,
  json: Json,
  readBody: ReadBody,
): Promise<boolean> {
  const segments = url.pathname.split("/").filter(Boolean);

  // ── POST /agents ──
  if (segments[0] === "agents") {
    if (segments.length !== 1 || method !== "POST") {
      json(405, { error: "Method not allowed" });
      return true;
    }
    const body = await readBody();
    const workspacePath = body.workspacePath;
    if (typeof workspacePath !== "string") {
      json(400, { error: "Missing 'workspacePath' string in request body" });
      return true;
    }
    const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
    const result = startAgent(workspacePath, prompt);
    json(result.ok ? 200 : 503, result);
    return true;
  }

  // ── GET /context?paneId=…&cwd=… ──
  // "Which project is calling me?" (ADR-150). Both params optional.
  if (segments[0] === "context") {
    if (method !== "GET") {
      json(405, { error: "Method not allowed" });
      return true;
    }
    const pm = deps.projectManager;
    if (!pm) {
      json(503, { error: "Project management is not available" });
      return true;
    }
    const paneId = url.searchParams.get("paneId");
    const cwd = url.searchParams.get("cwd");
    const projects = await pm.getProjects();

    let match: { project: ProjectInfo; workspace: WorkspaceInfo } | null = null;
    let resolvedBy: "paneId" | "cwd" | null = null;

    // Rung 1: the pane id is authoritative — it names the *caller's* pane, not
    // whatever the user happens to be looking at. But `layout.json` is written
    // on a 500ms debounce and serializes only the active workspace, so a pane
    // legitimately missing from it must fall through to cwd, never 404 here.
    // A corrupt or half-written file is the same fall-through, not a 500.
    if (paneId) {
      let layout: PersistedLayout | null;
      try {
        layout = deps.layoutPersistence?.load() ?? null;
      } catch {
        layout = null;
      }
      const workspacePath = layout
        ? findWorkspaceForPane(layout, paneId)
        : null;
      if (workspacePath) {
        match = matchProjectByPath(projects, workspacePath);
        if (match) resolvedBy = "paneId";
      }
    }

    // Rung 2: PTYs launch with `cwd = workspacePath`, so this holds unless the
    // agent was started after a `cd`.
    if (!match && cwd) {
      match = matchProjectByPath(projects, cwd);
      if (match) resolvedBy = "cwd";
    }

    // Rung 3: hand back the candidate list so the model can retry explicitly.
    if (!match || !resolvedBy) {
      json(404, {
        error:
          "Could not determine the current project. Pass projectId explicitly.",
        candidates: projects.map((p) => ({
          projectId: p.id,
          name: p.name,
          path: p.path,
        })),
      });
      return true;
    }

    // `sources` reports what can answer a query *right now*. A connected Linear
    // account with no team associated on this project cannot, so it is omitted
    // rather than advertised and then failing at call time.
    const sources: IssueSource[] = [];
    if (deps.githubManager) sources.push("github");
    if (
      deps.linearManager?.isConnected() &&
      (match.project.linearAssociations ?? []).length > 0
    ) {
      sources.push("linear");
    }

    json(200, {
      projectId: match.project.id,
      projectName: match.project.name,
      projectPath: match.project.path,
      workspacePath: match.workspace.path,
      branch: match.workspace.branch,
      isMain: match.workspace.isMain,
      sources,
      resolvedBy,
    });
    return true;
  }

  // ── /panes, /tabs (ADR-149) ──
  // These mutate layout state, not project state — no `notifyProjectsChanged()`.
  if (segments[0] === "panes") {
    // ── GET /panes ──
    if (segments.length === 1) {
      if (method !== "GET") {
        json(405, { error: "Method not allowed" });
        return true;
      }
      const result = await requestRenderer("list-panes");
      if (!result.ok) {
        json(rendererErrorStatus(result.error), { error: result.error });
        return true;
      }
      json(200, result.data);
      return true;
    }

    // ── POST /panes/split ──
    if (segments.length === 2 && segments[1] === "split") {
      if (method !== "POST") {
        json(405, { error: "Method not allowed" });
        return true;
      }
      const body = await readBody();
      if (body.direction !== "horizontal" && body.direction !== "vertical") {
        json(400, {
          error: "'direction' must be 'horizontal' or 'vertical'",
        });
        return true;
      }
      const result = await requestRenderer<{ paneId: string }>(
        "split-pane",
        body,
      );
      if (!result.ok) {
        json(rendererErrorStatus(result.error), { error: result.error });
        return true;
      }
      json(200, result.data);
      return true;
    }

    // ── POST /panes/:paneId/focus ──
    if (segments.length === 3 && segments[2] === "focus") {
      if (method !== "POST") {
        json(405, { error: "Method not allowed" });
        return true;
      }
      await readBody();
      const paneId = decodeURIComponent(segments[1]);
      const result = await requestRenderer<{ ok: true }>("focus-pane", {
        paneId,
      });
      if (!result.ok) {
        json(rendererErrorStatus(result.error), { error: result.error });
        return true;
      }
      json(200, result.data);
      return true;
    }

    // ── DELETE /panes/:paneId ──
    if (segments.length === 2) {
      if (method !== "DELETE") {
        json(405, { error: "Method not allowed" });
        return true;
      }
      await readBody();
      const paneId = decodeURIComponent(segments[1]);
      const result = await requestRenderer<{ ok: true }>("close-pane", {
        paneId,
      });
      if (!result.ok) {
        json(rendererErrorStatus(result.error), { error: result.error });
        return true;
      }
      json(200, result.data);
      return true;
    }

    json(404, { error: "Not found" });
    return true;
  }

  // ── POST /tabs ──
  if (segments[0] === "tabs") {
    if (segments.length !== 1 || method !== "POST") {
      json(405, { error: "Method not allowed" });
      return true;
    }
    const body = await readBody();
    if (body.contentType !== "terminal" && body.contentType !== "browser") {
      json(400, {
        error: "'contentType' must be 'terminal' or 'browser'",
      });
      return true;
    }
    if (body.contentType === "browser" && typeof body.url !== "string") {
      json(400, {
        error: "contentType 'browser' requires a 'url' string in request body",
      });
      return true;
    }
    const result = await requestRenderer<{ tabId: string; paneId: string }>(
      "new-tab",
      body,
    );
    if (!result.ok) {
      json(rendererErrorStatus(result.error), { error: result.error });
      return true;
    }
    json(200, result.data);
    return true;
  }

  if (segments[0] !== "projects") return false;

  const pm = deps.projectManager;
  if (!pm) {
    json(503, { error: "Project management is not available" });
    return true;
  }

  const projectId = segments[1] ? decodeURIComponent(segments[1]) : undefined;
  const sub = segments[2]; // "workspaces" | "issues" | undefined
  const subsub = segments[3]; // "batch" | undefined

  // ── /projects ──
  if (!projectId) {
    if (method === "GET") {
      json(200, await pm.getProjects());
      return true;
    }
    if (method === "POST") {
      const body = await readBody();
      const name = body.name;
      const projectPath = body.path;
      if (typeof name !== "string" || typeof projectPath !== "string") {
        json(400, { error: "Missing 'name' or 'path' string in request body" });
        return true;
      }
      const project = await pm.addProject(name, projectPath);
      notifyProjectsChanged();
      json(200, project);
      return true;
    }
    json(405, { error: "Method not allowed" });
    return true;
  }

  // Resolve the project once for the remaining routes.
  const projects = await pm.getProjects();
  const project = projects.find((p) => p.id === projectId);
  if (!project) {
    json(404, { error: "Project not found" });
    return true;
  }

  // ── GET /projects/:id/issues ──
  if (sub === "issues" && !subsub) {
    if (method !== "GET") {
      json(405, { error: "Method not allowed" });
      return true;
    }
    const parsed = parseSource(url);
    if (!parsed.ok) {
      json(400, { error: parsed.error });
      return true;
    }
    const filter =
      url.searchParams.get("filter") === "all" ? "all" : "assigned";
    const state = parseIssueState(url.searchParams.get("state"));
    const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50;

    if (parsed.source === "linear") {
      const target = resolveLinear(deps.linearManager, project);
      if (!target.ok) {
        json(target.status, { error: target.error });
        return true;
      }
      // Unlike GitHubManager, LinearManager throws on a bad/expired token.
      // Catch it here so it surfaces as a 502 rather than an unhandled
      // rejection in main.
      try {
        const opts = { stateTypes: linearStateTypes(state), limit };
        const issues =
          filter === "all"
            ? await target.linear.getAllIssues(target.teamIds, opts)
            : await target.linear.getMyIssues(target.teamIds, opts);
        json(200, issues.map(normalizeLinearIssue));
      } catch (err) {
        json(502, { error: String(err) });
      }
      return true;
    }

    const github = deps.githubManager;
    if (!github) {
      json(503, { error: "GitHub is not available" });
      return true;
    }
    const issues =
      filter === "all"
        ? await github.getAllIssues(project.path, limit, state)
        : await github.getMyIssues(project.path, limit, state);
    json(200, issues.map(normalizeGitHubIssue));
    return true;
  }

  // ── GET /projects/:id/issues/:issueRef ──
  if (sub === "issues" && subsub) {
    if (method !== "GET") {
      json(405, { error: "Method not allowed" });
      return true;
    }
    const parsed = parseSource(url);
    if (!parsed.ok) {
      json(400, { error: parsed.error });
      return true;
    }
    const issueRef = decodeURIComponent(subsub);

    if (parsed.source === "linear") {
      const target = resolveLinear(deps.linearManager, project);
      if (!target.ok) {
        json(target.status, { error: target.error });
        return true;
      }
      // Linear's `issue(id:)` resolves both a UUID and a human identifier
      // ("ENG-123"), so the ref from the listing round-trips verbatim.
      try {
        const detail = await target.linear.getIssueDetail(issueRef);
        json(200, normalizeLinearIssueDetail(detail));
      } catch (err) {
        json(502, { error: String(err) });
      }
      return true;
    }

    const github = deps.githubManager;
    if (!github) {
      json(503, { error: "GitHub is not available" });
      return true;
    }
    const number = Number.parseInt(issueRef, 10);
    if (!Number.isFinite(number) || number <= 0) {
      json(400, { error: "GitHub issue refs must be numeric." });
      return true;
    }
    const detail = await github.getIssueDetail(project.path, number);
    json(200, normalizeGitHubIssueDetail(detail));
    return true;
  }

  // ── POST /projects/:id/workspaces/batch ──
  if (sub === "workspaces" && subsub === "batch") {
    if (method !== "POST") {
      json(405, { error: "Method not allowed" });
      return true;
    }
    // Batch creation is GitHub-only: the `issues: number[]` schema and the
    // "Work on GitHub issue #…" prompt template both assume numeric refs.
    // Reject a Linear caller loudly rather than silently treating it as GitHub.
    const parsed = parseSource(url);
    if (!parsed.ok) {
      json(400, { error: parsed.error });
      return true;
    }
    if (parsed.source === "linear") {
      json(400, { error: "batch_create_workspaces supports GitHub issues only." });
      return true;
    }
    const github = deps.githubManager;
    if (!github) {
      json(503, {
        error: "GitHub and project management are required for batch creation",
      });
      return true;
    }

    const body = await readBody();
    const rawIssues = body.issues;
    if (
      !Array.isArray(rawIssues) ||
      rawIssues.length === 0 ||
      !rawIssues.every((n) => typeof n === "number")
    ) {
      json(400, {
        error: "Missing non-empty 'issues' array of numbers in request body",
      });
      return true;
    }
    const numbers = rawIssues as number[];
    const baseBranch =
      typeof body.baseBranch === "string" ? body.baseBranch : undefined;
    const assign = body.assign === true;
    const launch = body.startAgent !== false;
    const promptTemplate =
      typeof body.promptTemplate === "string" ? body.promptTemplate : undefined;

    // 1. Fetch issue details in parallel — independent gh reads.
    const details = await Promise.all(
      numbers.map(async (number) => {
        try {
          const detail = await github.getIssueDetail(project.path, number);
          return { number, detail };
        } catch (err) {
          return { number, error: String(err) };
        }
      }),
    );

    // 2. Create worktrees sequentially in the canonical layer.
    const seeds: IssueSeed[] = details.flatMap((d) =>
      "detail" in d
        ? [
            {
              number: d.number,
              title: d.detail.title,
              url: d.detail.url,
              body: d.detail.body,
            },
          ]
        : [],
    );
    const created = await pm.createWorkspacesFromIssues(
      projectId,
      seeds,
      baseBranch,
    );
    const createdByNumber = new Map(created.map((c) => [c.number, c]));
    notifyProjectsChanged();

    // 3. Assign + launch per successful workspace.
    const results: BatchResultEntry[] = [];
    for (const d of details) {
      if ("error" in d) {
        results.push({ number: d.number, title: "", started: false, error: d.error });
        continue;
      }
      const ws = createdByNumber.get(d.number);
      const entry: BatchResultEntry = {
        number: d.number,
        title: ws?.title ?? d.detail.title,
        workspacePath: ws?.worktreePath,
        started: false,
      };
      if (!ws || ws.error) {
        entry.error = ws?.error ?? "Workspace was not created";
        results.push(entry);
        continue;
      }
      if (assign) {
        try {
          await github.assignIssue(project.path, d.number);
        } catch {
          // Assignment is best-effort; the workspace already exists.
        }
      }
      if (ws.worktreePath && launch) {
        const result = startAgent(ws.worktreePath, renderPrompt(promptTemplate, ws));
        entry.started = result.ok;
        if (!result.ok) entry.error = result.error;
      }
      results.push(entry);
    }
    json(200, { results });
    return true;
  }

  // ── /projects/:id/workspaces ──
  if (sub === "workspaces" && !subsub) {
    if (method === "GET") {
      json(200, project.workspaces);
      return true;
    }
    if (method === "POST") {
      const body = await readBody();
      const branch = typeof body.branch === "string" ? body.branch : undefined;
      // Either field alone is enough — each falls back to the other, matching
      // the new-workspace dialog where the branch tracks the name.
      const name = typeof body.name === "string" ? body.name : branch;
      if (typeof name !== "string" || !name.trim()) {
        json(400, { error: "Missing 'name' or 'branch' string in request body" });
        return true;
      }
      const baseBranch =
        typeof body.baseBranch === "string" ? body.baseBranch : undefined;
      const useExistingBranch =
        typeof body.useExistingBranch === "boolean"
          ? body.useExistingBranch
          : undefined;
      const before = new Set(project.workspaces.map((ws) => ws.path));
      const updated = await pm.createWorktree(
        projectId,
        name,
        branch,
        undefined,
        baseBranch,
        useExistingBranch,
      );
      notifyProjectsChanged();
      // The UI path runs `worktreeStartScript` from the renderer (it needs a
      // PTY), so main round-trips the request the same way start-agent does.
      const created = updated?.workspaces.find((ws) => !before.has(ws.path));
      if (created && updated?.worktreeStartScript) {
        runSetupScript(created.path, updated.worktreeStartScript);
      }
      json(200, updated);
      return true;
    }
    if (method === "DELETE") {
      const body = await readBody();
      const worktreePath = body.worktreePath;
      if (typeof worktreePath !== "string") {
        json(400, { error: "Missing 'worktreePath' string in request body" });
        return true;
      }
      const deleteBranch =
        typeof body.deleteBranch === "boolean" ? body.deleteBranch : undefined;
      await pm.removeWorktree(projectId, worktreePath, deleteBranch);
      notifyProjectsChanged();
      json(200, { ok: true });
      return true;
    }
    json(405, { error: "Method not allowed" });
    return true;
  }

  // ── /projects/:id ──
  if (!sub) {
    if (method === "GET") {
      json(200, project);
      return true;
    }
    json(405, { error: "Method not allowed" });
    return true;
  }

  json(404, { error: "Not found" });
  return true;
}
