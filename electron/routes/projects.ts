/**
 * `/projects`, `/projects/:projectId`, its `/workspaces` collection, and the
 * `/workspaces/batch` issue→worktree fan-out.
 *
 * Also home to `withProject`, the 503/404 preamble the project-scoped routes
 * (here and in `issues.ts`) share.
 */

import type {
  ProjectManager,
  ProjectInfo,
  IssueSeed,
  WorkspaceFromIssue,
} from "../persistence";
import { isIssueSource } from "../issue-sources";
import {
  notifyProjectsChanged,
  runSetupScript,
  startAgent,
} from "../renderer-bridge";
import type { Route, RouteContext } from "./types";

/**
 * Guard the routes that need a ProjectManager but no particular project —
 * `GET /projects` and `POST /projects`, which must not run a project lookup.
 */
function withProjectManager(
  handler: (ctx: RouteContext, pm: ProjectManager) => Promise<void>,
): Route["handler"] {
  return async (ctx) => {
    const pm = ctx.deps.projectManager;
    if (!pm) {
      ctx.json(503, { error: "Project management is not available" });
      return;
    }
    await handler(ctx, pm);
  };
}

/**
 * The preamble every `/projects/:projectId/…` route ran inline: no manager is a
 * capability gap (503), an id that resolves to nothing is the caller's mistake
 * (404). Resolving the project here means it is fetched exactly once per
 * request, as before.
 */
export function withProject(
  handler: (
    ctx: RouteContext,
    pm: ProjectManager,
    project: ProjectInfo,
  ) => Promise<void>,
): Route["handler"] {
  return withProjectManager(async (ctx, pm) => {
    const projects = await pm.getProjects();
    const project = projects.find((p) => p.id === ctx.params.projectId);
    if (!project) {
      ctx.json(404, { error: "Project not found" });
      return;
    }
    await handler(ctx, pm, project);
  });
}

