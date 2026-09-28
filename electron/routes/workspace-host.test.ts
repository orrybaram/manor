import { describe, it, expect } from "vitest";
import { withWorkspaceHost } from "./workspace-host";
import type { ControlDeps } from "./types";

// ADR-191: main names the host of the workspace an app-command targets.
const projectManager = {
  hostIdForPath: (p: string) => (p.startsWith("/srv/") ? "box" : "local"),
} as unknown as ControlDeps["projectManager"];

describe("withWorkspaceHost", () => {
  it("names the host of the project that owns the path", () => {
    expect(withWorkspaceHost({ projectManager }, { workspacePath: "/srv/app" })).toEqual({
      workspacePath: "/srv/app",
      hostId: "box",
    });
  });

  it("names the relaying host for a request from a remote manor CLI", () => {
    expect(
      withWorkspaceHost({ projectManager, callerHostId: "other" }, { workspacePath: "/home/a" }),
    ).toEqual({ workspacePath: "/home/a", hostId: "other" });
  });

  it("keeps a host the caller named", () => {
    const body = { workspacePath: "/srv/app", hostId: "local" };
    expect(withWorkspaceHost({ projectManager }, body)).toBe(body);
  });

  it("leaves a body with no workspace alone", () => {
    const body = { contentType: "terminal" };
    expect(withWorkspaceHost({ projectManager }, body)).toBe(body);
  });
});
