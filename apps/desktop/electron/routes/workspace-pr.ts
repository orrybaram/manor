/**
 * `/projects/:projectId/workspaces/pr/*` — the PR card's actions for the
 * `manor` CLI and MCP (`merge_pr`, `fix_pr_checks`, `address_pr_comments`):
 * merge the workspace branch's PR, or brief an agent on its failing checks
 * or unresolved review threads.
 *
 * Each takes the workspace and finds its branch's PR itself, so a caller
 * names a workspace, never a PR number it would have to look up first. `gh`
 * runs in the project's root checkout (`ghRepoOf`), as the card's does.
 *
 * A project on an adopted host is that host's: `withProject` sends the
 * request there whole, so its own `gh`, agents and layout answer it.
 *
 * GitHub is an upstream service: a `gh` failure is a `502` carrying `gh`'s
 * own reason, matching `./integrations.ts`.
 */

import type { ProjectInfo, WorkspaceInfo } from "../persistence";
import type { GhRepo } from "../../src/lib/gh-repo";
import { ghRepoOf } from "../../src/lib/gh-repo";
import type {
  PrAgentTask,
  PrInfo,
  PrMergeMethod,
  PrMergeOptions,
  PrMergeOutcome,
} from "../../src/lib/pr-info";
import { pickPromptTarget } from "../../src/lib/prompt-target";
import { chatSend } from "../bridge/handlers/chat";
import { localCtx } from "../bridge/method";
import { startAgentInWorkspace } from "./agents";
import { requireWorkspace, withProject } from "./projects";
import type { RouteContext, ServerRoute, ServerRouteDeps } from "./types";

type Ctx = RouteContext<ServerRouteDeps>;

const MERGE_METHODS: readonly PrMergeMethod[] = ["squash", "merge", "rebase"];

