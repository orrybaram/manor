/**
 * A moved workspace's source is removed through the normal removal path,
 * but its Agents go on in the target: ending them here must not count as a
 * kill (#529). The real chain, from the move's `removeWorkspace` down
 * through `ProjectManager.removeWorktree`, the server's
 * `workspaceLayoutOwner` (which once dropped the move's ending),
 * `LayoutStore.remove` and `createAgentService`, against a normal removal
 * that still counts one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { ProjectManager } from "../persistence";
import { LayoutStore, workspaceLayoutOwner, type LayoutStoreBackend } from "../layout/layout-store";
import { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { GitBackend } from "../backend/types";
import { createWorkspaceOps } from "../workspace-ops";
import { createAgentService } from "../bridge/handlers/agents";
import { createWorkspaceHostMoveDeps } from "./workspace-host-move";

const PROJECT = "/project/main";
const WORKTREE = "/project/worktrees/feature";

/** Every git call answers "nothing to report", and succeeds. */
const stubGit = new Proxy(
  {},
  {
    get: (_target, key) => vi.fn(async () => (key === "worktreeList" ? [] : "")),
  },
) as GitBackend;

describe("removing a moved workspace's source", () => {
  let tmpDir: string;
  let pm: ProjectManager;
  let projectId: string;
  let record: ReturnType<typeof vi.fn<(counter: string, n?: number) => void>>;
  let signal: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `manor-move-removal-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    record = vi.fn<(counter: string, n?: number) => void>();
    signal = vi.fn(() => ({ effects: [] }));
    // A mid-turn Agent in the workspace's one pane.
    const agentDeps = {
      agentManager: {
        getAgentByPaneId: vi.fn((paneId: string) =>
          paneId === "pane-1"
            ? { id: "a1", agentSessionId: "s1", status: "active", lastAgentStatus: "working", name: "Fix" }
            : null,
        ),
        updateAgent: vi.fn(),
      },
      statsStore: { record },
      notifier: { sendAgentUpdate: vi.fn() },
      agentStatus: { signal },
      paneContextMap: new Map(),
    };
    const store = new LayoutStore(
      new LayoutPersistence(path.join(tmpDir, "layout.json")),
      () => {},
      { pty: { kill: vi.fn().mockResolvedValue(undefined) } } as unknown as LayoutStoreBackend,
      undefined,
      undefined,
      createAgentService(agentDeps as never),
    );
    // As `createManorServer` wires it.
    pm = new ProjectManager(stubGit, tmpDir, { layout: workspaceLayoutOwner(() => store) });
    projectId = (await pm.addProject("Main", PROJECT)).id;
    await store.apply(
      WORKTREE,
      {
        type: "new-tab",
        tab: { id: "tab-1", title: "Claude", rootNode: { type: "leaf", paneId: "pane-1" } },
      },
      { kind: "route", id: "test" },
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function workspaceOps() {
    return createWorkspaceOps({
      projectManager: pm,
      statsStore: { record },
      notifyProjectsChanged: () => {},
      runSetupScript: async () => {},
    });
  }

  it("records no kill for a mid-turn Agent, and ends it as moved", async () => {
    const deps = createWorkspaceHostMoveDeps({
      projectManager: pm,
      workspaceOps: workspaceOps(),
      backendRegistry: { get: vi.fn(), ensureConnected: vi.fn() } as never,
    });
    const project = (await pm.getProjects()).find((p) => p.id === projectId)!;

    await deps.removeWorkspace(project, WORKTREE);

    expect(record).not.toHaveBeenCalledWith("agentsKilled");
    expect(record).not.toHaveBeenCalledWith("agentsKilledMidThought");
    expect(signal).toHaveBeenCalledWith("pane-1", { type: "user", action: "move" });
  });

  it("still counts a normal removal's mid-turn Agent as killed", async () => {
    await workspaceOps().remove(projectId, WORKTREE, false);

    expect(record).toHaveBeenCalledWith("agentsKilled");
    expect(record).toHaveBeenCalledWith("agentsKilledMidThought");
    expect(signal).toHaveBeenCalledWith("pane-1", { type: "user", action: "abandon" });
  });
});
