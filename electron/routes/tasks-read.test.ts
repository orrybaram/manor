/**
 * `/sessions/read` targeting (ADR-154, widened): a task handle is the preferred
 * target, but plain terminal panes — which never get a `TaskInfo` — must be
 * readable by their raw paneId too.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../terminal-host/scrollback", () => ({
  ScrollbackWriter: {
    readScrollback: vi.fn(() => ""),
    readMeta: vi.fn(() => null),
  },
}));

import { ScrollbackWriter } from "../terminal-host/scrollback";
import { tasksRoutes } from "./tasks";
import type { ControlDeps, Route } from "./types";

const readRoute = tasksRoutes.find(
  (r: Route) => r.path === "/sessions/read" && r.method === "POST",
)!;

const readScrollback = vi.mocked(ScrollbackWriter.readScrollback);
const readMeta = vi.mocked(ScrollbackWriter.readMeta);

/** A TaskManager stub that knows about exactly one agent session. */
function taskManager(task: Record<string, unknown> | null) {
  return {
    getTaskById: (id: string) => (task && task.id === id ? task : null),
    getTaskByPaneId: (pane: string) =>
      task && task.paneId === pane ? task : null,
    getActiveTasks: () => (task ? [task] : []),
  };
}

async function read(
  body: Record<string, unknown>,
  {
    task = null,
    snapshots = {} as Record<string, string>,
  }: {
    task?: Record<string, unknown> | null;
    snapshots?: Record<string, string>;
  } = {},
) {
  const calls: Array<{ status: number; body: any }> = [];
  const deps = {
    taskManager: taskManager(task),
    backend: {
      pty: {
        getSnapshot: async (id: string) =>
          id in snapshots ? { screenAnsi: snapshots[id] } : null,
      },
    },
  } as unknown as ControlDeps;

  await readRoute.handler({
    deps,
    params: {},
    url: new URL("http://localhost/sessions/read"),
    json: (status, b) => calls.push({ status, body: b }),
    readBody: async () => body,
  });
  return calls[0];
}

beforeEach(() => {
  readScrollback.mockReturnValue("");
  readMeta.mockReturnValue(null);
});

describe("POST /sessions/read", () => {
  it("reads a live pane that has no task row at all", async () => {
    const res = await read(
      { target: "pane-7" },
      { snapshots: { "pane-7": "$ ls\nREADME.md\n" } },
    );

    expect(res.status).toBe(200);
    expect(res.body.text).toContain("README.md");
    expect(res.body.source).toBe("live");
    expect(res.body.target).toMatchObject({
      id: "pane-7",
      paneId: "pane-7",
      kind: "pane",
      lastAgentStatus: null,
    });
  });

  it("falls back to persisted scrollback for a dead plain pane", async () => {
    readScrollback.mockReturnValue("$ make build\ndone\n");

    const res = await read({ target: "pane-9" });

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("scrollback");
    expect(res.body.text).toContain("make build");
    expect(res.body.target.kind).toBe("pane");
  });

  it("404s on a target that is neither a task nor a known pane", async () => {
    const res = await read({ target: "nonsense" });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("nonsense");
  });

  it("returns an empty transcript for a pane whose scrollback file exists but is empty", async () => {
    // A pane that exists on disk with nothing written yet is a real target:
    // an empty transcript is the honest answer, not "no such pane".
    readMeta.mockReturnValue({ sessionId: "pane-3" } as any);

    const res = await read({ target: "pane-3" });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe("");
  });

  it("prefers the task's pane when the target resolves to a session", async () => {
    const res = await read(
      { target: "task-1" },
      {
        task: { id: "task-1", paneId: "pane-1", lastAgentStatus: "working" },
        snapshots: { "pane-1": "thinking...\n" },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.target).toMatchObject({
      id: "task-1",
      paneId: "pane-1",
      kind: "session",
      lastAgentStatus: "working",
    });
  });

  it("409s on a resolved session with no pane instead of reading the raw target", async () => {
    const res = await read(
      { target: "task-2" },
      { task: { id: "task-2", paneId: null, lastAgentStatus: null } },
    );

    expect(res.status).toBe(409);
  });
});
