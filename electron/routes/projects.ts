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
  LinkedIssue,
  ProjectUpdatableFields,
  ProjectGroupInfo,
} from "../persistence";
import { LOCAL_HOST_ID } from "../backend/types";
import { callerMaySee, OWN_HOST_ONLY } from "./caller-host";
import { isIssueSource } from "../issue-sources";
import { ghRepoOf } from "../../src/lib/gh-repo";
import {
  notifyProjectsChanged,
  runSetupScript,
  startAgent,
} from "../renderer-bridge";
import type { Json, Route, RouteContext } from "./types";

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
/** 404 unless `folderId` names one of the project's folders. */
export function requireFolder(
  project: ProjectInfo,
  folderId: string,
  json: Json,
): boolean {
  if (project.folders.some((f) => f.id === folderId)) return true;
  json(404, { error: `Folder not found: ${folderId}` });
  return false;
}

/** 404 unless `workspacePath` is one of the project's workspaces. */
export function requireWorkspace(
  project: ProjectInfo,
  workspacePath: string,
  json: Json,
): boolean {
  if (project.workspaces.some((w) => w.path === workspacePath)) return true;
  json(404, { error: `Workspace not found: ${workspacePath}` });
  return false;
}

export function withProject(
  handler: (
    ctx: RouteContext,
    pm: ProjectManager,
    project: ProjectInfo,
    projects: ProjectInfo[],
  ) => Promise<void>,
): Route["handler"] {
  return withProjectManager(async (ctx, pm) => {
    const projects = await pm.getProjects();
    const project = projects.find((p) => p.id === ctx.params.projectId);
    if (!project) {
      ctx.json(404, { error: "Project not found" });
      return;
    }
    await handler(ctx, pm, project, projects);
  });
}

// ── Linked-project groups on the control surface (ADR-192 ticket 8) ──

/** One member of a linked group as `GET /projects` lists it. */
interface GroupMemberListing {
  projectId: string;
  name: string;
  hostId: string;
  /** The host's label: its ssh target, or "this Mac". */
  host: string;
}

/** A project's group summary, widened with each member's host for the CLI. */
interface GroupListing extends ProjectGroupInfo {
  members: GroupMemberListing[];
}

/** A project as `GET /projects` lists it: with its host's label and group. */
type ProjectListing = ProjectInfo & {
  host: string;
  group: GroupListing | null;
};

/** `project` with its host's label, the way every listing names hosts. */
function withHostLabel(
  pm: ProjectManager,
  project: ProjectInfo,
): ProjectInfo & { host: string } {
  return { ...project, host: pm.hostLabel(project.hostId) };
}

/**
 * `projects` with each group's `members` spelled out: id, name and host.
 * A relayed caller (ADR-189) sees only its own host (`callerMaySee`), so
 * its groups list only its own host's members, and a last-used host that
 * isn't its own reads as null.
 */
function withGroupMembers(
  pm: ProjectManager,
  projects: ProjectInfo[],
  callerHostId: string | undefined,
): ProjectListing[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return projects.map((project) => {
    const listed = withHostLabel(pm, project);
    const group = project.group;
    if (!group) return { ...listed, group: null };
    const members = group.memberIds.flatMap((id): GroupMemberListing[] => {
      const member = byId.get(id);
      if (!member || !callerMaySee(callerHostId, member.hostId)) return [];
      return [
        {
          projectId: member.id,
          name: member.name,
          hostId: member.hostId,
          host: pm.hostLabel(member.hostId),
        },
      ];
    });
    return {
      ...listed,
      group: {
        id: group.id,
        name: group.name,
        memberIds: members.map((m) => m.projectId),
        lastUsedHostId: callerMaySee(callerHostId, group.lastUsedHostId)
          ? group.lastUsedHostId
          : null,
        members,
      },
    };
  });
}

type HostArg =
  | { ok: true; hostId: string }
  | { ok: false; reason: "unknown" | "ambiguous" };

/**
 * The hostId a `host` argument names: a host id (`local` for this machine),
 * a remote host's ssh target, or a host's label as listings show it.
 * Ambiguous when it names more than one host — two hosts sharing a target,
 * or one's id being another's target.
 */
