/**
 * Manor-control HTTP routes — project/workspace management, GitHub issue
 * listing, batch issue→workspace fan-out, and agent launching.
 *
 * Extracted from WebviewServer (which is about webview inspection) so each
 * module stays cohesive. Consumed by webview-server.ts, which owns the HTTP
 * listener and delegates any `/projects…` or `/agents` request here.
 */

import { BrowserWindow } from "electron";
import type { ProjectManager, IssueSeed, WorkspaceFromIssue } from "./persistence";
import type { GitHubManager } from "./github";
import type { LinearManager, LinearAssociation } from "./linear";
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
}

/** Payload of the main→renderer "app-command" channel. */
export interface AppCommand {
  cmd: string;
  workspacePath?: string;
  prompt?: string;
  script?: string;
}

type Json = (status: number, body: unknown) => void;
type ReadBody = () => Promise<Record<string, unknown>>;

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
      json(200, await pm.addProject(name, projectPath));
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
