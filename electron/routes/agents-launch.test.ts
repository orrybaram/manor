/**
 * `POST /agents` — the launch route, server-side (ADR-179 ticket 11).
 *
 * This is where ADR-176's guarantees live now. They used to be a correlated
 * round-trip to a window, for one reason: the launch line had to be seeded
 * into the *sending renderer's* pending-command map. With that map on the
 * server both halves of a launch happen here, so what these tests pin is:
 *
 * - every read and write keys off the requested `workspacePath`, never
 *   whatever a window happens to be looking at;
 * - the answer names a pane that really exists, so a failed launch is
 *   retryable rather than reported as success;
 * - the launch is queued for exactly that pane, as the bare harness command
 *   with the prompt beside it, raw — `pty.create` delivers it through a file
 *   on the pane's host (ADR-209);
 * - and none of it needs a window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { agentRoutes } from "./agents";
import type { RouteDeps, Route } from "./types";
import { LayoutStore } from "../layout/layout-store";
import { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { LayoutStoreBackend } from "../layout/layout-store";
import { allPaneIds } from "../../src/lib/layout/pane-tree";
import { HOME_PATH } from "../../src/lib/home-path";

const WS = "/repos/demo-ws";
const PROJECT_COMMAND = "claude --workspace";
const DEFAULT_COMMAND = "claude --dangerously-skip-permissions";

const launchRoute = ((): Route => {
  const route = agentRoutes.find(
    (r) => r.method === "POST" && r.path === "/agents",
  );
  if (!route) throw new Error("No route POST /agents");
  return route;
})();

async function call(deps: Partial<RouteDeps>, body: Record<string, unknown>) {
  const calls: Array<{ status: number; body: any }> = [];
  await launchRoute.handler({
    deps: deps as RouteDeps,
    params: {},
    url: new URL("http://localhost/agents"),
    json: (status, b) => calls.push({ status, body: b }),
    readBody: async () => body,
  });
  return calls[0];
}

describe("POST /agents", () => {
  let tmpDir: string;
  let store: LayoutStore;
  let deps: Partial<RouteDeps>;

  /**
   * A project manager that owns `WS` with an `agentCommand` of its own — and,
   * with `remoteCommand`, a remote project on host "box" that lists the very
   * same path (ADR-191).
   */
  function projectManager(agentCommand: string | null, remoteCommand?: string) {
    const ws = [{ path: WS, branch: "main", isMain: false, name: "ws" }];
    return {
      getProjects: async () => [
        { id: "p1", name: "demo", path: "/repos/demo", hostId: "local", agentCommand, workspaces: ws },
        ...(remoteCommand
          ? [{ id: "p2", name: "demo", path: "/repos/demo", hostId: "box", agentCommand: remoteCommand, workspaces: ws }]
          : []),
      ],
      hostIdForPath: () => "local",
    } as unknown as RouteDeps["projectManager"];
  }

  /** The pane the answer named, as the layout store actually holds it. */
  function paneOfTab(workspacePath: string, tabId: string): string[] {
    const entry = store.get(workspacePath)!;
    for (const panel of Object.values(entry.layout.panels)) {
      const tab = panel.tabs.find((t) => t.id === tabId);
      if (tab) return allPaneIds(tab.rootNode);
    }
    throw new Error(`No tab ${tabId} in ${workspacePath}`);
  }

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `manor-agents-launch-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    store = new LayoutStore(
      new LayoutPersistence(path.join(tmpDir, "layout.json")),
      () => {},
      { pty: { kill: vi.fn().mockResolvedValue(undefined) } } as unknown as LayoutStoreBackend,
    );
    deps = { layoutStore: store, projectManager: projectManager(PROJECT_COMMAND) };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("opens a tab in the requested workspace and answers with its pane", async () => {
    const res = await call(deps, { workspacePath: WS, prompt: "fix the bug" });

    expect(res.status).toBe(200);
    expect(res.body.workspacePath).toBe(WS);
    expect(paneOfTab(WS, res.body.tabId)).toEqual([res.body.paneId]);
  });

  it("queues the launch line for that pane, and only that pane", async () => {
    const res = await call(deps, { workspacePath: WS, prompt: "fix the bug" });

    expect(store.pendingCommands.take(res.body.paneId)).toEqual({
      text: PROJECT_COMMAND,
      kind: "agent-startup",
      submit: true,
      prompt: "fix the bug",
    });
    expect(store.pendingCommands.size).toBe(0);
  });

  it("resolves the command from the requested workspace's project", async () => {
    // The ADR-176 regression in its new home: a launch aimed at one workspace
    // must not pick up another's command, and there is no "active" workspace
    // here to pick up in the first place.
    const res = await call(deps, { workspacePath: WS });

    expect(store.pendingCommands.take(res.body.paneId)).toEqual({
      text: PROJECT_COMMAND,
      kind: "agent-startup",
      submit: true,
    });
  });

  it("queues no prompt for a blank one", async () => {
    const res = await call(deps, { workspacePath: WS, prompt: "  \n " });

    expect(store.pendingCommands.take(res.body.paneId)).not.toHaveProperty(
      "prompt",
    );
  });

  it("falls back to the default command for a project without one", async () => {
    deps.projectManager = projectManager(null);

    const res = await call(deps, { workspacePath: WS, prompt: "go" });

    const queued = store.pendingCommands.take(res.body.paneId);
    expect(queued?.text).toBe(DEFAULT_COMMAND);
    expect(queued?.prompt).toBe("go");
  });

  it("falls back to the default command for a workspace no project owns", async () => {
    const res = await call(deps, { workspacePath: "/repos/unknown-ws" });

    expect(store.pendingCommands.take(res.body.paneId)?.text).toBe(
      DEFAULT_COMMAND,
    );
  });

  it("prefers an explicit agentCommand over the project's", async () => {
    const res = await call(deps, {
      workspacePath: WS,
      prompt: "go",
      agentCommand: "my-agent --flag",
    });

    const queued = store.pendingCommands.take(res.body.paneId);
    expect(queued?.text).toBe("my-agent --flag");
    expect(queued?.prompt).toBe("go");
  });

  it("refuses the Dashboard, which hosts no panes (ADR-197)", async () => {
    const res = await call(deps, { workspacePath: HOME_PATH, prompt: "go" });

    expect(res.status).toBe(400);
    expect(store.getAll()).toEqual({});
    expect(store.pendingCommands.size).toBe(0);
  });

  it("opens the tab on the named host's workspace, with that project's command (ADR-191)", async () => {
    deps.projectManager = projectManager(PROJECT_COMMAND, "codex");

    const res = await call(deps, { workspacePath: WS, hostId: "box" });

    expect(res.status).toBe(200);
    expect(store.get(WS)).toBeNull();
    expect(paneOfTab(`box:${WS}`, res.body.tabId)).toEqual([res.body.paneId]);
    expect(store.pendingCommands.take(res.body.paneId)?.text).toBe("codex");
  });

  it("queues the prompt raw — unescaped and unflattened (ADR-209)", async () => {
    // The exact shape `renderPrompt` (routes/projects.ts) builds for the
    // default batch prompt. It reaches the agent through a file on the pane's
    // host, so its quotes, `$` and newlines arrive as written; nothing here is
    // typed into a shell.
    const prompt = 'Work on GitHub issue #1: title\n\nsay "hi" $NOW';
    const res = await call(deps, { workspacePath: WS, prompt });

    const queued = store.pendingCommands.take(res.body.paneId)!;
    expect(queued.text).toBe(PROJECT_COMMAND);
    expect(queued.prompt).toBe(prompt);
  });

  it("400s without a workspacePath, and opens nothing", async () => {
    const res = await call(deps, { prompt: "go" });

    expect(res.status).toBe(400);
    expect(store.getAll()).toEqual({});
    expect(store.pendingCommands.size).toBe(0);
  });
});