function resolveHostArg(pm: ProjectManager, arg: string): HostArg {
  const hosts = [
    // The local label ("this Mac") is what listings show, so it names local too.
    { hostId: LOCAL_HOST_ID, target: pm.hostLabel(LOCAL_HOST_ID) as string | undefined },
    ...pm.getHosts().map(({ hostId, spec }) => ({ hostId, target: spec.target })),
  ];
  const matches = new Set(
    hosts
      .filter((h) => h.hostId === arg || h.target === arg)
      .map((h) => h.hostId),
  );
  if (matches.size === 0) return { ok: false, reason: "unknown" };
  if (matches.size > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, hostId: [...matches][0] };
}

interface WorkspaceTargetRequest {
  /** The project named in the path. */
  project: ProjectInfo;
  /** Every project, to find the group's members among. */
  projects: ProjectInfo[];
  /** The `host` argument, if the caller passed one. */
  host?: string;
  /** Set when the request was relayed from a remote host (ADR-189). */
  callerHostId?: string;
}

type WorkspaceTargetResult =
  | { ok: true; project: ProjectInfo }
  | { ok: false; status: number; error: string };

/**
 * Which project a create-workspace request lands in. An unlinked project is
 * its own and only target. For a linked one, `host` picks that host's
 * member; without it, the caller's own host (a relayed remote CLI), then the
 * group's last-used host, then the project named in the path.
 */
function workspaceTarget(
  pm: ProjectManager,
  { project, projects, host, callerHostId }: WorkspaceTargetRequest,
): WorkspaceTargetResult {
  const members = (project.group?.memberIds ?? [project.id])
    .map((id) => projects.find((p) => p.id === id))
    .filter(
      (p): p is ProjectInfo =>
        p !== undefined && callerMaySee(callerHostId, p.hostId),
    );
  const onHost = (hostId: string | null | undefined) =>
    hostId ? members.find((m) => m.hostId === hostId) : undefined;

  if (host === undefined) {
    const target =
      onHost(callerHostId) ??
      onHost(project.group?.lastUsedHostId) ??
      project;
    return { ok: true, project: target };
  }

  const resolved = resolveHostArg(pm, host);
  // A relayed caller must not learn which other hosts exist, so every host
  // but its own — unknown, ambiguous or real — gets the same answer.
  if (
    callerHostId &&
    !(resolved.ok && callerMaySee(callerHostId, resolved.hostId))
  ) {
    return { ok: false, status: 403, error: OWN_HOST_ONLY };
  }
  if (!resolved.ok) {
    return {
      ok: false,
      status: 400,
      error:
        resolved.reason === "unknown"
          ? `Unknown host '${host}'.`
          : `'${host}' names more than one host. Pass the host id instead.`,
    };
  }
  const target = onHost(resolved.hostId);
  if (target) return { ok: true, project: target };
  const label = (hostId: string) => pm.hostLabel(hostId);
  const wanted = label(resolved.hostId);
  const error = project.group
    ? `Group "${project.group.name}" has no project on ${wanted}. Available hosts: ${members.map((m) => label(m.hostId)).join(", ")}.`
    : `Project "${project.name}" is on ${label(project.hostId)}, not ${wanted}, and isn't linked with a project there.`;
  return { ok: false, status: 400, error };
}

export interface BatchResultEntry {
  number: number;
  title: string;
  workspacePath?: string;
  started: boolean;
  /** Pane the launched agent occupies. Present only when `started` is true. */
  paneId?: string;
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

/** Validate a `LinkedIssue` payload off a request body, or `null` if malformed. */
function parseLinkedIssue(value: unknown): LinkedIssue | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    typeof v.identifier !== "string" ||
    typeof v.title !== "string" ||
    typeof v.url !== "string"
  ) {
    return null;
  }
  return { id: v.id, identifier: v.identifier, title: v.title, url: v.url };
}

/**
 * `ProjectUpdatableFields`' keys, kept in sync by the `satisfies` check —
 * `POST /projects/:projectId/update` copies only these off the body, so an
 * unrelated field (or a typo) is silently ignored rather than smuggled into
 * `Object.assign`.
 */
