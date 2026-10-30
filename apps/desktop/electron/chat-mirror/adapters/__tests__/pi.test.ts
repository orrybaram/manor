import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TranscriptStream } from "../../stream";
import type { ChatEntry, ChatPush } from "../../transcript";
import { LocalTranscriptSource } from "../../transcript-source";
import { parseUnifiedPatch, piAdapter } from "../pi";

// Hand-written, not a real session: the repo is public.
const FIXTURE = path.join(__dirname, "..", "..", "__fixtures__", "pi", "session-v3-fix-and-branch.jsonl");
const T = "2026-01-01T00:00:00.000Z";

function parseAll(text: string) {
  const parser = piAdapter.createParser();
  let offset = 0;
  for (const l of text.split("\n").slice(0, -1)) {
    parser.push(l, offset);
    offset += Buffer.byteLength(l, "utf8") + 1;
  }
  return parser;
}

function line(entry: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: T, ...entry });
}

describe("pi session fixture", () => {
  const parser = parseAll(fs.readFileSync(FIXTURE, "utf8"));
  const entries = parser.entries();
  const strip = (e: ChatEntry) => {
    const { ts: _ts, ...rest } = e;
    return rest;
  };

  it("reads the conversation in file order, without thinking, system or settings entries", () => {
    expect(entries.map((e) => `${e.kind}:${e.id}`)).toEqual([
      "user:d3e4f5a6",
      "assistant:e4f5a6b7:1",
      "tool:toolu_01ReadRetry",
      "assistant:a6b7c8d9:0",
      "edit:toolu_02EditRetry",
      "edit:toolu_03WriteTest",
      "tool:toolu_04RunTests",
      "tool:toolu_05FindRunner",
      "assistant:c4d5e6f7:0",
      "command:d5e6f7a8",
      "command:e6f7a8b9",
      "assistant:f7a8b9c0:0",
      "notice:a8b9c0d1",
      "user:b9c0d1e2",
      "assistant:c0d1e2f3:0",
      "notice:c0d1e2f3:stop",
      "notice:d1e2f3a4:branch",
      "user:d1e2f3a4",
      "assistant:e2f3a4b5:0",
    ]);
  });

  it("keeps a user message's text and drops its image", () => {
    expect(parser.entry("b9c0d1e2")).toMatchObject({ kind: "user", text: "Now make the backoff configurable." });
  });

  it("pairs a tool call with its result, under Claude's tool names", () => {
    expect(strip(parser.entry("toolu_01ReadRetry")!)).toMatchObject({
      kind: "tool",
      name: "Read",
      summary: "src/net/retry.ts",
      status: "ok",
    });
    expect(parser.entry("toolu_04RunTests")).toMatchObject({
      kind: "tool",
      name: "Bash",
      summary: "npx vitest run test/retry.test.ts",
      status: "error",
      detail: "Error: Cannot find module 'vitest'\n\nCommand exited with code 1",
    });
    expect(parser.entry("toolu_05FindRunner")).toMatchObject({ name: "Grep", summary: '"test":', status: "ok" });
  });

  it("makes a landed edit its diff, from the edit tool's patch", () => {
    expect(strip(parser.entry("toolu_02EditRetry")!)).toEqual({
      kind: "edit",
      id: "toolu_02EditRetry",
      name: "Edit",
      path: "src/net/retry.ts",
      hunks: [
        {
          oldStart: 1,
          oldLines: 7,
          newStart: 1,
          newLines: 7,
          lines: [
            " export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {",
            "   let lastError: unknown;",
            "-  for (let i = 1; i < attempts; i++) {",
            "+  for (let i = 0; i < attempts; i++) {",
            "     try {",
            "       return await fn();",
            "     } catch (err) {",
          ],
        },
      ],
      added: 1,
      removed: 1,
      truncated: false,
    });
  });

  it("makes a written file all added lines, relative to the session's cwd", () => {
    const write = parser.entry("toolu_03WriteTest");
    expect(write).toMatchObject({ kind: "edit", name: "Write", path: "test/retry.test.ts", added: 8, removed: 0 });
  });

  it("shows a ! command with its output, and a /skill: invocation as a command", () => {
    expect(strip(parser.entry("d5e6f7a8")!)).toEqual({
      kind: "command",
      id: "d5e6f7a8",
      name: "git status --short",
      args: "",
      shell: true,
      output: " M src/net/retry.ts\n?? test/retry.test.ts",
    });
    expect(strip(parser.entry("e6f7a8b9")!)).toEqual({
      kind: "command",
      id: "e6f7a8b9",
      name: "skill:changelog",
      args: "the retry fix",
    });
  });

  it("marks compaction, an aborted reply and a branch with notices", () => {
    expect(parser.entry("a8b9c0d1")).toMatchObject({ kind: "notice", text: "Conversation compacted", status: "ok" });
    expect(parser.entry("c0d1e2f3:stop")).toMatchObject({ kind: "notice", text: "Interrupted", status: "error" });
    expect(parser.entry("d1e2f3a4:branch")).toMatchObject({
      kind: "notice",
      text: "Branched from an earlier message",
    });
  });

  it("takes the context size from the newest assistant usage, and the turn from its stop reason", () => {
    expect(parser.contextTokens()).toBe(2 + 1800 + 30);
    expect(parser.turnState()).toBe("done");
    expect(parser.skills()).toEqual([]);
    expect(parser.hasSkillListing()).toBe(false);
  });
});

