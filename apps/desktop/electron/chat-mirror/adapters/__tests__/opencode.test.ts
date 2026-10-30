import { describe, expect, it } from "vitest";
import type { ChatTaskEntry } from "../../transcript";
import { opencodeAdapter, parseUnifiedDiff } from "../opencode";

const T = 1_767_225_600_000; // 2026-01-01T00:00:00Z
const ISO = new Date(T).toISOString();

const msg = (id: string, data: object) => JSON.stringify({ t: "message", id, time_created: T, time_updated: T, data });
const part = (id: string, messageId: string, data: object) =>
  JSON.stringify({ t: "part", id, message_id: messageId, time_created: T, time_updated: T, data });
const v2 = (id: string, type: string, seq: number, data: object) =>
  JSON.stringify({ t: "session_message", id, type, seq, time_created: T, time_updated: T, data });

describe("opencode parser, v1 rows", () => {
  it("reads words by their message's role, skipping opencode's own", () => {
    const p = opencodeAdapter.createParser();
    expect(p.push(msg("msg_1", { role: "user", time: { created: T } }))).toEqual([]);
    expect(p.push(part("prt_1", "msg_1", { type: "text", text: "Fix the toast" }))).toEqual([
      { kind: "user", id: "prt_1", ts: ISO, text: "Fix the toast" },
    ]);
    expect(p.push(part("prt_2", "msg_1", { type: "text", text: "<file>", synthetic: true }))).toEqual([]);
    p.push(msg("msg_2", { role: "assistant", time: { created: T } }));
    expect(p.push(part("prt_3", "msg_2", { type: "reasoning", text: "hmm" }))).toEqual([]);
    expect(p.push(part("prt_4", "msg_2", { type: "text", text: "On it." }))).toEqual([
      { kind: "assistant", id: "prt_4", ts: ISO, text: "On it." },
    ]);
  });

  it("names a part that came before its message once the message says whose it is", () => {
    const p = opencodeAdapter.createParser();
    expect(p.push(part("prt_1", "msg_1", { type: "text", text: "hi" }))).toEqual([]);
    expect(p.push(msg("msg_1", { role: "user" }))).toMatchObject([{ kind: "user", id: "prt_1" }]);
  });

  it("upserts a row read again, returning it only when it changed", () => {
    const p = opencodeAdapter.createParser();
    p.push(msg("msg_1", { role: "assistant", time: { created: T } }));
    expect(p.push(part("prt_1", "msg_1", { type: "text", text: "Look" }))).toHaveLength(1);
    expect(p.push(part("prt_1", "msg_1", { type: "text", text: "Look" }))).toEqual([]);
    expect(p.push(part("prt_1", "msg_1", { type: "text", text: "Looking." }))).toMatchObject([{ text: "Looking." }]);
    expect(p.entries()).toHaveLength(1);
  });

  it("follows a tool part from pending to its result, named as Claude's", () => {
    const p = opencodeAdapter.createParser();
    p.push(msg("msg_1", { role: "assistant" }));
    const pending = { type: "tool", tool: "bash", callID: "c1", state: { status: "pending", input: {} } };
    expect(p.push(part("prt_1", "msg_1", pending))).toMatchObject([
      { kind: "tool", id: "prt_1", name: "Bash", summary: "Bash", status: "pending" },
    ]);
    const running = { ...pending, state: { status: "running", input: { command: "pnpm test\n--watch" }, time: { start: T } } };
    expect(p.push(part("prt_1", "msg_1", running))).toMatchObject([{ summary: "pnpm test", status: "pending" }]);
    const done = {
      ...pending,
      state: { status: "completed", input: { command: "pnpm test" }, title: "Run the tests", output: "ok" },
    };
    expect(p.push(part("prt_1", "msg_1", done))).toEqual([
      { kind: "tool", id: "prt_1", ts: ISO, name: "Bash", summary: "Run the tests", status: "ok", detail: "ok" },
    ]);
    const failed = { ...pending, state: { status: "error", input: {}, error: "exit 1" } };
    expect(p.push(part("prt_1", "msg_1", failed))).toMatchObject([{ status: "error", detail: "exit 1" }]);
  });

  it("makes a landed edit with a diff an edit entry, relative to the session's directory", () => {
    const p = opencodeAdapter.createParser();
    p.push(msg("msg_1", { role: "assistant", path: { cwd: "/repo" } }));
    const diff = [
      "Index: /repo/src/a.ts",
      "===================================================================",
      "--- /repo/src/a.ts",
      "+++ /repo/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "",
    ].join("\n");
    const edit = {
      type: "tool",
      tool: "edit",
      state: { status: "completed", input: { filePath: "/repo/src/a.ts" }, metadata: { diff } },
    };
    expect(p.push(part("prt_1", "msg_1", edit))).toEqual([
      {
        kind: "edit",
        id: "prt_1",
        ts: ISO,
        name: "Edit",
        path: "src/a.ts",
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" keep", "-old", "+new"] }],
        added: 1,
        removed: 1,
        truncated: false,
      },
    ]);
    const write = {
      type: "tool",
      tool: "write",
      state: { status: "completed", input: { filePath: "/repo/new.ts", content: "a\nb\n" }, metadata: {} },
    };
    expect(p.push(part("prt_2", "msg_1", write))).toMatchObject([
      { kind: "edit", name: "Write", path: "new.ts", added: 2, hunks: [{ lines: ["+a", "+b"] }] },
    ]);
  });

  it("makes a task tool a task whose child session is its transcript", () => {
    const p = opencodeAdapter.createParser();
    p.push(msg("msg_1", { role: "assistant" }));
    const task = {
      type: "tool",
      tool: "task",
      state: {
        status: "running",
        input: { description: "Map the store", subagent_type: "explore" },
        metadata: { sessionId: "ses_child1" },
      },
    };
    const [entry] = p.push(part("prt_1", "msg_1", task));
    expect(entry).toMatchObject({
      kind: "task",
      taskKind: "agent",
      title: "Map the store",
      agentType: "explore",
      status: "running",
      taskRef: "ses_child1",
    });
    expect(opencodeAdapter.childTranscriptPath("/d/opencode.db#ses_parent", entry as ChatTaskEntry)).toBe(
      "/d/opencode.db#ses_child1",
    );
    expect(
      opencodeAdapter.childTranscriptPath("/d/opencode.db#ses_parent", { ...(entry as ChatTaskEntry), taskRef: "../x" }),
    ).toBeNull();
    expect(opencodeAdapter.childTranscriptPath("/d/opencode.db", entry as ChatTaskEntry)).toBeNull();
  });

  it("takes the context size from the newest step-finish, and the turn from the newest message", () => {
    const p = opencodeAdapter.createParser();
    expect(p.turnState()).toBeNull();
    p.push(msg("msg_1", { role: "user" }));
    expect(p.turnState()).toBe("working");
    p.push(msg("msg_2", { role: "assistant", time: { created: T } }));
    expect(p.turnState()).toBe("working");
    p.push(part("prt_1", "msg_2", { type: "step-finish", tokens: { input: 100, output: 5, cache: { read: 900, write: 0 } } }));
    expect(p.contextTokens()).toBe(1000);
    p.push(msg("msg_2", { role: "assistant", time: { created: T, completed: T }, finish: "tool-calls" }));
    expect(p.turnState()).toBe("working");
    p.push(msg("msg_3", { role: "assistant", time: { created: T, completed: T }, finish: "stop" }));
    p.push(part("prt_2", "msg_3", { type: "step-finish", tokens: { input: 50, cache: { read: 1000, write: 10 } } }));
    expect(p.turnState()).toBe("done");
    expect(p.contextTokens()).toBe(1060);
    // An older message read again says nothing about the turn now.
    p.push(msg("msg_1", { role: "user" }));
    expect(p.turnState()).toBe("done");
    p.push(msg("msg_4", { role: "user" }));
    p.push(msg("msg_5", { role: "assistant", error: { name: "MessageAbortedError" } }));
    expect(p.turnState()).toBe("interrupted");
  });

  it("keeps the session's order whatever order rows were updated in", () => {
    const p = opencodeAdapter.createParser();
    p.push(msg("msg_2", { role: "assistant" }));
    p.push(part("prt_9", "msg_2", { type: "text", text: "second" }));
    p.push(msg("msg_1", { role: "user" }));
    p.push(part("prt_1", "msg_1", { type: "text", text: "first" }));
    p.push(part("prt_0", "msg_1", { type: "compaction" }));
    expect(p.entries().map((e) => e.id)).toEqual(["prt_0", "prt_1", "prt_9"]);
    expect(p.entry("prt_0")).toMatchObject({ kind: "notice", text: "Conversation compacted" });
  });
});

