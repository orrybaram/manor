import { describe, it, expect, vi } from "vitest";
import { contextRoutes } from "./context";
import type { ControlDeps } from "./types";
import type { ProjectInfo } from "../persistence";
import type { PersistedLayout } from "../terminal-host/layout-persistence";

function project(id: string, hostId: string, path: string): ProjectInfo {
  return {
    id,
    name: id,
    path,
    hostId,
    workspaces: [{ path, branch: "main", isMain: true, name: null }],
  } as unknown as ProjectInfo;
}

/** Same path on this machine and on "box" — the ambiguity ADR-189 §2 removes. */
const projects = [project("local-p", "local", "/repo"), project("box-p", "box", "/repo")];

/** A minimal `layout.json` naming one pane's bare workspace path. */
function layoutWithPane(paneId: string, workspacePath: string): PersistedLayout {
  return {
    version: 2,
    workspaces: [
      {
        workspacePath,
        panelTree: { type: "leaf", panelId: "panel-1" },
        activePanelId: "panel-1",
        panels: {
          "panel-1": {
            id: "panel-1",
            tabs: [
              {
                id: "tab-1",
                title: "tab-1",
                rootNode: { type: "leaf", paneId },
                focusedPaneId: paneId,
                paneSessions: {
                  [paneId]: { daemonSessionId: "daemon-1", lastCwd: null, lastTitle: null },
                },
              },
            ],
            selectedTabId: "tab-1",
            pinnedTabIds: [],
          },
        },
      },
    ],
  };
}

async function getContext(
  query: string,
  extra: Partial<ControlDeps> = {},
  ps: ProjectInfo[] = projects,
) {
  const deps = {
    projectManager: { getProjects: async () => ps },
    layoutPersistence: null,
    githubManager: null,
    linearManager: null,
    sessionOwners: null,
    ...extra,
  } as unknown as ControlDeps;
  const json = vi.fn();
  await contextRoutes[0].handler({
    deps,
    params: {},
    url: new URL(`http://x/context?${query}`),
    json,
    readBody: async () => ({}),
  });
  return json.mock.calls[0] as [number, Record<string, unknown>];
}

describe("GET /context", () => {
  it("matches a local caller's cwd against only its own host's projects", async () => {
    const [status, body] = await getContext("cwd=/repo/src");
    expect(status).toBe(200);
    expect(body.projectId).toBe("local-p");
  });

  it("only matches a relayed caller's cwd against its own host's projects", async () => {
    const [status, body] = await getContext("cwd=/repo/src", { callerHostId: "box" });
    expect(status).toBe(200);
    expect(body.projectId).toBe("box-p");
  });

  it("404s a relayed caller whose host has no project at its cwd", async () => {
    const [status] = await getContext("cwd=/repo", { callerHostId: "other" });
    expect(status).toBe(404);
  });

  it("offers a relayed caller only its own host's projects to retry with", async () => {
    const [status, body] = await getContext("cwd=/elsewhere", { callerHostId: "box" });
    expect(status).toBe(404);
    expect(body.candidates).toEqual([{ projectId: "box-p", name: "box-p", path: "/repo" }]);
  });

  it("a local caller whose pane is owned by a remote host (SessionOwners) resolves to the remote project", async () => {
    const sessionOwners = {
      ownerOf: (id: string) => (id === "pane-1" ? "box" : undefined),
    } as unknown as ControlDeps["sessionOwners"];
    const [status, body] = await getContext("paneId=pane-1&cwd=/repo/src", { sessionOwners });
    expect(status).toBe(200);
    expect(body.projectId).toBe("box-p");
  });

  it("a local caller whose pane has no known owner still resolves locally", async () => {
    const sessionOwners = {
      ownerOf: () => undefined,
    } as unknown as ControlDeps["sessionOwners"];
    const [status, body] = await getContext("paneId=pane-1&cwd=/repo/src", { sessionOwners });
    expect(status).toBe(200);
    expect(body.projectId).toBe("local-p");
  });

  it("rung 1 matches the pane's workspace path against the caller's host, not just any project at that path", async () => {
    const layoutPersistence = { load: () => layoutWithPane("pane-1", "/repo") };
    const [status, body] = await getContext("paneId=pane-1", {
      layoutPersistence: layoutPersistence as unknown as ControlDeps["layoutPersistence"],
      callerHostId: "box",
    });
    expect(status).toBe(200);
    expect(body.projectId).toBe("box-p");
  });

  it("rung 1 falls through to cwd when the pane's host has no project at that path", async () => {
    const layoutPersistence = { load: () => layoutWithPane("pane-1", "/repo") };
    const [status] = await getContext("paneId=pane-1", {
      layoutPersistence: layoutPersistence as unknown as ControlDeps["layoutPersistence"],
      callerHostId: "other",
    });
    expect(status).toBe(404);
  });

  it("single-host behavior is unchanged: a local caller resolves by cwd alone", async () => {
    const soloProjects = [project("only-p", "local", "/solo")];
    const [status, body] = await getContext("cwd=/solo/src", {}, soloProjects);
    expect(status).toBe(200);
    expect(body.projectId).toBe("only-p");
  });
});
