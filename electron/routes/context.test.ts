import { describe, it, expect, vi } from "vitest";
import { contextRoutes } from "./context";
import type { ControlDeps } from "./types";
import type { ProjectInfo } from "../persistence";

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

async function getContext(query: string, extra: Partial<ControlDeps> = {}) {
  const deps = {
    projectManager: { getProjects: async () => projects },
    layoutPersistence: null,
    githubManager: null,
    linearManager: null,
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
  it("matches a local caller's cwd against every project, first wins", async () => {
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
});