describe("piAdapter parser, line by line", () => {
  const user = (id: string, content: unknown) => line({ type: "message", id, message: { role: "user", content } });
  const assistant = (id: string, message: Record<string, unknown>) =>
    line({ type: "message", id, message: { role: "assistant", content: [], ...message } });

  it("moves the turn: a prompt works, a tool call goes on, stop ends it, aborted interrupts", () => {
    const p = piAdapter.createParser();
    expect(p.turnState()).toBeNull();
    p.push(user("u1", "hi"));
    expect(p.turnState()).toBe("working");
    p.push(assistant("a1", { stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "ls", arguments: {} }] }));
    expect(p.turnState()).toBe("working");
    expect(p.entry("c1")).toMatchObject({ kind: "tool", name: "LS", summary: ".", status: "pending" });
    p.push(line({ type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", content: [], isError: false } }));
    expect(p.turnState()).toBe("working");
    expect(p.entry("c1")).toMatchObject({ status: "ok" });
    p.push(assistant("a2", { stopReason: "stop", content: [{ type: "text", text: "done" }] }));
    expect(p.turnState()).toBe("done");
    p.push(user("u2", "again"));
    p.push(assistant("a3", { stopReason: "aborted" }));
    expect(p.turnState()).toBe("interrupted");
  });

  it("shows a failed reply's error, and ignores its zeroed usage", () => {
    const p = piAdapter.createParser();
    p.push(assistant("a1", { stopReason: "stop", usage: { input: 10, cacheRead: 100, cacheWrite: 5, output: 3 } }));
    const out = p.push(
      assistant("a2", { stopReason: "error", errorMessage: "429 rate limited\nretry later", usage: { input: 0, output: 0 } }),
    );
    expect(out).toEqual([{ kind: "notice", id: "a2:stop", ts: T, text: "429 rate limited", status: "error" }]);
    expect(p.contextTokens()).toBe(115);
    expect(p.turnState()).toBe("done");
  });

  it("leaves an edit that failed, or one with no patch, a tool row", () => {
    const p = piAdapter.createParser();
    const call = (id: string) =>
      assistant(`a-${id}`, {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id, name: "edit", arguments: { path: "a.ts", edits: [] } }],
      });
    const result = (id: string, extra: Record<string, unknown>) =>
      line({ type: "message", id: `r-${id}`, message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "nope" }], ...extra } });
    p.push(call("c1"));
    p.push(result("c1", { isError: true, details: { patch: "@@ -1 +1 @@\n-a\n+b" } }));
    expect(p.entry("c1")).toMatchObject({ kind: "tool", name: "Edit", status: "error", detail: "nope" });
    p.push(call("c2"));
    p.push(result("c2", { isError: false }));
    expect(p.entry("c2")).toMatchObject({ kind: "tool", status: "ok" });
  });

  it("names a line with no id by its offset, and skips what it can't read", () => {
    const p = piAdapter.createParser();
    expect(p.push(JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }), 40)).toEqual([
      { kind: "user", id: "@40", ts: "", text: "hi" },
    ]);
    expect(p.push("{not json")).toEqual([]);
    expect(p.push(line({ type: "message", id: "x", message: { role: "custom", content: "ext" } }))).toEqual([]);
    expect(p.push(line({ type: "label", id: "y", targetId: "x", label: "l" }))).toEqual([]);
  });

  it("settles a tool whose result was too long to read", () => {
    const p = piAdapter.createParser();
    p.push(assistant("a1", { stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "big" } }] }));
    const head = '{"type":"message","id":"r1","message":{"role":"toolResult","toolCallId":"c1","content":[{"type":"text","text":"aaa';
    expect(p.oversized!({ head, tail: 'aaa"}]}}' }, 0)).toEqual([
      expect.objectContaining({ id: "c1", status: "error", detail: "Output too large to show" }),
    ]);
  });
});

