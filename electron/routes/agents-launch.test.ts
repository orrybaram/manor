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
 * - the line the shell will be given is queued for exactly that pane,
 *   flattened and quoted;
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
import type { ControlDeps, Route } from "./types";
import { LayoutStore } from "../layout/layout-store";
import { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { LocalBackend } from "../backend/local-backend";
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

async function call(deps: Partial<ControlDeps>, body: Record<string, unknown>) {
  const calls: Array<{ status: number; body: any }> = [];
  await launchRoute.handler({
    deps: deps as ControlDeps,
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
  let deps: Partial<ControlDeps>;

  /** A project manager that owns `WS` with an `agentCommand` of its own. */
  function projectManager(agentCommand: string | null) {
    return {
      getProjects: async () => [
        {
          id: "p1",
          name: "demo",
          path: "/repos/demo",
          agentCommand,
          workspaces: [{ path: WS, branch: "main", isMain: false, name: "ws" }],
        },
      ],
    } as unknown as ControlDeps["projectManager"];
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
      { pty: { kill: vi.fn().mockResolvedValue(undefined) } } as unknown as Pick<
        LocalBackend,
        "pty"
      >,
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
      text: `${PROJECT_COMMAND} "fix the bug"`,
      kind: "agent-startup",
    });
    expect(store.pendingCommands.size).toBe(0);
  });

  it("resolves the command from the requested workspace's project", async () => {
    // The ADR-176 regression in its new home: a launch aimed at one workspace
    // must not pick up another's command, and there is no "active" workspace
    // here to pick up in the first place.
    const res = await call(deps, { workspacePath: WS });

    expect(store.pendingCommands.take(res.body.paneId)?.text).toBe(
      PROJECT_COMMAND,
    );
  });

  it("falls back to the default command for a project without one", async () => {
    deps.projectManager = projectManager(null);

    const res = await call(deps, { workspacePath: WS, prompt: "go" });

    expect(store.pendingCommands.take(res.body.paneId)?.text).toBe(
      `${DEFAULT_COMMAND} "go"`,
    );
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

    expect(store.pendingCommands.take(res.body.paneId)?.text).toBe(
      'my-agent --flag "go"',
    );
  });

  it("uses the configured home harness for the home surface", async () => {
    deps.preferencesManager = {
      getAll: () => ({
        homeHarness: "custom",
        homeCustomCommand: "my-harness --go",
        homeCustomInterrupt: "",
      }),
    } as unknown as ControlDeps["preferencesManager"];

    const res = await call(deps, { workspacePath: HOME_PATH, prompt: "go" });

    expect(store.pendingCommands.take(res.body.paneId)?.text).toBe(
      'my-harness --go "go"',
    );
  });

  it("escapes shell metacharacters in the prompt", async () => {
    const res = await call(deps, {
      workspacePath: WS,
      prompt: 'say "hi" $NOW',
    });

    expect(store.pendingCommands.take(res.body.paneId)?.text).toBe(
      `${PROJECT_COMMAND} "say \\"hi\\" \\$NOW"`,
    );
  });

  it("flattens a multi-line prompt before quoting it", async () => {
    // The exact shape `renderPrompt` (routes/projects.ts) builds for the
    // default batch prompt. An unflattened newline either stalls the shell on
    // a continuation prompt or submits the turn early (ADR-176's amendment).
    const res = await call(deps, {
      workspacePath: WS,
      prompt: "Work on GitHub issue #1: title\n\nbody",
    });

    const queued = store.pendingCommands.take(res.body.paneId)!;
    expect(queued.text).not.toContain("\n");
    expect(queued.text).toBe(
      `${PROJECT_COMMAND} "Work on GitHub issue #1: title body"`,
    );
  });

  it("400s without a workspacePath, and opens nothing", async () => {
    const res = await call(deps, { prompt: "go" });

    expect(res.status).toBe(400);
    expect(store.getAll()).toEqual({});
    expect(store.pendingCommands.size).toBe(0);
  });

  it("503s when there is no layout store to open a tab in", async () => {
    const res = await call({ layoutStore: null }, { workspacePath: WS });

    expect(res.status).toBe(503);
  });
});
