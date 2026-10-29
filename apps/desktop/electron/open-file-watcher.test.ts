import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecShellBackend } from "./backend/exec-shell";
import { localExec } from "./backend/exec";
import { OpenFileWatcher, type FileChangedEvent } from "./open-file-watcher";
import { contentHash, HOST_SCRIPTS, type FilesBackend } from "./workspace-files";

const INTERVAL_MS = 40;

let tmp: string;
let watcher: OpenFileWatcher;
let events: Array<{ to: string | null; event: FileChangedEvent }>;
let hostsAsked: string[];
/** How many of the next file reads fail, as a host that hiccups would. */
let failingReads: number;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Until `check` passes, or fail after a while. */
async function eventually(check: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(INTERVAL_MS / 2);
    }
  }
}

/** Long enough for every host to have been scanned a few times. */
const settle = () => sleep(INTERVAL_MS * 5);

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "manor-open-files-")));
  events = [];
  hostsAsked = [];
  failingReads = 0;
  const local = new ExecShellBackend(localExec);
  const shell: FilesBackend["shell"] = {
    exec: (cmd, args, opts) => {
      if (args[1] === HOST_SCRIPTS.read && failingReads > 0) {
        failingReads--;
        return Promise.reject(new Error("the host timed out"));
      }
      return local.exec(cmd, args, opts);
    },
    writeFile: (p, data) => local.writeFile(p, data),
  };
  watcher = new OpenFileWatcher(
    {
      get: (hostId) => {
        hostsAsked.push(hostId);
        return { shell };
      },
    },
    {
      intervalMs: INTERVAL_MS,
      publishTo: ((to: string | null, _ns: "files", _event: "changed", event: FileChangedEvent) => {
        events.push({ to, event });
      }) as never,
    },
  );
});

afterEach(async () => {
  watcher.dispose();
  await rm(tmp, { recursive: true, force: true });
});

describe("OpenFileWatcher", () => {
  it("tells the connection that has a file open when it changes on disk, with its new hash", async () => {
    await writeFile(path.join(tmp, "a.ts"), "one");
    await writeFile(path.join(tmp, "b.ts"), "b");
    const ws = { path: tmp, hostId: "box" };
    watcher.watch("window-1", ws, ["a.ts"]);
    watcher.watch("window-2", ws, ["b.ts"]);
    await settle();
    expect(events).toEqual([]);

    await writeFile(path.join(tmp, "a.ts"), "two");

    await eventually(() =>
      expect(events).toEqual([
        { to: "window-1", event: { workspace: ws, path: "a.ts", hash: contentHash("two") } },
      ]),
    );
    expect(hostsAsked.every((h) => h === "box")).toBe(true);
  });

  it("reports a deleted file with no hash", async () => {
    await writeFile(path.join(tmp, "a.ts"), "one");
    watcher.watch("w", { path: tmp, hostId: "local" }, ["a.ts"]);
    await settle();

    await rm(path.join(tmp, "a.ts"));

    await eventually(() => expect(events.map((e) => e.event.hash)).toEqual([null]));
  });

  it("tells every connection that has the file open", async () => {
    await writeFile(path.join(tmp, "a.ts"), "one");
    const ws = { path: tmp, hostId: "local" };
    watcher.watch("w1", ws, ["a.ts"]);
    watcher.watch("w2", ws, ["a.ts"]);
    await settle();

    await writeFile(path.join(tmp, "a.ts"), "two");

    await eventually(() => expect(events.map((e) => e.to).sort()).toEqual(["w1", "w2"]));
  });

  it("sends nothing once the connection unwatches", async () => {
    await writeFile(path.join(tmp, "a.ts"), "one");
    watcher.watch("w", { path: tmp, hostId: "local" }, ["a.ts"]);
    await settle();

    watcher.unwatch("w");
    await writeFile(path.join(tmp, "a.ts"), "two");
    await settle();

    expect(events).toEqual([]);
  });

  it("drops a file the connection no longer lists, keeping the rest", async () => {
    await writeFile(path.join(tmp, "a.ts"), "a");
    await writeFile(path.join(tmp, "b.ts"), "b");
    const ws = { path: tmp, hostId: "local" };
    watcher.watch("w", ws, ["a.ts", "b.ts"]);
    await settle();

    watcher.watch("w", ws, ["b.ts"]);
    await writeFile(path.join(tmp, "a.ts"), "a2");
    await writeFile(path.join(tmp, "b.ts"), "b2");

    await eventually(() => expect(events.map((e) => e.event.path)).toEqual(["b.ts"]));
    await settle();
    expect(events.map((e) => e.event.path)).toEqual(["b.ts"]);
  });

  it("ignores a path that would leave the workspace", async () => {
    await writeFile(path.join(tmp, "outside.txt"), "x");
    const inner = path.join(tmp, "ws");
    await mkdir(inner);
    watcher.watch("w", { path: inner, hostId: "local" }, ["../outside.txt"]);
    await settle();
    await writeFile(path.join(tmp, "outside.txt"), "y");
    await settle();

    expect(events).toEqual([]);
    expect(hostsAsked).toEqual([]);
  });

  it("does not report the same content twice", async () => {
    await writeFile(path.join(tmp, "a.ts"), "one");
    watcher.watch("w", { path: tmp, hostId: "local" }, ["a.ts"]);
    await settle();

    await writeFile(path.join(tmp, "a.ts"), "two");
    await eventually(() => expect(events).toHaveLength(1));
    await settle();

    expect(events).toHaveLength(1);
  });

  it("retries a changed file whose read failed, rather than losing the change", async () => {
    await writeFile(path.join(tmp, "a.ts"), "one");
    watcher.watch("w", { path: tmp, hostId: "local" }, ["a.ts"]);
    await settle();
    failingReads = 1;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    await writeFile(path.join(tmp, "a.ts"), "two");

    try {
      await eventually(() => expect(events.map((e) => e.event.hash)).toEqual([contentHash("two")]));
      expect(failingReads).toBe(0);
      expect(quiet).toHaveBeenCalledWith(expect.stringMatching(/could not read a changed file/), expect.anything());
    } finally {
      quiet.mockRestore();
    }
  });
});