describe("parseUnifiedPatch", () => {
  it("reads each hunk for as many lines as its header counts", () => {
    const patch = [
      "--- a.ts",
      "+++ a.ts",
      "@@ -1,2 +1,2 @@",
      "--- a removed line that looks like a header",
      "+new",
      " same",
      "@@ -9 +9,0 @@",
      "-gone",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(parseUnifiedPatch(patch)).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["--- a removed line that looks like a header", "+new", " same"] },
      { oldStart: 9, oldLines: 1, newStart: 9, newLines: 0, lines: ["-gone", "\\ No newline at end of file"] },
    ]);
  });
});

describe("piAdapter", () => {
  it("has no child transcripts", () => {
    expect(
      piAdapter.childTranscriptPath("/x.jsonl", { kind: "task", id: "t", ts: T, taskKind: "agent", title: "", background: false, status: "running" }),
    ).toBeNull();
  });

  it("types a prompt as one bracketed paste, then Enter on its own", () => {
    expect(piAdapter.promptWrites("fix it\r\nand test\x1b[201~")).toEqual([
      "\x1b[200~fix it\nand test[201~\x1b[201~",
      "\r",
    ]);
  });

  it("reads a session file pi hasn't written yet as empty, then its entries once it is", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-"));
    const file = path.join(dir, "session.jsonl");
    const pushes: ChatPush[] = [];
    const stream = new TranscriptStream({
      label: "pi",
      adapter: piAdapter,
      pollIntervalMs: 60_000,
      unwatchedPollIntervalMs: 60_000,
      onPush: (p) => pushes.push(p),
    });
    stream.point({ path: file, adapter: piAdapter, source: new LocalTranscriptSource() }, false);
    try {
      await stream.read();
      expect(pushes).toEqual([]);
      fs.writeFileSync(file, fs.readFileSync(FIXTURE));
      await stream.read();
      expect(pushes.some((p) => p.kind === "user" && p.id === "d3e4f5a6")).toBe(true);
      expect(pushes.some((p) => p.kind === "turn")).toBe(true);
    } finally {
      stream.release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("piAdapter parser, branches", () => {
  const at = (id: string, parentId: string | null) =>
    line({ type: "message", id, parentId, message: { role: "user", content: id } });

  it("marks an entry that doesn't continue from the one before it, a new root included", () => {
    const p = piAdapter.createParser();
    expect(p.push(at("e1", null)).map((e) => e.id)).toEqual(["e1"]);
    expect(p.push(at("e2", "e1")).map((e) => e.id)).toEqual(["e2"]);
    expect(p.push(at("e3", "e1")).map((e) => e.id)).toEqual(["e3:branch", "e3"]);
    expect(p.push(at("e4", null)).map((e) => e.id)).toEqual(["e4:branch", "e4"]);
  });
});
