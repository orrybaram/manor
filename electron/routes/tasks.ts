/**
 * `/tasks` — live session state, read-only. This is the "see every session"
 * surface `list_tasks` (`electron/mcp/tools-tasks.ts`) proxies: every
 * `TaskInfo` the `TaskManager` (`../task-persistence.ts`) knows about,
 * regardless of which project or workspace it belongs to.
 *
 * Entirely main-served — `taskManager` already lives in the main process, so
 * unlike the pane/tab routes there is no renderer round-trip here.
 */

import type { TaskInfo } from "../task-persistence";
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
];