describe("opencode parser, v2 rows", () => {
  it("reads user, assistant content blocks, shell and idle", () => {
    const p = opencodeAdapter.createParser();
    expect(p.push(v2("msg_1", "user", 1, { text: "Fix the toast", time: { created: T } }))).toEqual([
      { kind: "user", id: "msg_1", ts: ISO, text: "Fix the toast" },
    ]);
    expect(p.turnState()).toBe("working");
    const assistant = {
      time: { created: T },
      tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 90, write: 0 } },
      content: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text: "Looking." },
        { type: "tool", id: "call_1", name: "read", state: { status: "running", input: { filePath: "/r/t.ts" }, metadata: {} } },
      ],
    };
    expect(p.push(v2("msg_2", "assistant", 2, assistant))).toMatchObject([
      { kind: "assistant", id: "msg_2:1", text: "Looking." },
      { kind: "tool", id: "call_1", name: "Read", summary: "/r/t.ts", status: "pending" },
    ]);
    expect(p.contextTokens()).toBe(100);
    // The row again with its tool landed: only the tool changed.
    const landed = {
      ...assistant,
      content: [
        assistant.content[0],
        assistant.content[1],
        {
          ...assistant.content[2],
          state: { status: "completed", input: { filePath: "/r/t.ts" }, content: [{ type: "text", text: "body" }] },
        },
        { type: "tool", id: "call_2", name: "bash", state: { status: "error", input: {}, error: { message: "boom" } } },
      ],
    };
    expect(p.push(v2("msg_2", "assistant", 2, landed))).toMatchObject([
      { id: "call_1", status: "ok", detail: "body" },
      { id: "call_2", status: "error", detail: "boom" },
    ]);
    expect(p.push(v2("msg_3", "shell", 3, { command: "ls", output: { text: "a\n" } }))).toMatchObject([
      { kind: "command", name: "ls", shell: true, output: "a\n" },
    ]);
    p.push(v2("msg_4", "idle", 4, { outcome: "succeeded" }));
    expect(p.turnState()).toBe("done");
    p.push(v2("msg_5", "user", 5, { text: "Again" }));
    p.push(v2("msg_6", "idle", 6, { outcome: "interrupted" }));
    expect(p.turnState()).toBe("interrupted");
    expect(p.entries().map((e) => e.id)).toEqual(["msg_1", "msg_2:1", "call_1", "call_2", "msg_3", "msg_5"]);
  });

  it("notes a completed compaction", () => {
    const p = opencodeAdapter.createParser();
    expect(p.push(v2("msg_1", "compaction", 1, { status: "running" }))).toEqual([]);
    expect(p.push(v2("msg_1", "compaction", 1, { status: "completed" }))).toMatchObject([
      { kind: "notice", text: "Conversation compacted", status: "ok" },
    ]);
  });
});

