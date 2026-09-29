import { describe, it, expect } from "vitest";
import { resolvePaletteScope } from "../scope";
import { HOME_PATH } from "../../../lib/home-path";
import type { ProjectInfo } from "../../../store/project-store";

const projects = [
  { id: "p1", workspaces: [{ path: "/a" }, { path: "/b" }] },
  { id: "p2", workspaces: [{ path: "/c" }] },
] as unknown as ProjectInfo[];

const base = {
  origin: "shortcut" as const,
  activeSurface: "workspace" as const,
  activeWorkspacePath: "/c",
  projects,
};

describe("resolvePaletteScope", () => {
  it("is global for the search origin", () => {
    expect(resolvePaletteScope({ ...base, origin: "search" })).toBeNull();
  });
  it("scopes to the project in a workspace", () => {
    expect(resolvePaletteScope(base)).toBe("p2");
  });
  it("is global on home", () => {
    expect(resolvePaletteScope({ ...base, activeWorkspacePath: HOME_PATH })).toBeNull();
  });
  it("is global on tasks and projects surfaces", () => {
    expect(resolvePaletteScope({ ...base, activeSurface: "tasks" })).toBeNull();
    expect(resolvePaletteScope({ ...base, activeSurface: "projects" })).toBeNull();
  });
  it("is global for an unknown or null workspace path", () => {
    expect(resolvePaletteScope({ ...base, activeWorkspacePath: "/zzz" })).toBeNull();
    expect(resolvePaletteScope({ ...base, activeWorkspacePath: null })).toBeNull();
  });
});
