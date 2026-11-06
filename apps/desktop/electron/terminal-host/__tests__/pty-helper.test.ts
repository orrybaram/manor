import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../xterm-env-polyfill";
import { MSG, encodeFrame } from "../pty-subprocess-ipc";

/** A fake helper process: stdin/stdout streams and exit/error events. */
function fakeChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.pid = pid;
  child.kill = vi.fn();
  return child;
}

const children: {
  kind: "fork" | "spawn";
  file: string;
  child: ReturnType<typeof fakeChild>;
}[] = [];
/** When set, the mocked spawn throws it, as child_process.spawn does for most errnos. */
let spawnThrows: Error | null = null;

vi.mock("node:child_process", () => ({
  fork: vi.fn((file: string) => {
    const child = fakeChild(100 + children.length);
    children.push({ kind: "fork", file, child });
    return child;
  }),
  spawn: vi.fn((file: string) => {
    if (spawnThrows) throw spawnThrows;
    const child = fakeChild(200 + children.length);
    children.push({ kind: "spawn", file, child });
    return child;
  }),
}));
vi.mock("../../shell", () => ({
  ShellManager: {
    zdotdirPath: () => "/tmp/manor-test-zdotdir",
    setupZdotdir: () => "/tmp/manor-test-zdotdir",
    realZdotdir: () => "/tmp",
  },
}));

import {
  choosePtyHelper,
  markNativeHelperBroken,
  nativeHelperCandidates,
  resetPtyHelperState,
} from "../pty-helper";
import { Session } from "../session";

describe("choosePtyHelper", () => {
  beforeEach(() => resetPtyHelperState());
  const dir =
    "/Applications/Manor.app/Contents/Resources/app.asar/dist-electron";

  it("finds the shipped binary in app.asar.unpacked, by platform and arch first", () => {
    expect(nativeHelperCandidates(dir, "darwin", "arm64")).toEqual([
      "/Applications/Manor.app/Contents/Resources/app.asar.unpacked/dist-electron/manor-pty-darwin-arm64",
      "/Applications/Manor.app/Contents/Resources/app.asar.unpacked/dist-electron/manor-pty-darwin-universal",
      "/Applications/Manor.app/Contents/Resources/app.asar/native/manor-pty/target/release/manor-pty",
    ]);
  });

  it("looks beside a bundle that isn't in an archive (remote hosts)", () => {
    expect(
      nativeHelperCandidates("/home/u/.manor/host", "linux", "x64")[0],
    ).toBe("/home/u/.manor/host/manor-pty-linux-x64");
  });

  it("picks the native helper when one can run", () => {
    const got = choosePtyHelper({
      env: {},
      dir,
      platform: "darwin",
      arch: "x64",
      isExecutable: (f) => f.endsWith("manor-pty-darwin-universal"),
    });
    expect(got).toEqual({
      kind: "native",
      path: expect.stringContaining("manor-pty-darwin-universal"),
    });
  });

  it("falls back to pty-subprocess.js when none is shipped for this platform", () => {
    const got = choosePtyHelper({
      env: {},
      dir,
      platform: "freebsd",
      arch: "x64",
      isExecutable: () => false,
    });
    expect(got).toEqual({ kind: "node", path: `${dir}/pty-subprocess.js` });
  });

  it("MANOR_PTY_HELPER=node forces Node", () => {
    const got = choosePtyHelper({
      env: { MANOR_PTY_HELPER: "node" },
      dir,
      isExecutable: () => true,
    });
    expect(got.kind).toBe("node");
  });

  it("MANOR_PTY_HELPER_PATH names the binary", () => {
    const got = choosePtyHelper({
      env: { MANOR_PTY_HELPER_PATH: "/tmp/manor-pty" },
      dir,
      isExecutable: (f) => f === "/tmp/manor-pty",
    });
    expect(got).toEqual({ kind: "native", path: "/tmp/manor-pty" });
  });

  it("stays on Node once the native helper has failed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    markNativeHelperBroken("/x/manor-pty", "test");
    expect(
      choosePtyHelper({ env: {}, dir, isExecutable: () => true }).kind,
    ).toBe("node");
  });
});

