/**
 * `DELETE /projects/:projectId/workspaces` — the CLI's and MCP's
 * `remove_workspace` — tears the workspace's layout down on the server
 * (ADR-182 D7), the same way the sidebar's removal does, because both go
 * through `ProjectManager.removeWorktree`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../renderer-bridge", () => ({
  notifyProjectsChanged: vi.fn(),
  runSetupScript: vi.fn(),
}));

import { projectRoutes } from "./projects";
import type { HostDeps, Route } from "./types";
import { ProjectManager } from "../persistence";
import {
  LayoutStore,
  type AgentService,
  type LayoutBroadcast,
} from "../layout/layout-store";
import { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { LocalBackend } from "../backend/local-backend";
import type { GitBackend } from "../backend/types";

const PROJECT = "/project/main";
const WORKTREE = "/project/worktrees/feature";

/** Every git call answers "nothing to report", and succeeds. */
const stubGit = new Proxy(
  {},
  {
    get: (_target, key) =>
      vi.fn(async () => (key === "worktreeList" ? [] : "")),
  },
) as GitBackend;

function findRoute(method: Route["method"], routePath: string): Route {
  const route = projectRoutes.find(
    (r) => r.method === method && r.path === routePath,
  );
  if (!route) throw new Error(`No route ${method} ${routePath}`);
  return route;
}

describe("DELETE /projects/:projectId/workspaces (ADR-182 D7)", () => {
  let tmpDir: string;
  let store: LayoutStore;
  let broadcasts: LayoutBroadcast[];
  let kill: ReturnType<typeof vi.fn>;
  let abandonForPanes: ReturnType<typeof vi.fn<AgentService["abandonForPanes"]>>;
  let pm: ProjectManager;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `manor-projects-routes-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    broadcasts = [];
    kill = vi.fn().mockResolvedValue(undefined);
    abandonForPanes = vi.fn<AgentService["abandonForPanes"]>();
    store = new LayoutStore(
      new LayoutPersistence(path.join(tmpDir, "layout.json")),
      (payload) => broadcasts.push(payload),
      { pty: { kill } } as unknown as Pick<LocalBackend, "pty">,
      undefined,
      undefined,
      { abandonForPanes },
    );
    pm = new ProjectManager(stubGit, tmpDir, store);
    projectId = (await pm.addProject("Main", PROJECT)).id;

    await store.apply(
      WORKTREE,
      {
        type: "new-tab",
        tab: {
          id: "tab-1",
          title: "Terminal",
          rootNode: { type: "leaf", paneId: "pane-1" },
        },
      },
      { kind: "route", id: "test" },
    );
    broadcasts.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clears the workspace's layout, ending its panes and their agents", async () => {
    const route = findRoute("DELETE", "/projects/:projectId/workspaces");
    const calls: Array<{ status: number; body: unknown }> = [];

    await route.handler({
      deps: { projectManager: pm, layoutStore: store } as HostDeps,
      params: { projectId },
      url: new URL("http://localhost/projects/x/workspaces"),
      json: (status, body) => calls.push({ status, body }),
      readBody: async () => ({ worktreePath: WORKTREE }),
    });

    expect(calls).toEqual([{ status: 200, body: { ok: true } }]);
    expect(store.get(WORKTREE)).toBeNull();
    expect(kill).toHaveBeenCalledWith("pane-1");
    expect(abandonForPanes).toHaveBeenCalledWith([
      { paneId: "pane-1", title: null },
    ]);
    expect(broadcasts).toEqual([
      expect.objectContaining({ workspacePath: WORKTREE, removed: true }),
    ]);
  });
});
