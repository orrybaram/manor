/**
 * `/tasks` — live session state, read-only. This is the "see every session"
 * surface `list_tasks` (`electron/mcp/tools-tasks.ts`) proxies: every
 * `TaskInfo` the `TaskManager` (`../task-persistence.ts`) knows about,
 * regardless of which project or workspace it belongs to.
 *
 * Entirely main-served — `taskManager` already lives in the main process, so
 * unlike the pane/tab routes there is no renderer round-trip here.
 */

import type { TaskInfo, TaskManager } from "../task-persistence";
import { interruptSequenceFor } from "../harness-interrupt";
import type { Route } from "./types";

/** The wire shape `GET /tasks` returns — a curated slice of `TaskInfo`. */
export interface TaskSummary {
  id: string;
  name: string | null;
  status: TaskInfo["status"];
  lastAgentStatus: string | null;
  projectId: string | null;
  projectName: string | null;
  workspacePath: string | null;
  agentKind: TaskInfo["agentKind"];
  paneId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  activatedAt: string | null;
}

function toSummary(task: TaskInfo): TaskSummary {
  return {
    id: task.id,
    name: task.name,
    status: task.status,
    lastAgentStatus: task.lastAgentStatus,
    projectId: task.projectId,
    projectName: task.projectName,
    workspacePath: task.workspacePath,
    agentKind: task.agentKind,
    paneId: task.paneId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    activatedAt: task.activatedAt,
  };
}

/**
 * Resolve a `send_to_session` `target` — deliberately forgiving so the
 * orchestrator can reuse whatever handle it has to hand: the task `id`
 * (`list_tasks`'s stable handle), a raw `paneId`, `#<issue>`, or the workspace
 * branch. Returns the matching `TaskInfo`, or `null` if nothing matches.
 *
 * Exact identifiers (id, paneId) win before the fuzzier branch/issue scan, and
 * that scan only ever considers *active* tasks — steering a completed session
 * is meaningless and would surprise the caller.
 */
function resolveTarget(taskManager: TaskManager, target: string): TaskInfo | null {
  // 1. Stable task id (what list_tasks hands back).
  const byId = taskManager.getTaskById(target);
  if (byId) return byId;

  // 2. Raw pane id.
  const byPane = taskManager.getTaskByPaneId(target);
  if (byPane) return byPane;

  const active = taskManager.getActiveTasks();

  // 3. `#<issue>` — the branch/workspace for an issue conventionally leads with
  //    the issue number (e.g. `159-add-orchestration-ux`), so match a workspace
  //    path segment that is exactly the number or is prefixed `<number>-`.
  const issueMatch = target.match(/^#(\d+)$/);
  if (issueMatch) {
    const issue = issueMatch[1];
    const byIssue = active.find((t) => {
      if (!t.workspacePath) return false;
      const base = t.workspacePath.split("/").pop() ?? "";
      return base === issue || base.startsWith(`${issue}-`);
    });
    if (byIssue) return byIssue;
  }

  // 4. Workspace branch — match the trailing path segment, or the whole path.
  const byBranch = active.find((t) => {
    if (!t.workspacePath) return false;
    const base = t.workspacePath.split("/").pop() ?? "";
    return base === target || t.workspacePath.endsWith(`/${target}`);
  });
  if (byBranch) return byBranch;

  // 5. Human-readable task name, as a last resort.
  return active.find((t) => t.name === target) ?? null;
}

export const tasksRoutes: Route[] = [
  {
    method: "GET",
    path: "/tasks",
    async handler({ deps, url, json }) {
      if (!deps.taskManager) {
        json(200, []);
        return;
      }

      const projectId = url.searchParams.get("projectId") ?? undefined;
      const status = url.searchParams.get("status") ?? undefined;
      const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
      const offsetParam = parseInt(url.searchParams.get("offset") ?? "", 10);
      const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : undefined;

      // No filters at all: default to just the active sessions, which is what
      // "see every session" means in practice — completed/errored/abandoned
      // tasks are noise unless explicitly asked for.
      const noFilters =
        projectId === undefined &&
        status === undefined &&
        limit === undefined &&
        offset === undefined;

      const tasks = noFilters
        ? deps.taskManager.getActiveTasks()
        : deps.taskManager.getAllTasks({ projectId, status, limit, offset });

      json(200, tasks.map(toSummary));
    },
  },

  {
    // Steer a running agent: gracefully interrupt its current turn, then inject
    // a new prompt. Interrupt-then-inject is deliberate — the interrupt ends the
    // turn without killing the process, and may discard in-flight work, so the
    // pre-interrupt `lastAgentStatus` is returned for the caller to judge.
    method: "POST",
    path: "/sessions/send",
    async handler({ deps, json, readBody }) {
      const body = await readBody();

      if (!deps.taskManager) {
        json(503, { error: "Task management is not available" });
        return;
      }
      if (!deps.backend) {
        json(503, { error: "Session backend is not available" });
        return;
      }

      const target = body.target;
      const textToSend = body.text;
      if (typeof target !== "string" || target.length === 0) {
        json(400, { error: "Missing 'target' string in request body" });
        return;
      }
      if (typeof textToSend !== "string" || textToSend.length === 0) {
        json(400, { error: "Missing 'text' string in request body" });
        return;
      }
      const interruptOverride =
        typeof body.interrupt === "string" ? body.interrupt : undefined;

      const task = resolveTarget(deps.taskManager, target);
      if (!task) {
        json(404, { error: `No session matches target '${target}'` });
        return;
      }
      if (!task.paneId) {
        json(409, {
          error: `Session '${task.id}' has no live pane to send to`,
        });
        return;
      }

      // Read the status BEFORE interrupting, so the caller learns whether it
      // just cut off a `working` agent.
      const lastAgentStatus = task.lastAgentStatus;

      // Ordering is load-bearing: interrupt to end the current turn, then submit
      // the new prompt. No artificial delay — the pty layer can't guarantee one.
      const interrupt = interruptSequenceFor(task.agentKind, interruptOverride);
      deps.backend.pty.write(task.paneId, interrupt);
      deps.backend.pty.write(task.paneId, textToSend + "\r");

      json(200, {
        ok: true,
        target: { id: task.id, paneId: task.paneId, lastAgentStatus },
      });
    },
  },
];
