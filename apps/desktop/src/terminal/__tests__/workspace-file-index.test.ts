import { describe, expect, it, vi } from "vitest";
import { createWorkspaceFileIndex } from "../workspace-file-index";

const ws = { path: "/repo", hostId: "local" };

function setup(paths: string[] = ["src/a.ts", "src/b.ts"]) {
  let t = 0;
  const files = { paths };
  const list = vi.fn(async () => ({ paths: [...files.paths] }));
  const index = createWorkspaceFileIndex(list, () => t);
  return { index, list, files, advance: (ms: number) => (t += ms) };
}

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

  it("lists again on a miss once the listing is a few seconds old", async () => {
    const { index, list, files, advance } = setup();
    expect(await index.find(ws, ["src/new.ts"])).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    files.paths.push("src/new.ts");
    // Too soon: a run of misses doesn't list once each.
    expect(await index.find(ws, ["src/new.ts"])).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    advance(5_000);
    expect(await index.find(ws, ["src/new.ts"])).toBe("src/new.ts");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("lists again when the listing is stale, even on a hit", async () => {
    const { index, list, advance } = setup();
    await index.find(ws, ["src/a.ts"]);
    advance(60_000);
    await index.find(ws, ["src/a.ts"]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("has no links while the listing fails, and asks again next time", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("host away"))
      .mockResolvedValue({ paths: ["src/a.ts"] });
    const index = createWorkspaceFileIndex(list, () => 0);
    expect(await index.find(ws, ["src/a.ts"])).toBeNull();
    expect(await index.find(ws, ["src/a.ts"])).toBe("src/a.ts");
  });

  it("does not list for no candidates", async () => {
    const { index, list } = setup();
    expect(await index.find(ws, [])).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});
