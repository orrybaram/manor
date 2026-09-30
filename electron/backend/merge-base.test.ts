import { describe, it, expect, vi } from "vitest";
import { MergeBaseCache, resolveBasePoint } from "./merge-base";

describe("resolveBasePoint", () => {
  it("reads HEAD and the ref from one rev-parse", async () => {
    const git = vi.fn(async () => "aaa\nbbb\n");
    await expect(resolveBasePoint(git, "origin/main")).resolves.toEqual({
      ref: "origin/main",
      head: "aaa",
      refSha: "bbb",
    });
    expect(git).toHaveBeenCalledWith(["rev-parse", "HEAD", "origin/main"]);
  });
});

describe("MergeBaseCache", () => {
  const point = { ref: "origin/main", head: "h1", refSha: "r1" };

  it("computes the merge-base only when the ref, HEAD or the ref's commit moves", async () => {
    const cache = new MergeBaseCache<string>();
    let n = 0;
    const git = vi.fn(async () => `base${++n}\n`);

    expect(await cache.get("/a", point, git)).toBe("base1");
    expect(await cache.get("/a", { ...point }, git)).toBe("base1");
    expect(git).toHaveBeenCalledTimes(1);
    expect(git).toHaveBeenCalledWith(["merge-base", "origin/main", "HEAD"]);

    expect(await cache.get("/a", { ...point, head: "h2" }, git)).toBe("base2");
    expect(await cache.get("/a", { ...point, head: "h2", refSha: "r2" }, git)).toBe("base3");
    expect(await cache.get("/a", { ...point, head: "h2", refSha: "r2", ref: "main" }, git)).toBe(
      "base4",
    );
    // Another workspace has its own entry.
    expect(await cache.get("/b", point, git)).toBe("base5");
  });

  it("forgets pruned workspaces", async () => {
    const cache = new MergeBaseCache<string>();
    const git = vi.fn(async () => "base\n");
    await cache.get("/a", point, git);
    await cache.get("/b", point, git);
    cache.prune((key) => key === "/b");
    await cache.get("/a", point, git);
    await cache.get("/b", point, git);
    expect(git).toHaveBeenCalledTimes(3);
  });
});
