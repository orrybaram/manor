import { describe, it, expect } from "vitest";
import { TranscriptParser } from "../transcript";

const T = "2026-01-01T00:00:00.000Z";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: T, ...obj });
}

function assistant(uuid: string, content: unknown[], extra = {}): string {
  return line({ type: "assistant", uuid, message: { role: "assistant", content }, ...extra });
}

function userBlocks(uuid: string, content: unknown, extra = {}): string {
  return line({ type: "user", uuid, message: { role: "user", content }, ...extra });
}

const QUESTIONS = [
  {
    question: "Which color?",
    header: "Color",
    options: [
      { label: "Red", description: "warm" },
      { label: "Blue", description: "cool" },
    ],
    multiSelect: false,
  },
];

describe("TranscriptParser", () => {
  it("parses user prompts and assistant text", () => {
    const p = new TranscriptParser();
    const a = p.push(userBlocks("u1", "hello there"));
    expect(a).toEqual([{ kind: "user", id: "u1", ts: T, text: "hello there" }]);
    const b = p.push(
      assistant("a1", [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "hi" },
      ]),
    );
    expect(b).toEqual([{ kind: "assistant", id: "a1:1", ts: T, text: "hi" }]);
    expect(p.entries()).toHaveLength(2);
  });

  it("pairs a tool_use with its tool_result", () => {
    const p = new TranscriptParser();
    const [pending] = p.push(
      assistant("a1", [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la\necho x" } },
      ]),
    );
    expect(pending).toMatchObject({ kind: "tool", status: "pending", summary: "ls -la" });
    const updated = p.push(
      userBlocks("u2", [{ type: "tool_result", tool_use_id: "t1", content: "file.txt" }], {
        toolUseResult: { stdout: "file.txt" },
      }),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ id: "t1", status: "ok", detail: "file.txt" });
    expect(p.entries()).toHaveLength(1);
  });

  it("marks errored results and summarizes by tool", () => {
    const p = new TranscriptParser();
    p.push(
      assistant("a1", [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "x", description: "Run x" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a/b.ts" } },
        { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "foo" } },
        { type: "tool_use", id: "t4", name: "WebFetch", input: {} },
      ]),
    );
    p.push(
      userBlocks("u2", [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "boom" }], is_error: true },
      ]),
    );
    const e = p.entries();
    expect(e.map((x) => (x.kind === "tool" ? x.summary : ""))).toEqual([
      "Run x",
      "/a/b.ts",
      "foo",
      "WebFetch",
    ]);
    expect(e[0]).toMatchObject({ status: "error", detail: "boom" });
  });

  it("keeps a question pending until answered", () => {
    const p = new TranscriptParser();
    const [q] = p.push(
      assistant("a1", [
        { type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: QUESTIONS } },
      ]),
    );
    expect(q).toMatchObject({ kind: "question", id: "q1", answer: null, questions: QUESTIONS });
    const [answered] = p.push(
      userBlocks("u2", [
        { type: "tool_result", tool_use_id: "q1", content: 'User has answered: "Which color?"="Red".' },
      ]),
    );
    expect(answered).toMatchObject({ kind: "question", id: "q1" });
    expect((answered as { answer: string }).answer).toContain("Red");
  });

  it("parses a plan and its outcome", () => {
    const p = new TranscriptParser();
    const [plan] = p.push(
      assistant("a1", [{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "1. do it" } }]),
    );
    expect(plan).toMatchObject({ kind: "plan", plan: "1. do it", outcome: null });
    const [done] = p.push(
      userBlocks("u2", [{ type: "tool_result", tool_use_id: "p1", content: "approved" }]),
    );
    expect(done).toMatchObject({ kind: "plan", outcome: "approved" });
  });

  it("skips sidechain lines", () => {
    const p = new TranscriptParser();
    expect(p.push(userBlocks("u1", "sub prompt", { isSidechain: true }))).toEqual([]);
    expect(
      p.push(assistant("a1", [{ type: "text", text: "sub" }], { isSidechain: true })),
    ).toEqual([]);
    expect(p.entries()).toEqual([]);
  });

  it("skips meta, command and system-reminder lines", () => {
    const p = new TranscriptParser();
    expect(p.push(userBlocks("u1", "caveat", { isMeta: true }))).toEqual([]);
    expect(p.push(userBlocks("u2", "<command-name>/clear</command-name>"))).toEqual([]);
    expect(p.push(userBlocks("u3", "<local-command-stdout>ok</local-command-stdout>"))).toEqual([]);
    expect(p.push(userBlocks("u4", [{ type: "text", text: "<system-reminder>x</system-reminder>" }]))).toEqual([]);
    expect(p.entries()).toEqual([]);
  });

  it("skips malformed JSON, unknown line types and unknown blocks without throwing", () => {
    const p = new TranscriptParser();
    expect(p.push("{not json")).toEqual([]);
    expect(p.push("")).toEqual([]);
    expect(p.push("42")).toEqual([]);
    expect(p.push(line({ type: "summary", summary: "x" }))).toEqual([]);
    expect(p.push(line({ type: "assistant", uuid: "a0" }))).toEqual([]);
    const out = p.push(
      assistant("a1", [
        { type: "server_tool_use_v9", foo: 1 },
        null,
        { type: "text", text: "kept" },
      ]),
    );
    expect(out).toEqual([{ kind: "assistant", id: "a1:2", ts: T, text: "kept" }]);
  });

  it("ignores a tool_result with no matching entry", () => {
    const p = new TranscriptParser();
    expect(
      p.push(userBlocks("u1", [{ type: "tool_result", tool_use_id: "nope", content: "x" }])),
    ).toEqual([]);
  });

  it("does not duplicate entries when a line is replayed", () => {
    const p = new TranscriptParser();
    const l = userBlocks("u1", "hi");
    p.push(l);
    expect(p.push(l)).toEqual([]);
    expect(p.entries()).toHaveLength(1);
  });
});