export interface BatchResultEntry {
  number: number;
  title: string;
  workspacePath?: string;
  started: boolean;
  /** No workspace was created at all — the issue fetch or worktree create failed. */
  error?: string;
  /**
   * The workspace was created but the assignment write failed. Distinct from
   * `error`: a workspace with `assignError` still gets `started: true` if
   * launch succeeded; it just isn't assigned.
   */
  assignError?: string;
  /**
   * The workspace was created but the agent failed to launch in it. Distinct
   * from `error`: a workspace with `launchError` exists on disk (has
   * `workspacePath`); `started` stays `false`.
   */
  launchError?: string;
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
 * `POST /projects/:projectId/workspaces/batch` — fan a batch of GitHub issue
 * numbers out into one worktree each, optionally assigning and launching an
 * agent in every one.
 */
async function batchCreateWorkspaces(
  { deps, params, json, readBody }: RouteContext,
  pm: ProjectManager,
  project: ProjectInfo,
): Promise<void> {
  // Batch creation is GitHub-only: the `issues: number[]` schema and the
  // "Work on GitHub issue #…" prompt template both assume numeric refs.
  // Reject a Linear caller loudly rather than silently treating it as GitHub.
  // `source` travels in the JSON body, like every other param on this route
  // (unlike the issue routes, which read it off the query string) — read the
  // body first so we can validate it before the 503 githubManager check, so
  // a Linear caller gets the accurate 400 rather than a misleading 503 on a
  // machine where `gh` happens to be unavailable.
  const body = await readBody();
  const source = body.source ?? "github";
  if (!isIssueSource(source)) {
    json(400, {
      error: `Unknown source '${String(source)}'. Use 'github' or 'linear'.`,
    });
    return;
  }
  if (source === "linear") {
    json(400, {
      error: "batch_create_workspaces supports GitHub issues only.",
    });
    return;
  }
  const github = deps.githubManager;
  if (!github) {
    json(503, {
      error: "GitHub and project management are required for batch creation",
    });
    return;
  }

  const rawIssues = body.issues;
  if (
    !Array.isArray(rawIssues) ||
    rawIssues.length === 0 ||
    !rawIssues.every((n) => typeof n === "number")
  ) {
    json(400, {
      error: "Missing non-empty 'issues' array of numbers in request body",
    });
    return;
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
    params.projectId,
    seeds,
    baseBranch,
  );
  const createdByNumber = new Map(created.map((c) => [c.number, c]));
  notifyProjectsChanged();

  // 3. Resolve each issue to a result entry, assigning and launching as it
  // goes. `details.map` preserves order in `results` regardless of which
  // issues need assignment or launch, and each callback's own `await`s run
  // concurrently across issues — `startAgent` itself is a synchronous
  // dispatch, so calling it inline costs nothing.
  const results: BatchResultEntry[] = await Promise.all(
    details.map(async (d) => {
      if ("error" in d) {
        return { number: d.number, title: "", started: false, error: d.error };
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
        return entry;
      }
      if (assign) {
        try {
          await github.assignIssue(project.path, d.number);
        } catch (err) {
          entry.assignError = String(err);
        }
      }
      if (ws.worktreePath && launch) {
        const result = startAgent(
          ws.worktreePath,
          renderPrompt(promptTemplate, ws),
        );
        entry.started = result.ok;
        if (!result.ok) entry.launchError = result.error;
      }
      return entry;
    }),
  );
  json(200, { results });
}

export const projectRoutes: Route[] = [
  {
    method: "GET",
    path: "/projects",
    handler: withProjectManager(async ({ json }, pm) => {
      json(200, await pm.getProjects());
    }),
  },

  {
    method: "POST",
    path: "/projects",
    handler: withProjectManager(async ({ json, readBody }, pm) => {
      const body = await readBody();
      const name = body.name;
      const projectPath = body.path;
      if (typeof name !== "string" || typeof projectPath !== "string") {
        json(400, { error: "Missing 'name' or 'path' string in request body" });
        return;
      }
      const project = await pm.addProject(name, projectPath);
      notifyProjectsChanged();
      json(200, project);
    }),
  },

  {
    method: "GET",
    path: "/projects/:projectId",
    handler: withProject(async ({ json }, _pm, project) => {
      json(200, project);
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/workspaces/batch",
    handler: withProject(batchCreateWorkspaces),
  },

  {
    method: "GET",
    path: "/projects/:projectId/workspaces",
    handler: withProject(async ({ json }, _pm, project) => {
      json(200, project.workspaces);
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/workspaces",
    handler: withProject(async ({ params, json, readBody }, pm, project) => {
      const body = await readBody();
      const branch = typeof body.branch === "string" ? body.branch : undefined;
      // Either field alone is enough — each falls back to the other, matching
      // the new-workspace dialog where the branch tracks the name.
      const name = typeof body.name === "string" ? body.name : branch;
      if (typeof name !== "string" || !name.trim()) {
        json(400, {
          error: "Missing 'name' or 'branch' string in request body",
        });
        return;
      }
      const baseBranch =
        typeof body.baseBranch === "string" ? body.baseBranch : undefined;
      const useExistingBranch =
        typeof body.useExistingBranch === "boolean"
          ? body.useExistingBranch
          : undefined;
      const before = new Set(project.workspaces.map((ws) => ws.path));
      const updated = await pm.createWorktree(
        params.projectId,
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
    }),
  },

  {
    method: "DELETE",
    path: "/projects/:projectId/workspaces",
    handler: withProject(async ({ params, json, readBody }, pm) => {
      const body = await readBody();
      const worktreePath = body.worktreePath;
      if (typeof worktreePath !== "string") {
        json(400, { error: "Missing 'worktreePath' string in request body" });
        return;
      }
      const deleteBranch =
        typeof body.deleteBranch === "boolean" ? body.deleteBranch : undefined;
      await pm.removeWorktree(params.projectId, worktreePath, deleteBranch);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },
];
