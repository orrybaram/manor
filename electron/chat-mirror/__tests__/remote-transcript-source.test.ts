import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localExec } from "../../backend/exec";
import { ChatMirror, transcriptSources, type PaneAgent } from "../mirror";
import {
  LINE_LENGTH_SCRIPT,
  MAX_READ_BYTES,
  READ_SCRIPT,
  RemoteTranscriptSource,
  type TranscriptExec,
} from "../remote-transcript-source";
import { LocalTranscriptSource } from "../transcript-source";

const T = "2026-01-01T00:00:00.000Z";
const PANE = "pane-1";

function user(uuid: string, text: string): string {
  return (
    JSON.stringify({ timestamp: T, type: "user", uuid, message: { role: "user", content: text } }) +
    "\n"
  );
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** The shells the script must behave the same under, of those installed here. */
function shells(): { name: string; cmd: string; flags: string[] }[] {
  const found = [{ name: "/bin/sh", cmd: "/bin/sh", flags: [] as string[] }];
  const has = (bin: string) => {
    try {
      execFileSync("/bin/sh", ["-c", 'command -v "$1"', "sh", bin], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (has("bash")) found.push({ name: "bash --posix", cmd: "bash", flags: ["--posix"] });
  if (has("dash")) found.push({ name: "dash", cmd: "dash", flags: [] });
  return found;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-transcript-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string | Buffer = ""): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe.each(shells())("READ_SCRIPT under $name", ({ cmd, flags }) => {
  /** `sh -c` exactly as the source runs it, under this shell. */
  const exec: TranscriptExec = {
    file: (_sh, args, opts) => localExec.file(cmd, [...flags, ...args], opts),
  };
  const source = new RemoteTranscriptSource(() => exec);

  const LINE1 = "abc\n";
  const LINE2 = "日本 😀 中文\n";
  const LINE3 = "xyz\n";
  const ALL = LINE1 + LINE2 + LINE3;

  it("reports a missing file as size 0 with no data", async () => {
    expect(await source.read(path.join(dir, "missing.jsonl"), 0)).toEqual({
      ok: true,
      size: 0,
      data: "",
    });
  });

  it("reads the whole file from offset 0", async () => {
    const p = file("t.jsonl", ALL);
    expect(await source.read(p, 0)).toEqual({ ok: true, size: bytes(ALL), data: ALL });
  });

  it("reads from a mid-file offset just before a multi-byte line", async () => {
    const p = file("t.jsonl", ALL);
    expect(await source.read(p, bytes(LINE1))).toEqual({
      ok: true,
      size: bytes(ALL),
      data: LINE2 + LINE3,
    });
  });

  it("reads nothing at the end", async () => {
    const p = file("t.jsonl", ALL);
    expect(await source.read(p, bytes(ALL))).toEqual({ ok: true, size: bytes(ALL), data: "" });
  });

  it("reports a file that shrank below the offset by its new size", async () => {
    const p = file("t.jsonl", LINE1);
    expect(await source.read(p, bytes(ALL))).toEqual({ ok: true, size: bytes(LINE1), data: "" });
  });

  it("passes awkward paths through untouched", async () => {
    const p = file(`it's "a" $(echo x) file.jsonl`, LINE1);
    expect(await source.read(p, 0)).toEqual({ ok: true, size: bytes(LINE1), data: LINE1 });
  });

  describe("a line longer than the cap", () => {
    const CAP = 64;
    const capped = new RemoteTranscriptSource(() => exec, { maxReadBytes: CAP });
    const LONG = "日本".repeat(40) + "\n";

    it("is measured on the remote and skipped once complete", async () => {
      expect(bytes(LONG)).toBeGreaterThan(CAP);
      const p = file("t.jsonl", LINE1 + LONG + LINE3);
      expect(await capped.read(p, bytes(LINE1))).toEqual({
        ok: true,
        size: bytes(LINE1 + LONG + LINE3),
        data: "",
        skip: bytes(LONG),
      });
    });

    it("is left alone while it is still being written", async () => {
      const p = file("t.jsonl", LINE1 + LONG.slice(0, -1));
      const result = await capped.read(p, bytes(LINE1));
      expect(result).toMatchObject({ ok: true, size: bytes(LINE1 + LONG) - 1 });
      expect(result).not.toHaveProperty("skip");
    });

    it("is not skipped when the capped read holds a newline", async () => {
      const p = file("t.jsonl", LINE1 + LONG);
      const result = await capped.read(p, 0);
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.data.startsWith(LINE1)).toBe(true);
      expect(result).not.toHaveProperty("skip");
    });
  });
});

describe("LINE_LENGTH_SCRIPT", () => {
  it("is passed the path and offset as arguments, after a capped read with no newline", async () => {
    const calls: string[][] = [];
    const exec: TranscriptExec = {
      file: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return calls.length === 1
          ? { stdout: "1000\nxxxxxxxxxx", stderr: "" }
          : { stdout: "       1     900\n", stderr: "" };
      },
    };
    const source = new RemoteTranscriptSource(() => exec, { maxReadBytes: 10 });
    expect(await source.read("/x/$HOME/t.jsonl", 42)).toEqual({
      ok: true,
      size: 1000,
      data: "",
      skip: 900,
    });
    expect(calls[1]).toEqual(["sh", "-c", LINE_LENGTH_SCRIPT, "sh", "/x/$HOME/t.jsonl", "42"]);
  });

  it("is an error when the counts can't be read", async () => {
    let n = 0;
    const exec: TranscriptExec = {
      file: async () => ({ stdout: n++ === 0 ? "1000\nxxxxxxxxxx" : "nope", stderr: "" }),
    };
    const source = new RemoteTranscriptSource(() => exec, { maxReadBytes: 10 });
    expect(await source.read("/t", 0)).toMatchObject({ ok: false });
  });
});

describe("READ_SCRIPT", () => {
  it("caps a read at MAX_READ_BYTES", async () => {
    const size = MAX_READ_BYTES + 1000;
    const p = file("big.jsonl", Buffer.alloc(size, "a"));
    const result = await new RemoteTranscriptSource(() => localExec).read(p, 10);
    expect(result).toMatchObject({ ok: true, size });
    expect(result.ok && result.data.length).toBe(MAX_READ_BYTES);
  });

  it("is passed the path and offset as arguments, never inlined", async () => {
    const calls: string[][] = [];
    const exec: TranscriptExec = {
      file: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { stdout: "0\n", stderr: "" };
      },
    };
    await new RemoteTranscriptSource(() => exec).read("/x/$HOME/t.jsonl", 42);
    expect(calls).toEqual([["sh", "-c", READ_SCRIPT, "sh", "/x/$HOME/t.jsonl", "42"]]);
  });
});

describe("RemoteTranscriptSource errors", () => {
  it("is an error, not a throw, when the host is offline", async () => {
    expect(await new RemoteTranscriptSource(() => null).read("/t", 0)).toEqual({
      ok: false,
      error: "host offline",
    });
  });

  it("is an error when the exec rejects or times out", async () => {
    const exec: TranscriptExec = {
      file: () => Promise.reject(new Error("Command failed: timed out")),
    };
    expect(await new RemoteTranscriptSource(() => exec).read("/t", 0)).toEqual({
      ok: false,
      error: "Command failed: timed out",
    });
  });

  it.each([[""], ["nope\n"], ["12abc\ndata"], ["-1\n"]])(
    "is an error when the size line is %j",
    async (stdout) => {
      const exec: TranscriptExec = { file: async () => ({ stdout, stderr: "" }) };
      const result = await new RemoteTranscriptSource(() => exec).read("/t", 0);
      expect(result.ok).toBe(false);
    },
  );
});

describe("transcriptSources", () => {
  it("reads a local agent locally and a remote one through its host's exec, per host", async () => {
    const local = new LocalTranscriptSource();
    const asked: string[] = [];
    const sourceFor = transcriptSources(local, (hostId) => {
      asked.push(hostId);
      return null;
    });
    expect(sourceFor({ hostId: "local", transcriptPath: "/t" })).toBe(local);
    const devbox = sourceFor({ hostId: "devbox", transcriptPath: "/t" });
    expect(devbox).toBeInstanceOf(RemoteTranscriptSource);
    expect(sourceFor({ hostId: "devbox", transcriptPath: "/u" })).toBe(devbox);
    expect(sourceFor({ hostId: "other", transcriptPath: "/t" })).not.toBe(devbox);
    expect(await devbox.read("/t", 0)).toMatchObject({ ok: false });
    expect(asked).toEqual(["devbox"]);
  });
});

describe("ChatMirror over RemoteTranscriptSource", () => {
  let agent: PaneAgent | null;
  let mirror: ChatMirror;
  /** The offset each read asked for. */
  let offsets: number[];

  beforeEach(() => {
    agent = null;
    offsets = [];
    const exec: TranscriptExec = {
      file: (cmd, args, opts) => {
        offsets.push(Number(args[4]));
        return localExec.file(cmd, args, opts);
      },
    };
    const remote = new RemoteTranscriptSource(() => exec);
    mirror = new ChatMirror({
      // The source is forced remote whatever the agent's host says.
      agentForPane: (paneId) => (paneId === PANE ? agent : null),
      write: () => {},
      publish: () => {},
      sourceFor: () => remote,
    });
  });

  afterEach(() => mirror.dispose());

  it("advances by the byte length of complete lines across a split multi-byte line", async () => {
    const first = user("u1", "héllo");
    const second = user("u2", "日本 😀");
    const cut = Buffer.from(second).indexOf(Buffer.from("😀")) + 2;
    const p = file("t.jsonl", Buffer.concat([Buffer.from(first), Buffer.from(second).subarray(0, cut)]));
    agent = { hostId: "local", transcriptPath: p };

    expect(await mirror.getHistory(PANE)).toEqual({
      ok: true,
      entries: [{ kind: "user", id: "u1", ts: T, text: "héllo" }],
    });

    fs.appendFileSync(p, Buffer.from(second).subarray(cut));
    expect(await mirror.getHistory(PANE)).toEqual({
      ok: true,
      entries: [
        { kind: "user", id: "u1", ts: T, text: "héllo" },
        { kind: "user", id: "u2", ts: T, text: "日本 😀" },
      ],
    });

    await mirror.getHistory(PANE);
    expect(offsets).toEqual([0, bytes(first), bytes(first + second)]);
  });

  it("takes a backlog over the cap in several reads, splitting a character at the cap", async () => {
    const tail = user("u2", "😀 after the cap");
    // Pad the first line so the cap falls inside the emoji of the second.
    const base = bytes(user("u1", ""));
    const emojiAt = Buffer.from(tail).indexOf(Buffer.from("😀"));
    const first = user("u1", "a".repeat(MAX_READ_BYTES - base - emojiAt - 2));
    expect(bytes(first) + emojiAt + 2).toBe(MAX_READ_BYTES);
    const p = file("t.jsonl", first + tail);
    agent = { hostId: "local", transcriptPath: p };

    expect(await mirror.getHistory(PANE)).toMatchObject({ ok: true, entries: [{ id: "u1" }] });
    expect(await mirror.getHistory(PANE)).toMatchObject({
      ok: true,
      entries: [{ id: "u1" }, { id: "u2", text: "😀 after the cap" }],
    });
    expect(offsets).toEqual([0, bytes(first)]);
  });

  it("steps over a line longer than the cap, with no entry, and reads on", async () => {
    const CAP = 256;
    const exec: TranscriptExec = { file: (cmd, args, opts) => localExec.file(cmd, args, opts) };
    const capped = new RemoteTranscriptSource(() => exec, { maxReadBytes: CAP });
    const m = new ChatMirror({
      agentForPane: () => agent,
      write: () => {},
      publish: () => {},
      sourceFor: () => capped,
    });
    try {
      const huge = user("big", "😀".repeat(CAP));
      expect(bytes(huge)).toBeGreaterThan(CAP);
      const p = file("t.jsonl", user("u1", "hi") + huge + user("u2", "after"));
      agent = { hostId: "devbox", transcriptPath: p };

      expect(await m.getHistory(PANE)).toMatchObject({ ok: true, entries: [{ id: "u1" }] });
      expect(await m.getHistory(PANE)).toMatchObject({
        ok: true,
        entries: [{ id: "u1" }, { id: "u2", text: "after" }],
      });
      fs.appendFileSync(p, user("u3", "later"));
      expect(await m.getHistory(PANE)).toMatchObject({
        ok: true,
        entries: [{ id: "u1" }, { id: "u2" }, { id: "u3" }],
      });
    } finally {
      m.dispose();
    }
  });
});
