/**
 * Launches on the server: an agent tab or a setup script starts
 * its session the moment its pane joins a tree, with no renderer anywhere,
 * and a renderer that mounts the pane later attaches to it — never a second
 * spawn, never the command typed twice.
 *
 * Over a real `LayoutStore` and a fake daemon that models the gap between
 * create-or-attach's two calls (snapshot, then create), which is where two
 * overlapping creates of one pane would both find no session.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  LayoutStore,
  type LayoutFile,
  type LayoutStoreBackend,
} from "../../layout/layout-store";
import { createServerLaunches, spawnPane, type SpawnPaneDeps } from "../spawn-pane";
import { layoutPaneContext } from "../pane-context";
import { serverAgentPipelineOptions } from "../../agent-status/pipeline";
import { createWorkspaceOps } from "../../workspace-ops";
import { ptyCreate } from "../../bridge/handlers/pty";
import { localCtx } from "../../bridge/method";
import { resetAttachments } from "../../pty-attachments";
import type { HostDeps } from "../../ipc/types";
import type { ProjectInfo } from "../../persistence";
import type { SetupProgressEvent } from "../../../src/store/project-store";
import { createTab } from "../../../src/lib/layout/ids";
import { workspaceKey } from "../../../src/lib/workspace-key";

const WS = "/repos/demo-ws";

/** No file: every test starts from an empty layout. */
const NO_FILE = {
  load: () => null,
  save: () => {},
  removeWorkspace: () => {},
} as unknown as LayoutFile;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Until every fire-and-forget spawn has settled. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await tick();
}

