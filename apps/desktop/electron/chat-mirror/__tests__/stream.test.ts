import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../adapters/claude";
import { TranscriptStream } from "../stream";
import { TranscriptParser, type ChatEntry, type ChatPush } from "../transcript";
import {
  LocalTranscriptSource,
  MAX_RECORD_BYTES,
  READ_WINDOW_BYTES,
  type TranscriptRead,
  type TranscriptSource,
} from "../transcript-source";

const T = "2026-01-01T00:00:00.000Z";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: T, ...obj }) + "\n";
}

function user(uuid: string | null, text: string): string {
  return line({
    type: "user",
    ...(uuid ? { uuid } : {}),
    message: { role: "user", content: text },
  });
}

function toolUse(uuid: string, id: string): string {
  return line({
    type: "assistant",
    uuid,
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", id, name: "Bash", input: { command: "cat big" } },
      ],
    },
  });
}

function toolResult(uuid: string, toolUseId: string, content: string): string {
  return line({
    type: "user",
    uuid,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  });
}

/** Every entry a fresh parser makes of the whole file, read in one go. */
function fullRead(p: string): ChatEntry[] {
  const parser = new TranscriptParser();
  let offset = 0;
  for (const l of fs.readFileSync(p, "utf8").split("\n").slice(0, -1)) {
    parser.push(l, offset);
    offset += Buffer.byteLength(l, "utf8") + 1;
  }
  return parser.entries();
}

