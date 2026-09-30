import { describe, it, expect } from "vitest";
import { resolvePaletteScope } from "../scope";
import { HOME_PATH } from "../../../lib/home-path";
import { workspaceKey } from "../../../lib/workspace-key";
import type { ProjectInfo } from "../../../store/project-store";

const projects = [
  { id: "p1", workspaces: [{ path: "/a" }, { path: "/b" }] },
  { id: "p2", workspaces: [{ path: "/c" }] },
  { id: "p3", hostId: "remote-1", workspaces: [{ path: "/c" }] },
] as unknown as ProjectInfo[];

const base = {
  origin: "shortcut" as const,
  activeSurface: "workspace" as const,
  activeWorkspaceKey: workspaceKey(null, "/c"),
  projects,
};

describe("resolvePaletteScope", () => {
  it("is global for the search origin", () => {
    expect(resolvePaletteScope({ ...base, origin: "search" })).toBeNull();
  });
  it("scopes to the project in a workspace", () => {
    expect(resolvePaletteScope(base)).toBe("p2");
  });
  it("scopes by host when two hosts share a path", () => {
    expect(
      resolvePaletteScope({ ...base, activeWorkspaceKey: workspaceKey("remote-1", "/c") }),
    ).toBe("p3");
    expect(
      resolvePaletteScope({ ...base, activeWorkspaceKey: workspaceKey("remote-2", "/c") }),
    ).toBeNull();
  });
  it("is global on home", () => {
    expect(resolvePaletteScope({ ...base, activeWorkspaceKey: workspaceKey(null, HOME_PATH) })).toBeNull();
  });
  it("is global on the tasks surface", () => {
    expect(resolvePaletteScope({ ...base, activeSurface: "tasks" })).toBeNull();
  });
  it("is global for an unknown or null workspace path", () => {
    expect(resolvePaletteScope({ ...base, activeWorkspaceKey: workspaceKey(null, "/zzz") })).toBeNull();
    expect(resolvePaletteScope({ ...base, activeWorkspaceKey: null })).toBeNull();
  });
});
