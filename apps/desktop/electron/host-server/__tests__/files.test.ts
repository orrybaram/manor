/**
 * A workspace's files, answered by the host server that owns it: a
 * caller reading or saving a file in a file pane reaches this box's own
 * filesystem through the server's backend. See `harness.ts`.
 */

import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { contentHash } from "../../workspace-files";
import { useHostServerHarness, withGit } from "./harness";

describe("host server: a workspace's files", () => {
  const h = useHostServerHarness();

  it("lists, reads, saves and creates files on this box", async () => {
    // The harness mocks `child_process` for the daemon's PTYs; the commands are real.
    await withGit();
    await writeFile(path.join(h.tmp, "a.ts"), "one");
    const ws = { path: h.tmp, hostId: "local" };

    await h.serve();
    const owner = await h.owner();

    const listed = await owner.invoke<{ paths: string[] }>("files", "list", ws);
    expect(listed.paths).toContain("a.ts");
    expect(await owner.invoke("files", "read", ws, "a.ts")).toEqual({
      ok: true,
      content: "one",
      hash: contentHash("one"),
    });
    expect(await owner.invoke("files", "write", ws, "a.ts", "two", contentHash("one"))).toEqual({
      ok: true,
      hash: contentHash("two"),
    });
    expect(await owner.invoke("files", "write", ws, "a.ts", "three", contentHash("one"))).toMatchObject({
      ok: false,
      reason: "changed-on-disk",
    });
    expect(await owner.invoke("files", "create", ws, "b.ts")).toMatchObject({ ok: true });

    expect(await readFile(path.join(h.tmp, "a.ts"), "utf-8")).toBe("two");
    expect(await readFile(path.join(h.tmp, "b.ts"), "utf-8")).toBe("");
  });
});
