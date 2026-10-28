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

  it("marks a question declined, with no answer, when its result is an error", () => {
    const p = new TranscriptParser();
    p.push(assistant("a1", [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: QUESTIONS } }]));
    const [declined] = p.push(
      userBlocks("u2", [
        {
          type: "tool_result",
          content: "The user doesn't want to proceed with this tool use.",
          is_error: true,
          tool_use_id: "q1",
        },
      ]),
    );
    expect(declined).toEqual({ kind: "question", id: "q1", ts: T, questions: QUESTIONS, answer: null, declined: true });
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

  it("shows compaction as a notice and skips the summary", () => {
    const p = new TranscriptParser();
    expect(
      p.push(line({ type: "system", subtype: "compact_boundary", uuid: "c1", content: "Conversation compacted" })),
    ).toEqual([{ kind: "notice", id: "c1", ts: T, text: "Conversation compacted", status: "ok" }]);
    const summary = "This session is being continued from a previous conversation...";
    expect(p.push(userBlocks("c2", summary, { isCompactSummary: true, isVisibleInTranscriptOnly: true }))).toEqual([]);
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

    it("reads a local command written as system lines, as 2.1.308 does", () => {
      const p = new TranscriptParser();
      const system = (uuid: string, content: string) => line({ type: "system", subtype: "local_command", uuid, content });
      expect(
        p.push(
          system(
            "s1",
            "<command-name>/login</command-name>\n            <command-message>login</command-message>\n            <command-args></command-args>",
          ),
        ),
      ).toEqual([{ kind: "command", id: "s1", ts: T, name: "login", args: "" }]);
      expect(p.push(system("s2", "<local-command-stdout>Login successful</local-command-stdout>"))).toEqual([
        { kind: "command", id: "s1", ts: T, name: "login", args: "", output: "Login successful" },
      ]);
      expect(p.entries()).toHaveLength(1);
    });

    it("attaches a system line's stdout to a user-line command, as 2.1.302 writes them", () => {
      const p = new TranscriptParser();
      p.push(userBlocks("c1", "<command-name>/cost</command-name>"));
      const r = p.push(
        line({ type: "system", subtype: "local_command", uuid: "s1", content: "<local-command-stdout>$1.23</local-command-stdout>" }),
      );
      expect(r).toEqual([{ kind: "command", id: "c1", ts: T, name: "cost", args: "", output: "$1.23" }]);
    });

    it("attaches no late stdout to a command something else has followed", () => {
      const p = new TranscriptParser();
      p.push(userBlocks("c1", "<command-name>/cost</command-name>"));
      p.push(line({ type: "system", subtype: "local_command", uuid: "s1", content: "<local-command-stdout>$1.23</local-command-stdout>" }));
      p.push(userBlocks("u1", "next prompt"));
      expect(
        p.push(line({ type: "system", subtype: "local_command", uuid: "s2", content: "<local-command-stdout>late</local-command-stdout>" })),
      ).toEqual([]);
      p.push(userBlocks("b1", "<bash-input>ls</bash-input>"));
      p.push(assistant("a1", [{ type: "text", text: "meanwhile" }]));
      expect(p.push(userBlocks("b2", "<bash-stdout>late</bash-stdout>"))).toEqual([]);
      expect(p.entry("c1")).toMatchObject({ output: "$1.23" });
      expect(p.entry("b1")).not.toHaveProperty("output");
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

  describe("shell commands", () => {
    it("shows a ! command and attaches its stdout and stderr", () => {
      const p = new TranscriptParser();
      expect(p.push(userBlocks("b1", "<bash-input>git status</bash-input>"))).toEqual([
        { kind: "command", id: "b1", ts: T, name: "git status", args: "", shell: true },
      ]);
      const r = p.push(
        userBlocks("b2", "<bash-stdout>On branch main\n</bash-stdout><bash-stderr>warn</bash-stderr>"),
      );
      expect(r).toEqual([
        {
          kind: "command",
          id: "b1",
          ts: T,
          name: "git status",
          args: "",
          shell: true,
          output: "On branch main\nwarn",
        },
      ]);
      expect(p.entries()).toHaveLength(1);
    });

    it("leaves out empty stderr, caps output, and drops orphan or empty output", () => {
      const p = new TranscriptParser();
      expect(p.push(userBlocks("o0", "<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>"))).toEqual([]);
      p.push(userBlocks("b1", "<bash-input>ls</bash-input>"));
      expect(
        p.push(userBlocks("o1", "<bash-stdout> </bash-stdout><bash-stderr></bash-stderr>")),
      ).toEqual([]);
      const [e] = p.push(
        userBlocks("o2", `<bash-stdout>${"x".repeat(5000)}</bash-stdout><bash-stderr></bash-stderr>`),
      );
      expect(e).toMatchObject({ id: "b1" });
      expect(e.kind === "command" && e.output?.length).toBe(4000);
      expect(p.entries()).toHaveLength(1);
    });

    it("shows no output for Claude Code's no-output placeholder", () => {
      const p = new TranscriptParser();
      p.push(userBlocks("b1", "<bash-input>true</bash-input>"));
      expect(
        p.push(userBlocks("b2", "<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr></bash-stderr>")),
      ).toEqual([]);
      expect(p.entries()).toEqual([{ kind: "command", id: "b1", ts: T, name: "true", args: "", shell: true }]);
      // Stderr alongside it still shows.
      p.push(userBlocks("b3", "<bash-input>false</bash-input>"));
      const [e] = p.push(
        userBlocks("b4", "<bash-stdout>(Bash completed with no output)</bash-stdout><bash-stderr>oops</bash-stderr>"),
      );
      expect(e).toMatchObject({ id: "b3", output: "oops" });
    });

    it("does not attach shell output to a slash command, or stdout to nothing", () => {
      const p = new TranscriptParser();
      p.push(userBlocks("c1", "<command-name>/cost</command-name>"));
      expect(p.push(userBlocks("o1", "<bash-stdout>hi</bash-stdout>"))).toEqual([]);
      expect(p.push(userBlocks("b0", "<bash-input>  </bash-input>"))).toEqual([]);
      expect(p.entries()).toEqual([
        { kind: "command", id: "c1", ts: T, name: "cost", args: "" },
      ]);
    });
  });

  describe("interrupts", () => {
    it("shows both interrupt markers as an Interrupted notice, not a user bubble", () => {
      const p = new TranscriptParser();
      expect(
        p.push(userBlocks("i1", [{ type: "text", text: "[Request interrupted by user]" }])),
      ).toEqual([{ kind: "notice", id: "i1", ts: T, text: "Interrupted", status: "error" }]);
      expect(
        p.push(userBlocks("i2", "[Request interrupted by user for tool use]")),
      ).toEqual([{ kind: "notice", id: "i2", ts: T, text: "Interrupted", status: "error" }]);
      expect(p.entries().filter((e) => e.kind === "user")).toEqual([]);
    });
  });

  describe("harness text", () => {
    it("hides the text Claude Code writes for itself", () => {
      const p = new TranscriptParser();
      for (const [i, text] of [
        '<artifact-content-authored-by-others source="x">body</artifact-content-authored-by-others>',
        "This session is being continued from a previous conversation that ran out of context.",
        "Caveat: The messages below were generated by the user while running local commands.",
      ].entries()) {
        expect(p.push(userBlocks(`h${i}`, text))).toEqual([]);
      }
      expect(p.entries()).toEqual([]);
    });

    it("keeps user text in a tag it does not know", () => {
      const p = new TranscriptParser();
      const text = '<pasted_content id="1">some notes</pasted_content>';
      expect(p.push(userBlocks("pc", text))).toEqual([
        { kind: "user", id: "pc", ts: T, text },
      ]);
    });
  });

  describe("lines with no uuid", () => {
    it("are named by their byte offset", () => {
      const p = new TranscriptParser();
      const l = line({ type: "system", subtype: "compact_boundary" });
      expect(p.push(l, 812)).toEqual([
        { kind: "notice", id: "@812", ts: T, text: "Conversation compacted", status: "ok" },
      ]);
      // The same line at the same offset, as a re-read finds it, is not new.
      expect(p.push(l, 812)).toEqual([]);
      expect(p.push(l, 900)[0]).toMatchObject({ id: "@900" });
    });

    it("fall back to their order with no offset", () => {
      const p = new TranscriptParser();
      expect(p.push(line({ type: "system", subtype: "compact_boundary" }))[0]).toMatchObject({
        id: "line-0",
      });
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

describe("TranscriptParser tasks", () => {
  const launch = (id: string, name: string, input: Record<string, unknown>) =>
    assistant(`a-${id}`, [{ type: "tool_use", id, name, input }]);
  const result = (id: string, text: string, toolUseResult?: unknown, extra = {}) =>
    line({
      type: "user",
      uuid: `r-${id}`,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, ...extra }] },
      ...(toolUseResult === undefined ? {} : { toolUseResult }),
    });
  const notify = (uuid: string, toolUseId: string, status: string) =>
    userBlocks(
      uuid,
      `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>All done</summary>\n</task-notification>`,
    );

  it("tracks an async agent from launch to notification without a notice", () => {
    const p = new TranscriptParser();
    const [t] = p.push(
      launch("tu1", "Agent", { description: "Map sync", subagent_type: "Explore", model: "sonnet", run_in_background: true }),
    );
    expect(t).toMatchObject({
      kind: "task",
      id: "tu1",
      taskKind: "agent",
      title: "Map sync",
      agentType: "Explore",
      model: "sonnet",
      background: true,
      status: "running",
    });
    const [r] = p.push(result("tu1", "Async agent launched", { isAsync: true, status: "async_launched", agentId: "a688" }));
    expect(r).toMatchObject({ status: "running", taskRef: "a688" });
    expect((r as { result?: string }).result).toBeUndefined();
    const out = p.push(notify("n1", "tu1", "completed"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "task", id: "tu1", status: "ok", result: "All done" });
    expect(p.entries().filter((e) => e.kind === "notice")).toEqual([]);
  });

  it("resolves a foreground agent from its result", () => {
    const p = new TranscriptParser();
    p.push(launch("tu2", "Agent", { description: "Look" }));
    const [r] = p.push(result("tu2", "found it", { agentId: "b1" }));
    expect(r).toMatchObject({ status: "ok", result: "found it", taskRef: "b1", background: false });
  });

  it("marks a failed foreground agent as error", () => {
    const p = new TranscriptParser();
    p.push(launch("tu3", "Agent", {}));
    const [r] = p.push(result("tu3", "boom", undefined, { is_error: true }));
    expect(r).toMatchObject({ title: "Agent", status: "error", result: "boom" });
  });

  it("tracks a background Bash and its killed notification", () => {
    const p = new TranscriptParser();
    const [t] = p.push(launch("tu4", "Bash", { command: "sleep 99\necho hi", run_in_background: true }));
    expect(t).toMatchObject({ kind: "task", taskKind: "shell", title: "sleep 99", background: true, status: "running" });
    const [r] = p.push(result("tu4", "Command running in background with ID: bjl", { backgroundTaskId: "bjl" }));
    expect(r).toMatchObject({ status: "running", taskRef: "bjl" });
    expect((r as { result?: string }).result).toBeUndefined();
    expect(p.push(notify("n2", "tu4", "killed"))[0]).toMatchObject({ status: "killed", result: "All done" });
  });

  it("keeps a foreground Bash as a tool", () => {
    const p = new TranscriptParser();
    expect(p.push(launch("tu5", "Bash", { command: "ls" }))[0].kind).toBe("tool");
  });

  it("still makes a notice for a notification with an unknown tool-use-id", () => {
    const p = new TranscriptParser();
    const [n] = p.push(notify("n3", "nope", "failed"));
    expect(n).toMatchObject({ kind: "notice", text: "All done", status: "error" });
  });

  it("parses the legacy Task tool name", () => {
    const p = new TranscriptParser();
    expect(p.push(launch("tu6", "Task", { subagent_type: "general-purpose" }))[0]).toMatchObject({
      kind: "task",
      taskKind: "agent",
      title: "general-purpose",
    });
  });

  it("tolerates a result with no toolUseResult and a malformed notification", () => {
    const p = new TranscriptParser();
    p.push(launch("tu7", "Agent", { description: "d", run_in_background: true }));
    const [r] = p.push(result("tu7", "ok", "weird"));
    expect(r).toMatchObject({ status: "running" });
    expect(p.push(userBlocks("n4", "<task-notification><tool-use-id>tu7</tool-use-id></task-notification>"))).toEqual([]);
    expect(p.entries().find((e) => e.id === "tu7")).toMatchObject({ status: "running" });
  });

  it("reads run_in_background written as the string \"true\"", () => {
    const p = new TranscriptParser();
    expect(p.push(launch("s1", "Agent", { description: "d", run_in_background: "true" }))[0]).toMatchObject({ background: true });
    expect(p.push(launch("s2", "Bash", { command: "x", run_in_background: "true" }))[0]).toMatchObject({ kind: "task" });
  });

  it("marks an async result as background whatever the input said", () => {
    const p = new TranscriptParser();
    p.push(launch("s3", "Agent", { description: "d" }));
    const [r] = p.push(result("s3", "launched", { isAsync: true, agentId: "a1" }));
    expect(r).toMatchObject({ background: true, status: "running" });
  });

  const queued = (uuid: string, toolUseId: string, taskId = "t1") =>
    line({
      type: "attachment",
      uuid,
      attachment: {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/x</output-file>\n<status>completed</status>\n<summary>All done</summary>\n</task-notification>`,
        origin: { kind: "task-notification" },
      },
    });

  it("settles a task from a queued_command attachment", () => {
    const p = new TranscriptParser();
    p.push(launch("q1", "Agent", { description: "d", run_in_background: "true" }));
    p.push(result("q1", "launched", { isAsync: true, agentId: "a1" }));
    const out = p.push(queued("qa", "q1"));
    expect(out[0]).toMatchObject({ kind: "task", id: "q1", status: "ok", result: "All done" });
    // The same notification later as a user line updates again, no notice.
    p.push(notify("qu", "q1", "completed"));
    expect(p.entries().filter((e) => e.kind === "notice")).toEqual([]);
  });

  it("makes one notice for an unmatched notification delivered in both forms", () => {
    const p = new TranscriptParser();
    expect(p.push(queued("qb", "gone", "t9"))[0]).toMatchObject({ kind: "notice" });
    const text = `<task-notification>\n<task-id>t9</task-id>\n<tool-use-id>gone</tool-use-id>\n<status>completed</status>\n<summary>All done</summary>\n</task-notification>`;
    expect(p.push(userBlocks("qc", text))).toEqual([]);
    expect(p.entries().filter((e) => e.kind === "notice")).toHaveLength(1);
  });

  const queuedPrompt = (uuid: string, prompt: unknown, origin: unknown = { kind: "human" }) =>
    line({
      type: "attachment",
      uuid,
      isSidechain: false,
      attachment: {
        type: "queued_command",
        prompt,
        source_uuid: "s1",
        delivery_id: "d1",
        commandMode: "prompt",
        origin,
        timestamp: T,
        humanTurn: true,
      },
    });

  it("shows a prompt queued mid-turn as a user entry, in order", () => {
    const p = new TranscriptParser();
    p.push(assistant("a1", [{ type: "text", text: "working" }]));
    expect(p.push(queuedPrompt("qp", "remote hosts require 22"))).toEqual([
      { kind: "user", id: "qp", ts: T, text: "remote hosts require 22" },
    ]);
    p.push(assistant("a2", [{ type: "text", text: "noted" }]));
    expect(p.entries().map((e) => e.id)).toEqual(["a1:0", "qp", "a2:0"]);
  });

  it("reads a queued prompt like a typed one", () => {
    const p = new TranscriptParser();
    expect(p.push(queuedPrompt("qs", "<command-name>/compact</command-name>"))[0]).toMatchObject({
      kind: "command",
      name: "compact",
    });
    expect(p.push(queuedPrompt("qm", "<system-reminder>x</system-reminder>"))).toEqual([]);
    expect(p.push(queuedPrompt("qo", "from a hook", { kind: "hook" }))).toEqual([]);
  });

  it("keeps the text of a queued prompt with a pasted image", () => {
    const p = new TranscriptParser();
    const prompt = [
      { type: "text", text: "what is this? [Image #2]" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ];
    expect(p.push(queuedPrompt("qi", prompt))).toEqual([
      { kind: "user", id: "qi", ts: T, text: "what is this? [Image #2]" },
    ]);
    expect(p.push(queuedPrompt("qe", [{ type: "image" }]))).toEqual([]);
  });

  it("ignores a queued_command whose prompt is not a string", () => {
    const p = new TranscriptParser();
    expect(p.push(line({ type: "attachment", uuid: "z", attachment: { type: "queued_command", prompt: [{ type: "text", text: "hi" }] } }))).toEqual([]);
  });
});

describe("TranscriptParser — turn state", () => {
  /**
   * An assistant line as Claude Code writes it: one per content block, each
   * carrying the whole message's id, model and stop_reason.
   */
  function reply(
    uuid: string,
    block: Record<string, unknown>,
    stopReason: string | null,
    extra: Record<string, unknown> = {},
  ): string {
    return line({
      type: "assistant",
      uuid,
      parentUuid: "p",
      sessionId: "s1",
      isSidechain: false,
      requestId: "req_1",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [block],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 3, cache_read_input_tokens: 1000, output_tokens: 20 },
      },
      ...extra,
    });
  }
  const text = (t: string) => ({ type: "text", text: t });
  const tool = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "ls" } });
  const result = (uuid: string, id: string, extra = {}) =>
    userBlocks(uuid, [{ type: "tool_result", tool_use_id: id, content: "ok" }], {
      toolUseResult: { stdout: "ok" },
      ...extra,
    });

  it("is null before any line says", () => {
    const p = new TranscriptParser();
    expect(p.turnState()).toBeNull();
    p.push(line({ type: "attachment", uuid: "x", attachment: { type: "skill_listing", content: "" } }));
    expect(p.turnState()).toBeNull();
  });

  it("works through tool calls and is done at end_turn", () => {
    const p = new TranscriptParser();
    p.push(userBlocks("u1", "list the files"));
    expect(p.turnState()).toBe("working");
    p.push(reply("a1", { type: "thinking", thinking: "", signature: "x" }, "tool_use"));
    p.push(reply("a2", tool("t1"), "tool_use"));
    expect(p.turnState()).toBe("working");
    p.push(result("u2", "t1"));
    expect(p.turnState()).toBe("working");
    // The final message's thinking and text lines both carry end_turn.
    p.push(reply("a3", { type: "thinking", thinking: "", signature: "x" }, "end_turn"));
    p.push(reply("a4", text("Here they are."), "end_turn"));
    expect(p.turnState()).toBe("done");
    // Claude Code's bookkeeping after a turn leaves it done.
    p.push(line({ type: "system", subtype: "stop_hook_summary", uuid: "s1", hookCount: 1 }));
    p.push(line({ type: "system", subtype: "turn_duration", uuid: "s2", durationMs: 900 }));
    p.push(userBlocks("m1", "<system-reminder>x</system-reminder>", { isMeta: true }));
    expect(p.turnState()).toBe("done");
  });

  it.each(["stop_sequence", "max_tokens", "refusal"])("is done at %s", (reason) => {
    const p = new TranscriptParser();
    p.push(userBlocks("u1", "go"));
    p.push(reply("a1", text("stop"), reason));
    expect(p.turnState()).toBe("done");
  });

  it("is working on a line still streaming, with no stop_reason", () => {
    const p = new TranscriptParser();
    p.push(userBlocks("u1", "go"));
    p.push(reply("a1", text("Done."), "end_turn"));
    p.push(userBlocks("u2", "again"));
    p.push(reply("a2", text("partial"), null));
    expect(p.turnState()).toBe("working");
  });

  it("is done at a synthetic API error line", () => {
    const p = new TranscriptParser();
    p.push(userBlocks("u1", "go"));
    p.push(
      line({
        type: "assistant",
        uuid: "a1",
        isApiErrorMessage: true,
        message: {
          id: "x",
          role: "assistant",
          model: "<synthetic>",
          content: [text("API Error: overloaded")],
          stop_reason: "stop_sequence",
          usage: { input_tokens: 0 },
        },
      }),
    );
    expect(p.turnState()).toBe("done");
  });

  it("is interrupted when the user stops the turn, and working at the next prompt", () => {
    const p = new TranscriptParser();
    p.push(userBlocks("u1", "go"));
    p.push(reply("a1", tool("t1"), "tool_use"));
    p.push(
      userBlocks("u2", [
        { type: "tool_result", tool_use_id: "t1", content: "The user doesn't want to proceed", is_error: true },
      ]),
    );
    p.push(userBlocks("u3", [{ type: "text", text: "[Request interrupted by user for tool use]" }]));
    expect(p.turnState()).toBe("interrupted");
    p.push(userBlocks("u4", "try again"));
    expect(p.turnState()).toBe("working");
  });

  it("is working again at a queued prompt or a task notification", () => {
    const p = new TranscriptParser();
    p.push(userBlocks("u1", "go"));
    p.push(reply("a1", text("Done."), "end_turn"));
    p.push(
      line({
        type: "attachment",
        uuid: "q1",
        attachment: { type: "queued_command", commandMode: "prompt", prompt: "and one more" },
      }),
    );
    expect(p.turnState()).toBe("working");
    p.push(reply("a2", text("Done."), "end_turn"));
    p.push(
      userBlocks(
        "n1",
        "<task-notification><task-id>b1</task-id><status>completed</status><summary>Agent finished</summary></task-notification>",
      ),
    );
    expect(p.turnState()).toBe("working");
  });

  it("is working at a slash command, and back where it was after a local one", () => {
    const p = new TranscriptParser();
    p.push(userBlocks("u1", "go"));
    p.push(reply("a1", text("Done."), "end_turn"));
    p.push(userBlocks("c1", "<command-name>/model</command-name><command-args></command-args>"));
    expect(p.turnState()).toBe("working");
    p.push(
      line({
        type: "system",
        subtype: "local_command",
        uuid: "c2",
        content: "<local-command-stdout>Set model to opus</local-command-stdout>",
      }),
    );
    expect(p.turnState()).toBe("done");
    // Written as system lines (2.1.308), the same.
    p.push(line({ type: "system", subtype: "local_command", uuid: "m1", content: "<command-name>/login</command-name>" }));
    expect(p.turnState()).toBe("working");
    p.push(line({ type: "system", subtype: "local_command", uuid: "m2", content: "<local-command-stdout>ok</local-command-stdout>" }));
    expect(p.turnState()).toBe("done");
    // A skill command does start a turn; a later stray output doesn't undo the reply.
    p.push(userBlocks("c3", "<command-name>/review</command-name><command-args></command-args>"));
    p.push(reply("a2", tool("t2"), "tool_use"));
    p.push(
      line({ type: "system", subtype: "local_command", uuid: "c4", content: "<local-command-stdout>x</local-command-stdout>" }),
    );
    expect(p.turnState()).toBe("working");
  });

  it("never moves on sidechain lines", () => {
    const p = new TranscriptParser();
    p.push(userBlocks("u1", "go"));
    p.push(reply("a1", text("Done."), "end_turn"));
    p.push(userBlocks("s1", "subagent prompt", { isSidechain: true }));
    p.push(reply("s2", tool("t9"), "tool_use", { isSidechain: true }));
    expect(p.turnState()).toBe("done");
    // A task's own transcript (all sidechain) has no main-thread turn.
    const child = new TranscriptParser({ sidechain: true });
    child.push(userBlocks("s1", "subagent prompt", { isSidechain: true }));
    child.push(reply("s2", text("Done."), "end_turn", { isSidechain: true }));
    expect(child.turnState()).toBeNull();
  });

  it("is unmoved by a malformed line", () => {
    const p = new TranscriptParser();
    p.push(userBlocks("u1", "go"));
    p.push(reply("a1", text("Done."), "end_turn"));
    p.push("{not json");
    p.push(line({ type: "assistant", uuid: "a2", message: "nope" }));
    expect(p.turnState()).toBe("done");
  });
});

describe("TranscriptParser — edits", () => {
  const CWD = "/work/repo";
  const use = (id: string, name: string, input: Record<string, unknown>) =>
    assistant(`a-${id}`, [{ type: "tool_use", id, name, input }]);
  const landed = (id: string, toolUseResult: unknown, extra = {}) =>
    line({
      type: "user",
      uuid: `r-${id}`,
      cwd: CWD,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "The file has been updated.", ...extra }],
      },
      toolUseResult,
    });
  const hunk = (lines: string[], oldStart = 10, newStart = 10) => ({
    oldStart,
    oldLines: lines.filter((l) => !l.startsWith("+")).length,
    newStart,
    newLines: lines.filter((l) => !l.startsWith("-")).length,
    lines,
  });
  const editResult = (patch: unknown[], extra: Record<string, unknown> = {}) => ({
    filePath: `${CWD}/src/stream.ts`,
    oldString: "a",
    newString: "b",
    originalFile: "a",
    structuredPatch: patch,
    userModified: false,
    replaceAll: false,
    ...extra,
  });

  it("turns a landed Edit into an edit entry in the tool's place", () => {
    const p = new TranscriptParser();
    p.push(use("t0", "Read", { file_path: `${CWD}/src/stream.ts` }));
    p.push(use("t1", "Edit", { file_path: `${CWD}/src/stream.ts`, old_string: "a", new_string: "b" }));
    p.push(userBlocks("u9", "next"));
    const h = hunk(["   keep", "-  old", "+  new", "+  more", "\\ No newline at end of file"]);
    const out = p.push(landed("t1", editResult([h])));
    expect(out).toEqual([
      {
        kind: "edit",
        id: "t1",
        ts: T,
        name: "Edit",
        path: "src/stream.ts",
        hunks: [h],
        added: 2,
        removed: 1,
        truncated: false,
      },
    ]);
    expect(p.entries().map((e) => `${e.kind}:${e.id}`)).toEqual(["tool:t0", "edit:t1", "user:u9"]);
  });

  it("keeps a path outside the working directory as written", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Edit", { file_path: "/elsewhere/x.ts" }));
    const [e] = p.push(landed("t1", editResult([hunk(["+x"])], { filePath: "/elsewhere/x.ts" })));
    expect(e).toMatchObject({ kind: "edit", path: "/elsewhere/x.ts" });
  });

  it("counts every hunk of a MultiEdit", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "MultiEdit", { file_path: `${CWD}/a.ts`, edits: [] }));
    const [e] = p.push(
      landed("t1", editResult([hunk(["-a", "+b"], 1, 1), hunk([" c", "+d", "+e"], 20, 20)], { filePath: undefined })),
    );
    expect(e).toMatchObject({ kind: "edit", name: "MultiEdit", path: "a.ts", added: 3, removed: 1 });
    expect(e.kind === "edit" && e.hunks).toHaveLength(2);
  });

  it("leaves a failed or rejected edit a tool", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Edit", { file_path: `${CWD}/a.ts` }));
    p.push(use("t2", "Edit", { file_path: `${CWD}/b.ts` }));
    const [failed] = p.push(
      landed("t1", "Error: String to replace not found", { is_error: true, content: "String not found" }),
    );
    expect(failed).toMatchObject({ kind: "tool", status: "error", detail: "String not found" });
    // An error result that still carries a patch is still an error.
    const [rejected] = p.push(landed("t2", editResult([hunk(["+x"])]), { is_error: true }));
    expect(rejected).toMatchObject({ kind: "tool", status: "error" });
  });

  it("leaves an edit with no patch a tool", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Edit", { file_path: `${CWD}/a.ts` }));
    p.push(use("t2", "Write", { file_path: `${CWD}/b.ts` }));
    p.push(use("t3", "Edit", { file_path: `${CWD}/c.ts` }));
    expect(p.push(landed("t1", editResult([])))[0]).toMatchObject({ kind: "tool", status: "ok" });
    // A Write that changed nothing.
    expect(p.push(landed("t2", { type: "update", filePath: `${CWD}/b.ts`, content: "x", structuredPatch: [] }))[0])
      .toMatchObject({ kind: "tool", status: "ok" });
    expect(p.push(landed("t3", undefined))[0]).toMatchObject({ kind: "tool", status: "ok" });
  });

  it("never makes a card for a tool that doesn't edit", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Bash", { command: "sed -i s/a/b/ x" }));
    expect(p.push(landed("t1", editResult([hunk(["+x"])])))[0]).toMatchObject({ kind: "tool" });
  });

  it("skips malformed hunks and keeps the good ones", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Edit", { file_path: `${CWD}/a.ts` }));
    const good = hunk(["-a", "+b"]);
    const [e] = p.push(
      landed(
        "t1",
        editResult([
          null,
          "@@ -1 +1 @@",
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 },
          { oldStart: "1", oldLines: 1, newStart: 1, newLines: 1, lines: ["+x"] },
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [] },
          { ...good, lines: [...good.lines, 7, null] },
        ]),
      ),
    );
    expect(e).toMatchObject({ kind: "edit", added: 1, removed: 1, hunks: [good] });
  });

  it("leaves a tool when every hunk is malformed", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Edit", { file_path: `${CWD}/a.ts` }));
    expect(p.push(landed("t1", editResult([{ lines: "nope" }, 3])))[0]).toMatchObject({
      kind: "tool",
      status: "ok",
    });
  });

  it("caps hunks and lines, counting the whole patch first", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Edit", { file_path: `${CWD}/a.ts` }));
    const big = hunk(Array.from({ length: 450 }, (_, i) => `+line ${i}`), 1, 1);
    const small = Array.from({ length: 44 }, (_, i) => hunk(["-x", "+y"], 1000 + i * 10, 1000 + i * 10));
    const [e] = p.push(landed("t1", editResult([big, ...small])));
    if (e.kind !== "edit") throw new Error(`expected an edit, got ${e.kind}`);
    expect(e.added).toBe(450 + 44);
    expect(e.removed).toBe(44);
    expect(e.hunks).toHaveLength(40);
    expect(e.hunks[0].lines).toHaveLength(400);
    expect(e.truncated).toBe(true);
  });

  it("cuts a very long line and says so", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Edit", { file_path: `${CWD}/a.ts` }));
    const [e] = p.push(landed("t1", editResult([hunk([`+${"x".repeat(5000)}`])])));
    if (e.kind !== "edit") throw new Error(`expected an edit, got ${e.kind}`);
    expect(e.hunks[0].lines[0].length).toBeLessThan(1100);
    expect(e.truncated).toBe(true);
  });

  it("stops adding lines once the edit's text budget is spent, counting all of it", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Edit", { file_path: `${CWD}/a.ts` }));
    // 40 hunks of 400 lines of 1000 chars: ~16 MB uncapped.
    const wide = `+${"x".repeat(999)}`;
    const patch = Array.from({ length: 40 }, (_, i) => hunk(Array(400).fill(wide), i * 1000 + 1, i * 1000 + 1));
    const [e] = p.push(landed("t1", editResult(patch)));
    if (e.kind !== "edit") throw new Error(`expected an edit, got ${e.kind}`);
    expect(e.added).toBe(16_000);
    expect(e.truncated).toBe(true);
    const chars = e.hunks.flatMap((h) => h.lines).reduce((n, l) => n + l.length, 0);
    expect(chars).toBeLessThanOrEqual(64 * 1024);
    expect(chars).toBeGreaterThan(60 * 1024);
    expect(e.hunks).toHaveLength(1);
    expect(JSON.stringify(e).length).toBeLessThan(80 * 1024);
  });

  it("keeps a small edit whole under the budget", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Edit", { file_path: `${CWD}/a.ts` }));
    const patch = Array.from({ length: 30 }, (_, i) => hunk(Array(20).fill("+short line"), i * 100 + 1));
    const [e] = p.push(landed("t1", editResult(patch)));
    expect(e).toMatchObject({ kind: "edit", truncated: false, added: 600 });
    expect(e.kind === "edit" && e.hunks).toHaveLength(30);
  });

  it("shows a new file from Write as all added lines", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Write", { file_path: `${CWD}/new.md`, content: "# Title\n\nBody\n" }));
    const [e] = p.push(
      landed("t1", {
        type: "create",
        filePath: `${CWD}/new.md`,
        content: "# Title\n\nBody\n",
        structuredPatch: [],
        originalFile: null,
        userModified: false,
      }),
    );
    expect(e).toEqual({
      kind: "edit",
      id: "t1",
      ts: T,
      name: "Write",
      path: "new.md",
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ["+# Title", "+", "+Body"] }],
      added: 3,
      removed: 0,
      truncated: false,
    });
  });

  it("caps a long new file", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Write", { file_path: `${CWD}/big.txt` }));
    const content = Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n");
    const [e] = p.push(landed("t1", { type: "create", filePath: `${CWD}/big.txt`, content, structuredPatch: [] }));
    if (e.kind !== "edit") throw new Error(`expected an edit, got ${e.kind}`);
    expect(e.added).toBe(1000);
    expect(e.hunks[0].lines).toHaveLength(400);
    expect(e.truncated).toBe(true);
  });

  it("leaves an empty new file a tool", () => {
    const p = new TranscriptParser();
    p.push(use("t1", "Write", { file_path: `${CWD}/empty` }));
    expect(
      p.push(landed("t1", { type: "create", filePath: `${CWD}/empty`, content: "", structuredPatch: [] }))[0],
    ).toMatchObject({ kind: "tool", status: "ok" });
  });

  it("names a MultiEdit or NotebookEdit tool by its file", () => {
    const p = new TranscriptParser();
    const [m] = p.push(use("t1", "MultiEdit", { file_path: "/a/b.ts" }));
    const [n] = p.push(use("t2", "NotebookEdit", { notebook_path: "/a/c.ipynb" }));
    expect(m).toMatchObject({ summary: "/a/b.ts" });
    expect(n).toMatchObject({ summary: "/a/c.ipynb" });
  });
});