describe("opencode parser, other lines", () => {
  it("says the host can't read the database without node:sqlite", () => {
    const p = opencodeAdapter.createParser();
    expect(p.push(JSON.stringify({ t: "unsupported", node: "20.11.0" }))).toMatchObject([
      { kind: "notice", status: "error", text: expect.stringContaining("Node (20.11.0) has no node:sqlite") },
    ]);
  });

  it("skips what isn't a row", () => {
    const p = opencodeAdapter.createParser();
    expect(p.push("not json")).toEqual([]);
    expect(p.push(JSON.stringify({ t: "message" }))).toEqual([]);
    expect(p.skills()).toEqual([]);
    expect(p.hasSkillListing()).toBe(false);
  });
});

describe("opencodeAdapter.promptWrites", () => {
  it("pastes the text as one bracketed paste, then submits on its own", () => {
    expect(opencodeAdapter.promptWrites("line one\r\nline two\x1b[201~")).toEqual([
      "\x1b[200~line one\nline two[201~\x1b[201~",
      "\r",
    ]);
  });
});

describe("parseUnifiedDiff", () => {
  it("reads hunks across files and a header without counts", () => {
    const diff = ["--- a", "+++ a", "@@ -3 +3 @@", "-x", "+y", "--- b", "+++ b", "@@ -0,0 +1,1 @@", "+new", ""].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ["-x", "+y"] },
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+new"] },
    ]);
  });
});
