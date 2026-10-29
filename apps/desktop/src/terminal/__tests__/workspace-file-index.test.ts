import { describe, expect, it, vi } from "vitest";
import { createWorkspaceFileIndex } from "../workspace-file-index";

const ws = { path: "/repo", hostId: "local" };

function setup(paths: string[] = ["src/a.ts", "src/b.ts"]) {
  let t = 0;
  const files = { paths };
  const list = vi.fn(async () => ({ paths: [...files.paths] }));
  const changed = new Map<string, () => void>();
  const index = createWorkspaceFileIndex(
    list,
    () => t,
    (workspace, onChange) => {
      changed.set(`${workspace.hostId}:${workspace.path}`, onChange);
      return () => {};
    },
  );
  return {
    index,
    list,
    files,
    advance: (ms: number) => (t += ms),
    /** The diff watcher reports `workspace` changed. */
    change: (workspace = ws) => changed.get(`${workspace.hostId}:${workspace.path}`)?.(),
  };
}

/** Lets a background listing settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createWorkspaceFileIndex", () => {
  it("answers the first candidate that is a file", async () => {
    const { index } = setup();
    expect(await index.find(ws, ["lib/b.ts", "src/b.ts"])).toBe("src/b.ts");
  });

  it("lists a workspace once for many lookups", async () => {
    const { index, list } = setup();
    await Promise.all([index.find(ws, ["src/a.ts"]), index.find(ws, ["src/b.ts"])]);
    await index.find(ws, ["src/a.ts"]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps one listing per workspace", async () => {
    const { index, list } = setup();
    await index.find(ws, ["src/a.ts"]);
    await index.find({ path: "/repo", hostId: "box" }, ["src/a.ts"]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not list again on a miss while the listing is fresh", async () => {
    const { index, list, advance } = setup();
    expect(await index.find(ws, ["v20.1"])).toBeNull();
    advance(10_000);
    expect(await index.find(ws, ["a@b.com"])).toBeNull();
    expect(await index.find(ws, ["1.23s"])).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("lists again when the workspace changes, answering from the old listing meanwhile", async () => {
    const { index, list, files, change } = setup();
    expect(await index.find(ws, ["src/new.ts"])).toBeNull();
    files.paths.push("src/new.ts");
    change();
    // This lookup answers now, from what it has; the new listing is for later ones.
    expect(await index.find(ws, ["src/new.ts"])).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
    await settle();
    expect(await index.find(ws, ["src/new.ts"])).toBe("src/new.ts");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("lists again on a miss at most every 30s, without waiting for it", async () => {
    const { index, list, files, advance } = setup();
    await index.find(ws, ["src/a.ts"]);
    files.paths.push("build/out.js");
    advance(31_000);
    // A hit doesn't list again by age alone.
    expect(await index.find(ws, ["src/a.ts"])).toBe("src/a.ts");
    expect(list).toHaveBeenCalledTimes(1);
    expect(await index.find(ws, ["build/out.js"])).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
    await settle();
    expect(await index.find(ws, ["build/out.js"])).toBe("build/out.js");
    expect(await index.find(ws, ["nope.ts"])).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("lists a changed workspace once, however many lookups come in meanwhile", async () => {
    const { index, list, change } = setup();
    await index.find(ws, ["src/a.ts"]);
    change();
    await Promise.all([index.find(ws, ["x.ts"]), index.find(ws, ["y.ts"])]);
    await settle();
    await index.find(ws, ["z.ts"]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("backs off after a failed listing, 30s then 60s, keeping the links it had", async () => {
    let t = 0;
    const list = vi
      .fn()
      .mockResolvedValueOnce({ paths: ["src/a.ts"] })
      .mockRejectedValueOnce(new Error("host away"))
      .mockRejectedValueOnce(new Error("host away"))
      .mockResolvedValue({ paths: ["src/a.ts", "src/b.ts"] });
    const index = createWorkspaceFileIndex(list, () => t);
    await index.find(ws, ["src/a.ts"]);
    t += 30_000;
    await index.find(ws, ["src/b.ts"]); // miss: lists, and fails
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(await index.find(ws, ["src/a.ts"])).toBe("src/a.ts");
    t += 29_000;
    await index.find(ws, ["src/b.ts"]);
    expect(list).toHaveBeenCalledTimes(2);
    t += 1_000;
    await index.find(ws, ["src/b.ts"]); // fails again: next try in 60s
    await settle();
    expect(list).toHaveBeenCalledTimes(3);
    t += 59_000;
    await index.find(ws, ["src/b.ts"]);
    expect(list).toHaveBeenCalledTimes(3);
    t += 1_000;
    await index.find(ws, ["src/b.ts"]);
    await settle();
    expect(list).toHaveBeenCalledTimes(4);
    expect(await index.find(ws, ["src/b.ts"])).toBe("src/b.ts");
  });

  it("has no links while the first listing fails", async () => {
    const list = vi.fn().mockRejectedValue(new Error("host away"));
    const index = createWorkspaceFileIndex(list, () => 0);
    expect(await index.find(ws, ["src/a.ts"])).toBeNull();
    expect(await index.find(ws, ["src/a.ts"])).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not list for no candidates", async () => {
    const { index, list } = setup();
    expect(await index.find(ws, [])).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});