describe("server-side launches", () => {
  /** Sessions the fake daemon holds. */
  let sessions: Set<string>;
  let creates: Array<{ paneId: string; cwd: string; cols: number; rows: number; opts: unknown }>;
  let typed: Array<[string, string]>;
  let progress: Array<{ origin: string | null; event: SetupProgressEvent }>;
  let store: LayoutStore;
  let deps: SpawnPaneDeps;
  let launches: ReturnType<typeof createServerLaunches>;
  /** What `ProjectManager.workspaceProject` knows. */
  let projects: Record<
    string,
    { projectId: string; projectName: string; projectPath: string; agentCommand: string | null }
  >;

  beforeEach(() => {
    sessions = new Set();
    creates = [];
    typed = [];
    progress = [];
    projects = {
      [`local:${WS}`]: {
        projectId: "p1",
        projectName: "demo",
        projectPath: "/repos/demo",
        agentCommand: "codex --yolo",
      },
    };
    const backend = {
      pty: {
        // Snapshot first, create second, with the daemon round trip between.
        createOrAttachWith: async (
          paneId: string,
          cwd: string,
          cols: number,
          rows: number,
          opts: { hostId?: string },
        ) => {
          creates.push({ paneId, cwd, cols, rows, opts });
          const existed = sessions.has(paneId);
          await tick();
          if (!existed) sessions.add(paneId);
          return {
            session: {},
            snapshot: existed ? { screenAnsi: "$ ", seq: 3, cols, rows } : null,
            hostId: opts.hostId ?? "local",
          };
        },
        writeAfterReady: async (paneId: string, data: string) => {
          typed.push([paneId, data]);
        },
        getSnapshot: async () => null,
        kill: async (paneId: string) => {
          sessions.delete(paneId);
        },
      },
    };
    deps = {
      backend,
      backendRegistry: {},
      layoutStore: undefined,
    } as unknown as SpawnPaneDeps;
    launches = createServerLaunches({
      spawnDeps: () => deps,
      projectManager: {
        workspaceProject: (hostId, path) => projects[`${hostId}:${path}`] ?? null,
      },
      publishSetupProgress: (origin, event) => progress.push({ origin, event }),
    });
    store = new LayoutStore(
      NO_FILE,
      () => {},
      backend as unknown as LayoutStoreBackend,
      undefined,
      undefined,
      undefined,
      launches,
    );
    deps.layoutStore = store;
  });

  afterEach(() => resetAttachments());

  /** Open an agent tab the way `addTerminalTab` and `POST /agents` do. */
  async function openAgentTab(text: string, kind: "agent-startup" | "shell" = "agent-startup") {
    const paneId = `pane-${Math.random().toString(36).slice(2)}`;
    store.pendingCommands.set(paneId, text, kind);
    await store.apply(
      WS,
      { type: "new-tab", tab: createTab(undefined, paneId) },
      { kind: "window", id: "1" },
    );
    return paneId;
  }

  it("spawns an agent tab's session on apply and types its launch line", async () => {
    const paneId = await openAgentTab("claude --resume");
    await settle();

    expect(creates).toEqual([
      {
        paneId,
        cwd: WS,
        cols: 80,
        rows: 24,
        // The kind comes from the launch line itself, not the project's.
        opts: { hostId: "local", env: { MANOR_AGENT_KIND: "claude" } },
      },
    ]);
    expect(typed).toEqual([[paneId, "claude --resume\r"]]);
    // The pane's session row names it from the start.
    expect(store.get(WS)?.paneSessions[paneId]).toMatchObject({
      daemonSessionId: paneId,
      lastCwd: WS,
    });
  });

  it("names the session by the kind queued with its line, else by the line after a cd", async () => {
    const queued = "pane-queued-kind";
    store.pendingCommands.set(queued, "cd /repo/api && claude --resume x", "agent-startup", { agentKind: "codex" });
    await store.apply(WS, { type: "new-tab", tab: createTab(undefined, queued) }, { kind: "window", id: "1" });
    const cdLine = await openAgentTab("cd '/repo/my api' && codex resume t1");
    await settle();

    const kindOf = (paneId: string) =>
      (creates.find((c) => c.paneId === paneId)?.opts as { env?: Record<string, string> }).env?.MANOR_AGENT_KIND;
    expect(kindOf(queued)).toBe("codex");
    expect(kindOf(cdLine)).toBe("codex");
  });

  it("spawns a remote workspace's pane on its own host", async () => {
    const key = workspaceKey("box", WS);
    const paneId = "pane-remote";
    store.pendingCommands.set(paneId, "claude", "agent-startup");
    await store.apply(key, { type: "new-tab", tab: createTab(undefined, paneId) }, {
      kind: "route",
      id: "agents",
    });
    await settle();

    expect(creates).toEqual([expect.objectContaining({ paneId, cwd: WS, opts: expect.objectContaining({ hostId: "box" }) })]);
  });

  it("leaves a plain shell line for the renderer that mounts its pane", async () => {
    await openAgentTab("pnpm dev", "shell");
    await settle();

    expect(creates).toEqual([]);
    expect(typed).toEqual([]);
  });

  it("attaches a renderer that mounts a launched pane, and types nothing twice", async () => {
    const paneId = await openAgentTab("claude");
    await settle();

    const result = await ptyCreate(
      localCtx(deps as unknown as HostDeps),
      paneId,
      WS,
      120,
      40,
    );

    expect(result).toMatchObject({ ok: true, prewarmed: true, snapshot: "$ " });
    expect(sessions.size).toBe(1);
    expect(typed).toEqual([[paneId, "claude\r"]]);
  });

  it("attaches a renderer whose mount races the launch, rather than spawning again", async () => {
    const paneId = "pane-race";
    store.pendingCommands.set(paneId, "claude", "agent-startup");
    // The renderer's `pty.create` lands while the launch's create is still
    // between its snapshot and its create.
    const applied = store.apply(WS, { type: "new-tab", tab: createTab(undefined, paneId) }, {
      kind: "window",
      id: "1",
    });
    await tick();
    const mounted = spawnPane(deps, paneId, { cwd: WS, cols: 120, rows: 40 });
    await applied;
    const result = await mounted;
    await settle();

    expect(creates.map((c) => c.paneId)).toEqual([paneId, paneId]);
    // One fresh create, one attach.
    expect(result).toMatchObject({ ok: true, prewarmed: true });
    expect(typed).toEqual([[paneId, "claude\r"]]);
  });

  it("runs a new workspace's setup script with no renderer, and closes its tab when it exits", async () => {
    const ops = createWorkspaceOps({
      projectManager: {
        createWorktree: async () =>
          ({
            id: "p1",
            hostId: "local",
            worktreeStartScript: "pnpm i",
            group: null,
            workspaces: [{ path: WS, branch: "feat", isMain: false, name: "feat" }],
          }) as unknown as ProjectInfo,
        createWorkspacesFromIssues: async () => [],
        removeWorktree: async () => {},
        quickMergeWorktree: async () => {},
        setGroupLastUsedHost: () => {},
      },
      statsStore: { record: () => {} },
      notifyProjectsChanged: () => {},
      runSetupScript: launches.runSetupScript,
    });

    await ops.create({ projectId: "p1", name: "feat", origin: "7" });
    await settle();

    // The tab exists by the time the create answers, and its shell is running.
    const tabs = Object.values(store.get(WS)!.layout.panels).flatMap((p) => p.tabs);
    expect(tabs.map((t) => t.title)).toEqual(["Setup"]);
    const paneId = (tabs[0].rootNode as { paneId: string }).paneId;
    expect(creates).toEqual([expect.objectContaining({ paneId, cwd: WS })]);
    expect(typed).toEqual([[paneId, "pnpm i; exit\r"]]);
    expect(progress).toEqual([
      {
        origin: "7",
        event: { step: "setup-script", status: "in-progress", workspacePath: WS },
      },
    ]);

    // `exit` ends the shell.
    launches.onExit(paneId);
    await settle();

    expect(progress[progress.length - 1]).toEqual({
      origin: "7",
      event: { step: "setup-script", status: "done", workspacePath: WS },
    });
    const left = Object.values(store.get(WS)!.layout.panels).flatMap((p) => p.tabs);
    expect(left).toEqual([]);

    // Nobody closed it, so "reopen closed pane" has nothing to bring back.
    await store.apply(WS, { type: "reopen-closed-pane", newTabId: "reopened" }, { kind: "window", id: "1" });
    const reopened = Object.values(store.get(WS)!.layout.panels).flatMap((p) => p.tabs);
    expect(reopened).toEqual([]);
  });

  it("gives a setup script's shell the workspace and the project's main checkout in its env", async () => {
    const ops = createWorkspaceOps({
      projectManager: {
        createWorktree: async () =>
          ({
            id: "p1",
            hostId: "local",
            worktreeStartScript: "bash scripts/setup-worktree.sh",
            group: null,
            workspaces: [{ path: WS, branch: "feat", isMain: false, name: "feat" }],
          }) as unknown as ProjectInfo,
        createWorkspacesFromIssues: async () => [],
        removeWorktree: async () => {},
        quickMergeWorktree: async () => {},
        setGroupLastUsedHost: () => {},
      },
      statsStore: { record: () => {} },
      notifyProjectsChanged: () => {},
      runSetupScript: launches.runSetupScript,
    });

    await ops.create({ projectId: "p1", name: "feat" });
    await settle();

    expect(creates).toHaveLength(1);
    expect((creates[0].opts as { env?: Record<string, string> }).env).toEqual({
      MANOR_AGENT_KIND: "codex",
      MANOR_WORKSPACE_PATH: WS,
      MANOR_PROJECT_PATH: "/repos/demo",
      ROOT_WORKTREE_PATH: "/repos/demo",
    });

    // An agent's launch in the same workspace is not a setup script's.
    await openAgentTab("claude");
    await settle();
    expect((creates[1].opts as { env?: Record<string, string> }).env).toEqual({
      MANOR_AGENT_KIND: "claude",
    });
  });

  it("reports a setup script that exits non-zero as failed", async () => {
    const ops = createWorkspaceOps({
      projectManager: {
        createWorktree: async () =>
          ({
            id: "p1",
            hostId: "local",
            worktreeStartScript: "pnpm i",
            group: null,
            workspaces: [{ path: WS, branch: "feat", isMain: false, name: "feat" }],
          }) as unknown as ProjectInfo,
        createWorkspacesFromIssues: async () => [],
        removeWorktree: async () => {},
        quickMergeWorktree: async () => {},
        setGroupLastUsedHost: () => {},
      },
      statsStore: { record: () => {} },
      notifyProjectsChanged: () => {},
      runSetupScript: launches.runSetupScript,
    });
    await ops.create({ projectId: "p1", name: "feat", origin: "7" });
    await settle();
    const tabs = Object.values(store.get(WS)!.layout.panels).flatMap((p) => p.tabs);
    const paneId = (tabs[0].rootNode as { paneId: string }).paneId;

    launches.onExit(paneId, 3);
    await settle();

    expect(progress[progress.length - 1]).toEqual({
      origin: "7",
      event: {
        step: "setup-script",
        status: "error",
        message: "The setup script exited with code 3.",
        workspacePath: WS,
      },
    });
  });

  it("with awaitSetup, a create answers with the setup script's exit code once its shell exits", async () => {
    const ops = createWorkspaceOps({
      projectManager: {
        createWorktree: async () =>
          ({
            id: "p1",
            hostId: "local",
            worktreeStartScript: "pnpm i",
            group: null,
            workspaces: [{ path: WS, branch: "feat", isMain: false, name: "feat" }],
          }) as unknown as ProjectInfo,
        createWorkspacesFromIssues: async () => [],
        removeWorktree: async () => {},
        quickMergeWorktree: async () => {},
        setGroupLastUsedHost: () => {},
      },
      statsStore: { record: () => {} },
      notifyProjectsChanged: () => {},
      runSetupScript: launches.runSetupScript,
    });
    let answered = false;
    const created = ops
      .create({ projectId: "p1", name: "feat", awaitSetup: { timeoutMs: 60_000 } })
      .then((r) => {
        answered = true;
        return r;
      });
    await settle();
    expect(answered).toBe(false);
    const tabs = Object.values(store.get(WS)!.layout.panels).flatMap((p) => p.tabs);
    const paneId = (tabs[0].rootNode as { paneId: string }).paneId;

    launches.onExit(paneId, 3);
    expect((await created).setup).toEqual({ status: "exited", exitCode: 3 });
  });

  it("ignores the exit of a pane that is not running a setup script", async () => {
    const paneId = await openAgentTab("claude");
    await settle();

    launches.onExit(paneId);
    await settle();

    expect(progress).toEqual([]);
    expect(store.workspaceOf(paneId)).toBe(WS);
  });

  it("names a launched pane's project and workspace before any renderer does", async () => {
    const paneId = await openAgentTab("claude");
    const context = layoutPaneContext(
      store,
      { workspaceProject: (hostId, path) => projects[`${hostId}:${path}`] ?? null },
      paneId,
    );

    expect(context).toEqual({
      projectId: "p1",
      projectName: "demo",
      workspacePath: WS,
      agentCommand: "codex --yolo",
    });
    expect(layoutPaneContext(store, { workspaceProject: () => null }, "pane-nowhere")).toBeUndefined();

    // In the agent pipeline: a renderer's context still overrides it, and a
    // pane in no layout has none.
    const rendererContext = { ...context!, projectName: "from the renderer" };
    const paneContexts = new Map([["pane-set", rendererContext]]);
    const { getPaneContext } = serverAgentPipelineOptions({
      paneContexts,
      layoutPaneContext: (id: string) =>
        layoutPaneContext(
          store,
          { workspaceProject: (hostId, path) => projects[`${hostId}:${path}`] ?? null },
          id,
        ),
    } as unknown as Parameters<typeof serverAgentPipelineOptions>[0]);
    expect(getPaneContext(paneId)).toEqual(context);
    expect(getPaneContext("pane-set")).toBe(rendererContext);
    expect(getPaneContext("pane-elsewhere")).toBeUndefined();
  });
});