describe("Session with the native helper", () => {
  beforeEach(() => {
    resetPtyHelperState();
    children.length = 0;
    process.env.MANOR_PTY_HELPER_PATH = process.execPath; // anything executable
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  function spawnedPayload(
    child: ReturnType<typeof fakeChild>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      child.stdin.on("data", (buf: Buffer) => {
        if (buf[0] === MSG.SPAWN)
          resolve(JSON.parse(buf.subarray(5).toString()));
      });
    });
  }

  it("spawns manor-pty and sends it the agent names", async () => {
    const session = new Session(
      "s1",
      "/tmp",
      80,
      24,
      fs.mkdtempSync(path.join(os.tmpdir(), "manor-pty-helper-")),
    );
    session.spawn();
    expect(children.map((c) => c.kind)).toEqual(["spawn"]);
    const payload = spawnedPayload(children[0].child);
    children[0].child.stdout.write(encodeFrame(MSG.READY));
    expect((await payload).agentNames).toEqual([
      "claude",
      "opencode",
      "codex",
      "pi",
    ]);
  });

  it("falls back to pty-subprocess.js when manor-pty can't start", async () => {
    const session = new Session(
      "s2",
      "/tmp",
      80,
      24,
      fs.mkdtempSync(path.join(os.tmpdir(), "manor-pty-helper-")),
    );
    session.spawn();
    children[0].child.emit(
      "error",
      Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
    );
    expect(children.map((c) => c.kind)).toEqual(["spawn", "fork"]);
    expect(children[1].file).toMatch(/pty-subprocess\.js$/);
    const payload = spawnedPayload(children[1].child);
    children[1].child.stdout.write(encodeFrame(MSG.READY));
    expect((await payload).shell).toBeTruthy();
    expect(session.alive).toBe(true);
  });

  it("falls back when spawning manor-pty throws (ETXTBSY, EBADARCH, ...)", () => {
    spawnThrows = Object.assign(new Error("spawn ETXTBSY"), {
      code: "ETXTBSY",
    });
    try {
      const session = new Session(
        "s6",
        "/tmp",
        80,
        24,
        fs.mkdtempSync(path.join(os.tmpdir(), "manor-pty-helper-")),
      );
      expect(() => session.spawn()).not.toThrow();
      expect(children.map((c) => c.kind)).toEqual(["fork"]);
    } finally {
      spawnThrows = null;
    }
  });

  it("falls back when manor-pty exits before Ready, and later sessions skip it", () => {
    const a = new Session(
      "s3",
      "/tmp",
      80,
      24,
      fs.mkdtempSync(path.join(os.tmpdir(), "manor-pty-helper-")),
    );
    a.spawn();
    children[0].child.emit("exit", 1, null);
    expect(children.map((c) => c.kind)).toEqual(["spawn", "fork"]);
    const b = new Session(
      "s4",
      "/tmp",
      80,
      24,
      fs.mkdtempSync(path.join(os.tmpdir(), "manor-pty-helper-")),
    );
    b.spawn();
    expect(children.map((c) => c.kind)).toEqual(["spawn", "fork", "fork"]);
  });

  it("an exit after Ready is the pane's exit, not a fallback", () => {
    const session = new Session(
      "s5",
      "/tmp",
      80,
      24,
      fs.mkdtempSync(path.join(os.tmpdir(), "manor-pty-helper-")),
    );
    session.spawn();
    children[0].child.stdout.write(encodeFrame(MSG.READY));
    children[0].child.emit("exit", 0, null);
    expect(children.map((c) => c.kind)).toEqual(["spawn"]);
    expect(session.alive).toBe(false);
  });
});
