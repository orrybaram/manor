import { describe, it, expect } from "vitest";
import { TranscriptParser, parseSkillLines } from "../transcript";

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

  it("skips meta and system-reminder lines", () => {
    const p = new TranscriptParser();
    expect(p.push(userBlocks("u1", "caveat", { isMeta: true }))).toEqual([]);
    expect(p.push(userBlocks("u3", "<local-command-stdout>ok</local-command-stdout>"))).toEqual([]);
    expect(p.push(userBlocks("u4", [{ type: "text", text: "<system-reminder>x</system-reminder>" }]))).toEqual([]);
    expect(p.entries()).toEqual([]);
  });

  it("turns a task notification into a notice carrying its summary", () => {
    const p = new TranscriptParser();
    const xml = (status: string) =>
      `<task-notification>\n<task-id>a1</task-id>\n<status>${status}</status>\n<summary>Agent "Map sync" finished</summary>\n</task-notification>`;
    expect(p.push(userBlocks("n1", xml("completed")))).toEqual([
      { kind: "notice", id: "n1", ts: expect.any(String), text: 'Agent "Map sync" finished', status: "ok" },
    ]);
    expect(p.push(userBlocks("n2", xml("failed")))[0]).toMatchObject({ kind: "notice", status: "error" });
    expect(p.push(userBlocks("n3", "<task-notification><task-id>a1</task-id></task-notification>"))).toEqual([]);
    expect(p.entries().some((e) => e.kind === "user")).toBe(false);
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

  describe("skill listings", () => {
    const listing = (attachment: unknown, extra = {}) =>
      line({ type: "attachment", uuid: "s", attachment, ...extra });
    const initial = listing({
      type: "skill_listing",
      isInitial: true,
      names: ["commit", "anthropic-skills:pdf"],
      content: "- commit: Make a commit\n- anthropic-skills:pdf: Work with PDFs",
    });

    it("parses an initial listing including plugin-prefixed names", () => {
      const p = new TranscriptParser();
      expect(p.hasSkillListing()).toBe(false);
      expect(p.push(initial)).toEqual([]);
      expect(p.hasSkillListing()).toBe(true);
      expect(p.skills()).toEqual([
        { name: "anthropic-skills:pdf", description: "Work with PDFs" },
        { name: "commit", description: "Make a commit" },
      ]);
    });

    it("adds delta listings and replaces on a second initial", () => {
      const p = new TranscriptParser();
      p.push(initial);
      p.push(
        listing({
          type: "skill_listing",
          isInitial: false,
          names: ["review"],
          content: "- review: Review code",
        }),
      );
      expect(p.skills().map((s) => s.name)).toEqual([
        "anthropic-skills:pdf",
        "commit",
        "review",
      ]);
      p.push(
        listing({
          type: "skill_listing",
          isInitial: true,
          content: "- only: One",
        }),
      );
      expect(p.skills()).toEqual([{ name: "only", description: "One" }]);
    });

    it("uses an empty description for names missing from content", () => {
      const p = new TranscriptParser();
      p.push(listing({ type: "skill_listing", isInitial: true, names: ["x"] }));
      expect(p.skills()).toEqual([{ name: "x", description: "" }]);
    });

    it("ignores malformed attachments", () => {
      const p = new TranscriptParser();
      expect(p.push(listing({ type: "skill_listing" }))).toEqual([]);
      expect(p.push(listing({ type: "skill_listing", names: "no", content: 5 }))).toEqual([]);
      expect(p.push(listing("garbage"))).toEqual([]);
      expect(p.push(listing({ type: "other", content: "- a: b" }))).toEqual([]);
      expect(p.skills()).toEqual([]);
    });

    it("ignores sidechain listings", () => {
      const p = new TranscriptParser();
      p.push(
        listing(
          { type: "skill_listing", isInitial: true, content: "- a: b" },
          { isSidechain: true },
        ),
      );
      expect(p.skills()).toEqual([]);
      expect(p.hasSkillListing()).toBe(false);
    });

    it("splits on the first ': ' only", () => {
      expect(parseSkillLines("- a:b: desc: more\nnot a skill").get("a:b")).toBe(
        "desc: more",
      );
    });
  });

  describe("slash commands", () => {
    it("parses command lines in both tag orders, with and without args", () => {
      const p = new TranscriptParser();
      const a = p.push(
        userBlocks(
          "c1",
          "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>  pr 12 </command-args>",
        ),
      );
      expect(a).toEqual([
        { kind: "command", id: "c1", ts: T, name: "review", args: "pr 12" },
      ]);
      const b = p.push(
        userBlocks(
          "c2",
          "<command-message>clear</command-message>\n<command-name>/clear</command-name>",
        ),
      );
      expect(b).toEqual([
        { kind: "command", id: "c2", ts: T, name: "clear", args: "" },
      ]);
    });

    it("attaches stdout to the last command as an update", () => {
      const p = new TranscriptParser();
      p.push(userBlocks("c1", "<command-name>/cost</command-name>"));
      const r = p.push(
        userBlocks("o1", "<local-command-stdout> $1.23 </local-command-stdout>"),
      );
      expect(r).toEqual([
        { kind: "command", id: "c1", ts: T, name: "cost", args: "", output: "$1.23" },
      ]);
      expect(p.entries()).toHaveLength(1);
    });

    it("drops empty stdout, orphan stdout and caveats", () => {
      const p = new TranscriptParser();
      expect(
        p.push(userBlocks("o0", "<local-command-stdout>hi</local-command-stdout>")),
      ).toEqual([]);
      p.push(userBlocks("c1", "<command-name>/cost</command-name>"));
      expect(
        p.push(userBlocks("o1", "<local-command-stdout>  </local-command-stdout>")),
      ).toEqual([]);
      expect(
        p.push(userBlocks("k1", "<local-command-caveat>Caveat</local-command-caveat>")),
      ).toEqual([]);
      expect(p.entries()).toHaveLength(1);
    });
  });

  describe("context tokens", () => {
    function withUsage(uuid: string, usage: unknown, extra = {}): string {
      return line({
        type: "assistant",
        uuid,
        message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage },
        ...extra,
      });
    }

    it("sums input, cache creation and cache read tokens, not output", () => {
      const p = new TranscriptParser();
      p.push(
        withUsage("a1", {
          input_tokens: 10,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 3000,
          output_tokens: 99,
        }),
      );
      expect(p.contextTokens()).toBe(3210);
    });

    it("counts absent or non-numeric fields as zero", () => {
      const p = new TranscriptParser();
      p.push(withUsage("a1", { input_tokens: 5, cache_read_input_tokens: "lots" }));
      expect(p.contextTokens()).toBe(5);
    });

    it("takes the newest assistant line", () => {
      const p = new TranscriptParser();
      p.push(withUsage("a1", { input_tokens: 100 }));
      p.push(withUsage("a2", { input_tokens: 50, cache_read_input_tokens: 400 }));
      expect(p.contextTokens()).toBe(450);
    });

    it("ignores sidechain and synthetic lines", () => {
      const p = new TranscriptParser();
      p.push(withUsage("a1", { input_tokens: 100 }));
      p.push(withUsage("a2", { input_tokens: 9000 }, { isSidechain: true }));
      p.push(
        line({
          type: "assistant",
          uuid: "a3",
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "API Error" }],
            usage: { input_tokens: 0, cache_read_input_tokens: 0 },
          },
        }),
      );
      expect(p.contextTokens()).toBe(100);
    });

    it("is null without usage, and keeps the last known size past a line without it", () => {
      const p = new TranscriptParser();
      p.push(assistant("a1", [{ type: "text", text: "hi" }]));
      p.push(withUsage("a2", { output_tokens: 3 }));
      p.push(withUsage("a3", "garbage"));
      expect(p.contextTokens()).toBeNull();
      p.push(withUsage("a4", { input_tokens: 7 }));
      p.push(assistant("a5", [{ type: "text", text: "more" }]));
      expect(p.contextTokens()).toBe(7);
    });

    it("never puts usage in the entries", () => {
      const p = new TranscriptParser();
      p.push(withUsage("a1", { input_tokens: 7 }));
      expect(p.entries().map((e) => e.kind)).toEqual(["assistant"]);
    });
  });
});
