/**
 * A workspace's files, answered by the host server that owns it: a
 * caller reading or saving a file in a file pane reaches this box's own
 * filesystem through the server's backend. See `harness.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { OpenFileWatcher } from "../../open-file-watcher";
import { contentHash } from "../../workspace-files";
import { eventually, useHostServerHarness, withGit } from "./harness";

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

  it("sends files.changed to a caller watching a file, and forgets its files when it goes", async () => {
    await withGit();
    const unwatch = vi.spyOn(OpenFileWatcher.prototype, "unwatch");
    await writeFile(path.join(h.tmp, "a.ts"), "one");
    const ws = { path: h.tmp, hostId: "local" };

    await h.serve();
    const owner = await h.owner();
    owner.subscribe("files", "changed");
    await owner.invoke("files", "watch", ws, ["a.ts"]);

    // Rewritten until the watcher, having taken the file's first checksum,
    // sees one move.
    const written = new Set<string>();
    let frame: unknown;
    for (let i = 0; !frame && i < 20; i++) {
      const content = `two-${i}`;
      written.add(contentHash(content));
      await writeFile(path.join(h.tmp, "a.ts"), content);
      await new Promise((r) => setTimeout(r, 400));
      frame = owner.frames.find((f) => f.kind === "event" && f.ns === "files" && f.event === "changed");
    }
    const event = (frame as { args: [{ workspace: unknown; path: string; hash: string }] }).args[0];
    expect(event).toMatchObject({ workspace: ws, path: "a.ts" });
    expect(written.has(event.hash)).toBe(true);

    expect(unwatch).not.toHaveBeenCalled();
    owner.client.dispose();
    await eventually(() => unwatch.mock.calls.length, (n) => n > 0, "the watch to end", 3_000);
  });
});
