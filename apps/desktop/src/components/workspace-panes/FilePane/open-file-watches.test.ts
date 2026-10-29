import { describe, it, expect, vi } from "vitest";
import { createOpenFileWatches } from "./open-file-watches";

const ws = { path: "/repo", hostId: "local" };

describe("openFileWatches", () => {
  it("watches the union of every pane's open file in a workspace", () => {
    const watch = vi.fn();
    const watches = createOpenFileWatches(watch);
    watches.set(ws, "pane-a", "src/a.ts");
    watches.set(ws, "pane-b", "src/b.ts");
    expect(watch).toHaveBeenLastCalledWith(ws, ["src/a.ts", "src/b.ts"]);

    // One pane switching file or closing leaves the other's watched.
    watches.set(ws, "pane-a", "src/c.ts");
    expect(watch).toHaveBeenLastCalledWith(ws, ["src/b.ts", "src/c.ts"]);
    watches.set(ws, "pane-b", null);
    expect(watch).toHaveBeenLastCalledWith(ws, ["src/c.ts"]);
    watches.set(ws, "pane-a", null);
    expect(watch).toHaveBeenLastCalledWith(ws, []);
  });

  it("keeps workspaces apart, a remote one with the same path included", () => {
    const watch = vi.fn();
    const watches = createOpenFileWatches(watch);
    const remote = { path: "/repo", hostId: "box" };
    watches.set(ws, "pane-a", "a.ts");
    watches.set(remote, "pane-b", "b.ts");
    expect(watch).toHaveBeenLastCalledWith(remote, ["b.ts"]);
  });

  it("sends nothing when nothing changed", () => {
    const watch = vi.fn();
    const watches = createOpenFileWatches(watch);
    watches.set(ws, "pane-a", null);
    watches.set(ws, "pane-a", "a.ts");
    watches.set(ws, "pane-a", "a.ts");
    expect(watch).toHaveBeenCalledTimes(1);
  });
});