const UPDATABLE_PROJECT_FIELDS = [
  "name",
  "defaultRunCommand",
  "worktreePath",
  "worktreeStartScript",
  "worktreeTeardownScript",
  "linearAssociations",
  "color",
  "agentCommand",
  "commands",
  "themeName",
  "setupComplete",
  "portlessEnabled",
] as const satisfies readonly (keyof ProjectUpdatableFields)[];

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
        const detail = await github.getIssueDetail(ghRepoOf(project), number);
        return { number, detail };
      } catch (err) {
        return { number, error: String(err) };
      }
    }),
  );

  // 2. Create worktrees sequentially in the canonical layer.
  const seeds: IssueSeed[] = details.flatMap((d) =>
    "detail" in d && d.detail
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
  // goes. This runs sequentially, not fanned out through `Promise.all` like
  // steps 1 and 2 above: each launch is a correlated round-trip to the
  // renderer (ADR-176), and firing N of those concurrently would be both
  // needless load on the renderer and harder to reason about than N agents
  // starting one after another. A `for` loop pushing into `results` keeps
  // input order without relying on `Promise.all` to preserve it.
  const results: BatchResultEntry[] = [];
  for (const d of details) {
    if ("error" in d) {
      results.push({
        number: d.number,
        title: "",
        started: false,
        error: d.error,
      });
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
        await github.assignIssue(ghRepoOf(project), d.number);
      } catch (err) {
        entry.assignError = String(err);
      }
    }
    if (ws.worktreePath && launch) {
      const result = await startAgent(
        ws.worktreePath,
        renderPrompt(promptTemplate, ws),
        undefined,
        project.hostId,
      );
      entry.started = result.ok;
      if (result.ok) {
        entry.paneId = result.data.paneId;
      } else {
        entry.launchError = result.error;
      }
    }
    results.push(entry);
  }
  json(200, { results });
}