function isMergeMethod(value: unknown): value is PrMergeMethod {
  return MERGE_METHODS.includes(value as PrMergeMethod);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An optional boolean body field; `undefined` when absent, null when not a boolean. */
function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined | null {
  const value = body[key];
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

interface WorkspacePr {
  workspace: WorkspaceInfo;
  repo: GhRepo;
  pr: PrInfo;
}

/**
 * The open PR of the workspace `body.workspacePath` names, or null once the
 * reason it has none is answered: no such workspace (404), a detached one
 * (409), no PR for its branch (404), or one already merged or closed (409).
 */
async function workspacePr(
  { deps, json }: Ctx,
  project: ProjectInfo,
  body: Record<string, unknown>,
): Promise<WorkspacePr | null> {
  const workspacePath = body.workspacePath;
  if (typeof workspacePath !== "string" || !workspacePath) {
    json(400, { error: "Missing 'workspacePath' string in request body" });
    return null;
  }
  if (!requireWorkspace(project, workspacePath, json)) return null;
  const workspace = project.workspaces.find((w) => w.path === workspacePath)!;
  if (!workspace.branch) {
    json(409, { error: `Workspace ${workspacePath} has no branch checked out` });
    return null;
  }
  const repo = ghRepoOf(project);
  let pr: PrInfo | null;
  try {
    pr = await deps.githubManager.getPrForBranch(repo, workspace.branch);
  } catch (err) {
    json(502, { error: errorMessage(err) });
    return null;
  }
  if (!pr) {
    json(404, { error: `No PR found for branch ${workspace.branch}` });
    return null;
  }
  if (pr.state.toLowerCase() !== "open") {
    json(409, { error: `PR #${pr.number} is ${pr.state.toLowerCase()}, not open` });
    return null;
  }
  return { workspace, repo, pr };
}

/** What `POST …/pr/merge` answers. */
interface MergePrResult {
  number: number;
  url: string;
  /** The method asked for; a merge queue picks its own. */
  method: PrMergeMethod;
  /** Merged now, added to the base branch's merge queue, or auto-merge armed. */
  outcome: PrMergeOutcome;
  /** The workspace removed after the merge, or null. */
  removedWorkspace: string | null;
  /** Why removing it failed, the merge having happened. */
  removeError?: string;
}

/**
 * Merge the workspace's PR, arm auto-merge, or — on a base branch with a
 * merge queue — queue it. The method defaults to the repo's own default,
 * and one the repo doesn't allow is refused before `gh` is asked, as is
 * auto-merge on a repo that has it off (a queued PR needs no auto-merge).
 * `deleteWorkspace` removes the worktree and its branch, but only once the
 * PR has merged now: a queued or auto-merging PR keeps its workspace, and
 * the main workspace is never removed.
 */
async function mergePr(ctx: Ctx, project: ProjectInfo): Promise<void> {
  const { deps, json } = ctx;
  const body = await ctx.readBody();
  if (body.method !== undefined && !isMergeMethod(body.method)) {
    json(400, { error: `'method' must be one of: ${MERGE_METHODS.join(", ")}` });
    return;
  }
  const auto = optionalBoolean(body, "auto");
  const deleteWorkspace = optionalBoolean(body, "deleteWorkspace");
  if (auto === null || deleteWorkspace === null) {
    json(400, { error: "'auto' and 'deleteWorkspace' must be booleans" });
    return;
  }

  const found = await workspacePr(ctx, project, body);
  if (!found) return;
  const { workspace, repo, pr } = found;
  if (deleteWorkspace && workspace.isMain) {
    json(400, { error: "The project's main workspace can't be deleted" });
    return;
  }

  let options: PrMergeOptions;
  try {
    options = await deps.githubManager.getMergeOptions(repo, pr.number);
  } catch (err) {
    json(502, { error: errorMessage(err) });
    return;
  }
  const requested = body.method as PrMergeMethod | undefined;
  const method = requested ?? options.allowed[0];
  if (!method) {
    json(409, { error: "This repo allows no merge method" });
    return;
  }
  if (!options.allowed.includes(method)) {
    json(400, {
      error: `This repo doesn't allow ${method} merges; allowed: ${options.allowed.join(", ")}`,
    });
    return;
  }
  if (auto && !options.autoMergeAllowed && !options.mergeQueue) {
    json(400, { error: "This repo doesn't allow auto-merge" });
    return;
  }

  let outcome: PrMergeOutcome;
  try {
    outcome = await deps.githubManager.mergePr(repo, pr.number, method, auto === true);
  } catch (err) {
    json(502, { error: errorMessage(err) });
    return;
  }

  const result: MergePrResult = {
    number: pr.number,
    url: pr.url,
    method,
    outcome,
    removedWorkspace: null,
  };
  if (deleteWorkspace && outcome === "merged") {
    // The sidebar's and `remove_workspace`'s removal: panes end, the
    // worktree goes, then its branch (`git branch -D`, since a squash or
    // rebase merge leaves it unmerged as far as git can tell).
    try {
      await deps.workspaceOps.remove(project.id, workspace.path, true);
      result.removedWorkspace = workspace.path;
    } catch (err) {
      result.removeError = errorMessage(err);
    }
  }
  json(200, result);
}

/** What the brief routes answer. */
type BriefPrResult =
  | { delivery: "printed"; number: number; prompt: string }
  | {
      delivery: "sent";
      number: number;
      agentId: string;
      agentName: string | null;
      paneId: string;
    }
  | { delivery: "started"; number: number; paneId: string; tabId: string };

/** `getPrAgentPrompt`'s refusals when the PR has nothing for the task. */
const NOTHING_TO_DO = /has no failing checks|has no unresolved review threads/;

/**
 * Brief an agent on the workspace PR's failing checks or unresolved review
 * threads. With `print` the brief is only answered. Otherwise it goes to the
 * workspace's agent waiting for its next prompt (`pickPromptTarget`), typed
 * in as the chat view sends a prompt — a busy agent is never interrupted —
 * and to a new agent in the workspace when none is waiting.
 */
function briefPr(task: PrAgentTask): (ctx: Ctx, project: ProjectInfo) => Promise<void> {
  return async (ctx, project) => {
    const { deps, json } = ctx;
    const body = await ctx.readBody();
    const print = optionalBoolean(body, "print");
    if (print === null) {
      json(400, { error: "'print' must be a boolean" });
      return;
    }
    const found = await workspacePr(ctx, project, body);
    if (!found) return;
    const { workspace, repo, pr } = found;

    let prompt: string;
    try {
      prompt = await deps.githubManager.getPrAgentPrompt(repo, pr.number, task);
    } catch (err) {
      const message = errorMessage(err);
      json(NOTHING_TO_DO.test(message) ? 409 : 502, { error: message });
      return;
    }
    if (print) {
      json(200, { delivery: "printed", number: pr.number, prompt } satisfies BriefPrResult);
      return;
    }

    const inWorkspace = deps.agentManager
      .getActiveAgents()
      .filter((a) => a.workspacePath === workspace.path);
    // Live: its pane is still in a workspace's layout, not one closed since.
    const target = pickPromptTarget(
      inWorkspace,
      (paneId) => deps.layoutStore.workspaceOf(paneId) !== null,
    );
    if (target) {
      try {
        await chatSend(localCtx(deps), target.paneId, prompt);
        json(200, {
          delivery: "sent",
          number: pr.number,
          agentId: target.id,
          agentName: target.name,
          paneId: target.paneId,
        } satisfies BriefPrResult);
        return;
      } catch {
        // A pane the write could not reach: a new agent still gets it.
      }
    }

    const started = await startAgentInWorkspace(deps, workspace.path, {
      prompt,
      hostId: project.hostId,
    });
    if (!started.ok) {
      json(started.status, { error: started.error });
      return;
    }
    json(200, {
      delivery: "started",
      number: pr.number,
      paneId: started.data.paneId,
      tabId: started.data.tabId,
    } satisfies BriefPrResult);
  };
}

/** Narrowed for the handler table: `withProject` hands every route its project. */
function projectRoute(
  path: string,
  run: (ctx: Ctx, project: ProjectInfo) => Promise<void>,
): ServerRoute {
  return {
    method: "POST",
    path: `/projects/:projectId/workspaces/pr/${path}`,
    handler: withProject((ctx, _pm, project) => run(ctx, project)),
  };
}

export const workspacePrRoutes: ServerRoute[] = [
  projectRoute("merge", mergePr),
  projectRoute("fix-checks", briefPr("checks")),
  projectRoute("address-comments", briefPr("comments")),
];