describe("TranscriptStream — bounded reads", () => {
  let dir: string;
  let file: string;
  let reads: { offset: number; result: TranscriptRead }[];
  let pushes: { entry: ChatPush; publish: boolean }[];
  let stream: TranscriptStream;

  /** The local file, with every read it answers recorded. */
  const local = new LocalTranscriptSource();
  const source: TranscriptSource = {
    read: async (p, offset) => {
      const result = await local.read(p, offset);
      reads.push({ offset, result });
      return result;
    },
  };

  /** The entries pushed, latest version of each, in first-seen order. */
  function latest(): Map<string, ChatPush> {
    const m = new Map<string, ChatPush>();
    for (const { entry } of pushes) m.set(entry.id, entry);
    return m;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-stream-"));
    file = path.join(dir, "t.jsonl");
    reads = [];
    pushes = [];
    stream = new TranscriptStream({
      label: "test",
      adapter: claudeAdapter,
      pollIntervalMs: 60_000,
      unwatchedPollIntervalMs: 60_000,
      onPush: (entry, publish) => pushes.push({ entry, publish }),
    });
    stream.point({ path: file, adapter: claudeAdapter, source }, false);
  });

  afterEach(() => {
    stream.release();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads a long transcript a window at a time, all of it as history, then publishes appends", async () => {
    const text = "x".repeat(1000);
    const fd = fs.openSync(file, "w");
    let n = 0;
    let written = 0;
    while (written < 50 * (1 << 20)) {
      const l = user(`u${n++}`, text);
      fs.writeSync(fd, l);
      written += l.length;
    }
    fs.closeSync(fd);

    await stream.read();
    expect(reads.length).toBeGreaterThanOrEqual(7);
    for (const { result } of reads) {
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(Buffer.byteLength(result.data, "utf8")).toBeLessThanOrEqual(
          READ_WINDOW_BYTES,
        );
    }
    // Windows follow on from each other: each starts where the last whole line ended.
    for (let i = 1; i < reads.length; i++) {
      const prev = reads[i - 1].result;
      if (prev.ok)
        expect(reads[i].offset).toBe(
          reads[i - 1].offset + Buffer.byteLength(prev.data, "utf8"),
        );
    }
    // Every line, then the turn state once, at the end of the read.
    expect(pushes.length).toBe(n + 1);
    expect(pushes[n - 1].entry.id).toBe(`u${n - 1}`);
    expect(pushes[n].entry).toMatchObject({ kind: "turn", id: "turn", state: "working" });
    expect(pushes.every((x) => !x.publish)).toBe(true);

    fs.appendFileSync(file, user("after", "new"));
    pushes = [];
    await stream.read();
    expect(pushes).toEqual([
      {
        entry: { kind: "user", id: "after", ts: T, text: "new" },
        publish: true,
      },
    ]);
  }, 60_000);

  it("skips a tool result too large to read, settles its tool, and reads on", async () => {
    const big = toolResult("r-big", "toolu_big", "y".repeat(3 * (1 << 20)));
    fs.writeFileSync(
      file,
      user("u1", "before") +
        toolUse("a1", "toolu_big") +
        big +
        user(null, "after one") +
        user(null, "after two"),
    );

    await stream.read();
    const skip = reads.find((r) => r.result.ok && r.result.skip !== undefined);
    expect(skip?.result).toMatchObject({
      data: "",
      skip: Buffer.byteLength(big),
    });
    for (const { result } of reads) {
      if (result.ok)
        expect(Buffer.byteLength(result.data, "utf8")).toBeLessThan(
          MAX_RECORD_BYTES,
        );
    }
    const entries = latest();
    expect(entries.get("toolu_big")).toMatchObject({
      status: "error",
      detail: "Output too large to show",
    });
    // Lines after it are named by their offset, as a full read names them.
    const full = fullRead(file).filter((e) => e.kind === "user");
    expect(full.map((e) => e.id)).toEqual([
      "u1",
      expect.stringMatching(/^@/),
      expect.stringMatching(/^@/),
    ]);
    expect([...entries.values()].filter((e) => e.kind === "user")).toEqual(
      full,
    );
  });

  it("waits for an oversized line still being written, then skips it", async () => {
    const big = toolResult("r-big", "toolu_big", "y".repeat(3 * (1 << 20)));
    const cut = MAX_RECORD_BYTES + 1000;
    fs.writeFileSync(file, toolUse("a1", "toolu_big") + big.slice(0, cut));

    await stream.read();
    expect(latest().get("toolu_big")).toMatchObject({ status: "pending" });
    const waiting = reads[reads.length - 1].result;
    expect(waiting).toEqual({
      ok: true,
      size: fs.statSync(file).size,
      data: "",
    });

    fs.appendFileSync(file, big.slice(cut) + user("u2", "next"));
    pushes = [];
    await stream.read();
    expect(pushes.map((x) => [x.entry.id, x.publish])).toEqual([
      ["toolu_big", true],
      ["u2", true],
    ]);
    expect(latest().get("toolu_big")).toMatchObject({
      status: "error",
      detail: "Output too large to show",
    });
  });

  it("names a tool result longer than a whole window by its own id", async () => {
    // Longer than a window, so its end is found past it.
    const huge = toolResult("r-huge", "toolu_huge", "y".repeat(10 * (1 << 20)));
    fs.writeFileSync(
      file,
      toolUse("a1", "toolu_huge") + huge + user("u2", "after"),
    );
    await stream.read();
    const entries = latest();
    expect(entries.get("toolu_huge")).toMatchObject({
      status: "error",
      detail: "Output too large to show",
    });
    expect(entries.get("u2")).toMatchObject({ text: "after" });
  });

  it("does not settle the next tool for a line just past a window", async () => {
    const huge = toolResult(
      "r-huge",
      "toolu_huge",
      "y".repeat(READ_WINDOW_BYTES + 100),
    );
    fs.writeFileSync(
      file,
      toolUse("a1", "toolu_huge") +
        toolUse("a2", "toolu_next") +
        huge +
        toolResult("r-next", "toolu_next", "fine"),
    );
    await stream.read();
    const entries = latest();
    expect(entries.get("toolu_huge")).toMatchObject({
      status: "error",
      detail: "Output too large to show",
    });
    expect(entries.get("toolu_next")).toMatchObject({
      status: "ok",
      detail: "fine",
    });
  });

  it("names an oversized error result that writes its content before its id", async () => {
    // As Claude Code writes a failed tool's result.
    const failed =
      JSON.stringify({
        timestamp: T,
        type: "user",
        uuid: "r-err",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: "e".repeat(3 * (1 << 20)),
              is_error: true,
              tool_use_id: "toolu_err",
            },
          ],
        },
      }) + "\n";
    expect(failed.indexOf("toolu_err")).toBeGreaterThan(3 * (1 << 20));
    fs.writeFileSync(
      file,
      toolUse("a1", "toolu_err") + failed + user("u2", "after"),
    );
    await stream.read();
    const entries = latest();
    expect(entries.get("toolu_err")).toMatchObject({
      status: "error",
      detail: "Output too large to show",
    });
    expect(entries.get("u2")).toMatchObject({ text: "after" });
  });

  it("settles a task whose result is too large, and leaves unknown lines alone", async () => {
    const task = line({
      type: "assistant",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_task",
            name: "Agent",
            input: { description: "d", prompt: "p" },
          },
        ],
      },
    });
    const huge = "z".repeat(3 * (1 << 20));
    fs.writeFileSync(
      file,
      task +
        toolResult("r1", "toolu_task", huge) +
        toolResult("r2", "toolu_nobody", huge) +
        user("u2", "ok"),
    );
    await stream.read();
    const entries = latest();
    expect(entries.get("toolu_task")).toMatchObject({
      kind: "task",
      status: "error",
      result: "Output too large to show",
    });
    expect(entries.has("toolu_nobody")).toBe(false);
    expect(entries.get("u2")).toMatchObject({ text: "ok" });
  });

  it("decodes a character that straddles a window boundary", async () => {
    const second = user("mb", "\u{1F600} end");
    const before = second.indexOf("\u{1F600}");
    const empty = user("fill", "");
    // The emoji's 4 bytes start 2 bytes before the window ends.
    const fill = user(
      "fill",
      "a".repeat(READ_WINDOW_BYTES - 2 - before - empty.length),
    );
    fs.writeFileSync(file, fill + second);
    expect(Buffer.byteLength(fill) + before).toBe(READ_WINDOW_BYTES - 2);

    await stream.read();
    expect(reads.length).toBe(2);
    expect(latest().get("mb")).toMatchObject({ text: "\u{1F600} end" });
  });
});
