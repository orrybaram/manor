import { describe, it, expect } from "vitest";

import { withWorkspaceHost } from "./workspace-host";
import type { RouteDeps } from "./types";

// ADR-191: main names the host of the workspace an app-command targets.
const projectManager = {
  hostIdForPath: (p: string) => (p.startsWith("/srv/") ? "box" : "local"),
} as unknown as RouteDeps["projectManager"];

describe("withWorkspaceHost", () => {
  it("names the host of the project that owns the path", () => {
    expect(withWorkspaceHost({ projectManager }, { workspacePath: "/srv/app" })).toEqual({
      ok: true,
      body: { workspacePath: "/srv/app", hostId: "box" },
    });
  });

  it("keeps a host a local caller named", () => {
    const body = { workspacePath: "/srv/app", hostId: "local" };
    expect(withWorkspaceHost({ projectManager }, body)).toEqual({ ok: true, body });
  });

  it("leaves a body with no workspace alone", () => {
    const body = { contentType: "terminal" };
    expect(withWorkspaceHost({ projectManager }, body)).toEqual({ ok: true, body });
  });
});