export const projectRoutes: Route[] = [
  {
    method: "GET",
    path: "/projects",
    handler: withProjectManager(async ({ deps, json }, pm) => {
      json(
        200,
        withGroupMembers(pm, await pm.getProjects(), deps.callerHostId),
      );
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
    handler: withProject(async ({ json }, pm, project) => {
      json(200, withHostLabel(pm, project));
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
    handler: withProject(async ({ deps, json, readBody }, pm, named, projects) => {
      const body = await readBody();
      if (body.host !== undefined && typeof body.host !== "string") {
        json(400, { error: "'host' must be a string" });
        return;
      }
      const host = typeof body.host === "string" && body.host ? body.host : undefined;
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
      const target = workspaceTarget(pm, {
        project: named,
        projects,
        host,
        callerHostId: deps.callerHostId,
      });
      if (!target.ok) {
        json(target.status, { error: target.error });
        return;
      }
      const project = target.project;
      const before = new Set(project.workspaces.map((ws) => ws.path));
      const updated = await pm.createWorktree(
        project.id,
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
        runSetupScript(created.path, updated.worktreeStartScript, updated.hostId);
      }
      json(200, updated && withHostLabel(pm, updated));
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

  {
    method: "POST",
    path: "/projects/:projectId/workspaces/rename",
    handler: withProject(async ({ params, json, readBody }, pm, project) => {
      const body = await readBody();
      const workspacePath = body.workspacePath;
      const name = body.name;
      if (typeof workspacePath !== "string" || typeof name !== "string") {
        json(400, {
          error: "Missing 'workspacePath' or 'name' string in request body",
        });
        return;
      }
      if (!requireWorkspace(project, workspacePath, json)) return;
      pm.renameWorkspace(params.projectId, workspacePath, name);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/workspaces/hidden",
    handler: withProject(async ({ params, json, readBody }, pm, project) => {
      const body = await readBody();
      const workspacePath = body.workspacePath;
      const hidden = body.hidden;
      if (typeof workspacePath !== "string" || typeof hidden !== "boolean") {
        json(400, {
          error:
            "Missing 'workspacePath' string or 'hidden' boolean in request body",
        });
        return;
      }
      if (!requireWorkspace(project, workspacePath, json)) return;
      pm.setWorkspaceHidden(params.projectId, workspacePath, hidden);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/workspaces/reorder",
    handler: withProject(async ({ params, json, readBody }, pm) => {
      const body = await readBody();
      const orderedKeys = body.orderedKeys;
      if (
        !Array.isArray(orderedKeys) ||
        !orderedKeys.every((k) => typeof k === "string")
      ) {
        json(400, {
          error: "Missing 'orderedKeys' array of strings in request body",
        });
        return;
      }
      pm.reorderWorkspaces(params.projectId, orderedKeys);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/workspaces/convert-main",
    handler: withProject(async ({ params, json, readBody }, pm) => {
      const body = await readBody();
      const name = body.name;
      if (typeof name !== "string" || !name.trim()) {
        json(400, { error: "Missing 'name' string in request body" });
        return;
      }
      const updated = await pm.convertMainToWorktree(params.projectId, name);
      if (!updated) {
        json(404, { error: "Project not found" });
        return;
      }
      notifyProjectsChanged();
      json(200, updated);
    }),
  },

  {
    method: "GET",
    path: "/projects/:projectId/workspaces/quick-merge",
    handler: withProject(async ({ params, url, json }, pm) => {
      const workspacePath = url.searchParams.get("workspacePath");
      if (!workspacePath) {
        json(400, { error: "Missing 'workspacePath' query parameter" });
        return;
      }
      json(200, await pm.canQuickMerge(params.projectId, workspacePath));
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/workspaces/quick-merge",
    handler: withProject(async ({ params, json, readBody }, pm) => {
      const body = await readBody();
      const workspacePath = body.workspacePath;
      if (typeof workspacePath !== "string") {
        json(400, { error: "Missing 'workspacePath' string in request body" });
        return;
      }
      await pm.quickMergeWorktree(params.projectId, workspacePath);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "GET",
    path: "/projects/:projectId/workspaces/issues",
    handler: withProject(async ({ params, url, json }, pm) => {
      const workspacePath = url.searchParams.get("workspacePath");
      if (!workspacePath) {
        json(400, { error: "Missing 'workspacePath' query parameter" });
        return;
      }
      json(200, pm.getWorkspaceIssues(params.projectId, workspacePath));
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/workspaces/issues",
    handler: withProject(async ({ params, json, readBody }, pm) => {
      const body = await readBody();
      const workspacePath = body.workspacePath;
      if (typeof workspacePath !== "string") {
        json(400, { error: "Missing 'workspacePath' string in request body" });
        return;
      }
      const issue = parseLinkedIssue(body.issue);
      if (!issue) {
        json(400, {
          error:
            "Missing 'issue' object with 'id', 'identifier', 'title', and 'url' strings",
        });
        return;
      }
      pm.linkIssueToWorkspace(params.projectId, workspacePath, issue);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "DELETE",
    path: "/projects/:projectId/workspaces/issues",
    handler: withProject(async ({ params, json, readBody }, pm) => {
      const body = await readBody();
      const workspacePath = body.workspacePath;
      const issueId = body.issueId;
      if (typeof workspacePath !== "string" || typeof issueId !== "string") {
        json(400, {
          error: "Missing 'workspacePath' or 'issueId' string in request body",
        });
        return;
      }
      pm.unlinkIssueFromWorkspace(params.projectId, workspacePath, issueId);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "GET",
    path: "/projects/:projectId/branches",
    handler: withProject(async ({ params, url, json }, pm) => {
      const scope = url.searchParams.get("scope") ?? "local";
      if (scope !== "local" && scope !== "remote") {
        json(400, { error: "Query param 'scope' must be 'local' or 'remote'" });
        return;
      }
      const branches =
        scope === "local"
          ? await pm.listLocalBranches(params.projectId)
          : await pm.listRemoteBranches(params.projectId);
      json(200, branches);
    }),
  },

  {
    method: "POST",
    path: "/projects/:projectId/update",
    handler: withProject(async ({ params, json, readBody }, pm) => {
      const body = await readBody();
      const updates: ProjectUpdatableFields = {};
      for (const key of UPDATABLE_PROJECT_FIELDS) {
        if (key in body) {
          (updates as Record<string, unknown>)[key] = body[key];
        }
      }
      const updated = await pm.updateProject(params.projectId, updates);
      if (!updated) {
        json(404, { error: "Project not found" });
        return;
      }
      notifyProjectsChanged();
      json(200, updated);
    }),
  },

  {
    method: "DELETE",
    path: "/projects/:projectId",
    handler: withProject(async ({ params, json, readBody }, pm) => {
      await readBody();
      pm.removeProject(params.projectId);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "POST",
    path: "/projects/reorder",
    handler: withProjectManager(async ({ json, readBody }, pm) => {
      const body = await readBody();
      const orderedIds = body.orderedIds;
      if (
        !Array.isArray(orderedIds) ||
        !orderedIds.every((id) => typeof id === "string")
      ) {
        json(400, {
          error: "Missing 'orderedIds' array of strings in request body",
        });
        return;
      }
      pm.reorderProjects(orderedIds);
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },

  {
    method: "POST",
    path: "/projects/resync-default-branches",
    handler: withProjectManager(async ({ json, readBody }, pm) => {
      await readBody();
      await pm.resyncDefaultBranches();
      notifyProjectsChanged();
      json(200, { ok: true });
    }),
  },
];
