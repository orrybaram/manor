import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecShellBackend } from "../../../backend/exec-shell";
import { localExec } from "../../../backend/exec";
import { contentHash } from "../../../workspace-files";
import { DESKTOP_TABLE } from "../../handlers";
import { localCtx } from "../../method";
import { filesCreate, filesList, filesRead, filesWrite, type FilesDeps } from "../files";

let tmp: string;

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "manor-files-handler-")));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A registry whose every host runs commands on this machine, recording which was asked. */
function setup() {
  const shell = new ExecShellBackend(localExec);
  const get = vi.fn((_hostId: string) => ({ shell }));
  const deps = { backendRegistry: { get } } as unknown as FilesDeps;
  return { ctx: localCtx(deps), get };
}

describe("files handlers", () => {
  it("run on the workspace's own host", async () => {
    const { ctx, get } = setup();
    await writeFile(path.join(tmp, "a.ts"), "hi");
    const ws = { path: tmp, hostId: "box" };

    expect(await filesList(ctx, ws)).toMatchObject({ paths: ["a.ts"] });
    expect(await filesRead(ctx, ws, "a.ts")).toMatchObject({ ok: true, content: "hi" });
    expect(await filesWrite(ctx, ws, "a.ts", "bye", contentHash("hi"))).toMatchObject({ ok: true });
    expect(await filesCreate(ctx, ws, "b.ts")).toMatchObject({ ok: true });

    expect(get.mock.calls.every(([hostId]) => hostId === "box")).toBe(true);
    expect(await readFile(path.join(tmp, "a.ts"), "utf-8")).toBe("bye");
  });

  it("treat a null expectedHash, as JSON sends an absent one, as none", async () => {
    const { ctx } = setup();
    await writeFile(path.join(tmp, "a.ts"), "theirs");
    const result = await filesWrite(ctx, { path: tmp, hostId: "local" }, "a.ts", "mine", null as unknown as string);
    expect(result).toMatchObject({ ok: true });
  });

  it("refuse a malformed workspace or path before reaching any host", async () => {
    const { ctx, get } = setup();
    const bad = [
      () => filesList(ctx, "/tmp" as never),
      () => filesList(ctx, { path: "relative", hostId: "local" }),
      () => filesRead(ctx, { path: tmp } as never, "a.ts"),
      () => filesRead(ctx, { path: tmp, hostId: "local" }, 3 as never),
      () => filesWrite(ctx, { path: tmp, hostId: "local" }, "a.ts", {} as never),
    ];
    for (const call of bad) expect(call).toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it("mark the writes mutating and the reads not", () => {
    expect(DESKTOP_TABLE.mutating.has("files.write")).toBe(true);
    expect(DESKTOP_TABLE.mutating.has("files.create")).toBe(true);
    expect(DESKTOP_TABLE.mutating.has("files.list")).toBe(false);
    expect(DESKTOP_TABLE.mutating.has("files.read")).toBe(false);
  });
});
