/**
 * The Codex rollout as a chat. The fixture is written by hand in the shape
 * Codex CLI writes a legacy rollout (no real session: the repo is public);
 * its golden is what the parser makes of it.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseUnifiedPatch, type ChatEntry } from "../../transcript";
import { codexAdapter, CodexRolloutParser } from "../codex";

const FIXTURES = path.join(__dirname, "..", "..", "__fixtures__", "codex");
const FIXTURE = "codex-cli-0.130.0-shell-patch-interrupt.jsonl";
const T = "2026-01-01T00:00:00.000Z";

function parseFixture(name = FIXTURE): CodexRolloutParser {
  const parser = new CodexRolloutParser();
  let offset = 0;
  for (const l of fs.readFileSync(path.join(FIXTURES, name), "utf8").split("\n").slice(0, -1)) {
    parser.push(l, offset);
    offset += Buffer.byteLength(l, "utf8") + 1;
  }
  return parser;
}

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: T, type, payload });
}

const item = (payload: Record<string, unknown>) => line("response_item", payload);
const event = (payload: Record<string, unknown>) => line("event_msg", payload);

function of<K extends ChatEntry["kind"]>(es: ChatEntry[], kind: K): Extract<ChatEntry, { kind: K }>[] {
  return es.filter((e): e is Extract<ChatEntry, { kind: K }> => e.kind === kind);
}

describe("the Codex fixture", () => {
  it("parses to its golden", async () => {
    const parser = parseFixture();
    const golden = {
      turnState: parser.turnState(),
      contextTokens: parser.contextTokens(),
      entries: parser.entries(),
    };
    await expect(JSON.stringify(golden, null, 2) + "\n").toMatchFileSnapshot(
      path.join(FIXTURES, "golden", FIXTURE.replace(/\.jsonl$/, ".json")),
    );
  });

  it("reads the prompts as typed, never Codex's injected context, each once", () => {
    const users = of(parseFixture().entries(), "user").map((e) => e.text);
    expect(users).toEqual([
      "Make greet() take a name, and add a test.",
      "Now run the whole suite\nand fix what fails.",
      "Leave it, thanks.",
    ]);
  });

  it("reads each reply once, though the item and its agent_message both carry it", () => {
    expect(of(parseFixture().entries(), "assistant").map((e) => e.text)).toEqual([
      "`greet()` now takes a `name`, and `src/greet.test.ts` checks it. The test passes.",
      "Leaving `src/math.ts` as it is.",
    ]);
  });

  it("pairs shell calls with their outputs, failing on a non-zero exit or a stop", () => {
    const tools = of(parseFixture().entries(), "tool");
    expect(tools.map((t) => [t.id, t.name, t.summary, t.status])).toEqual([
      ["call_shell_1", "shell", "cat src/greet.ts", "ok"],
      ["call_exec_1", "shell", "pnpm vitest run src/greet.test.ts", "ok"],
      ["call_shell_2", "shell", "pnpm test", "error"],
      ["call_shell_3", "shell", "sed -n 1,40p src/math.ts", "error"],
    ]);
    expect(tools[0].detail).toContain('return "Hello, world"');
    expect(tools[1].detail).toMatch(/^ ✓ src\/greet\.test\.ts/);
    expect(tools[2].detail).toContain("AssertionError");
  });

  it("turns a landed apply_patch into an edit card per file, relative to the session's cwd", () => {
    const edits = of(parseFixture().entries(), "edit");
    expect(edits.map((e) => [e.id, e.name, e.path, e.added, e.removed])).toEqual([
      ["call_patch_1", "apply_patch", "src/greet.ts", 2, 2],
      ["call_patch_1#1", "apply_patch", "src/greet.test.ts", 5, 0],
    ]);
    expect(edits[0].hunks).toEqual([
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          "-export function greet(): string {",
          '-  return "Hello, world";',
          "+export function greet(name: string): string {",
          "+  return `Hello, ${name}`;",
          " }",
        ],
      },
    ]);
  });

  it("marks the stop and one compaction, in order", () => {
    const es = parseFixture().entries();
    expect(of(es, "notice").map((n) => [n.text, n.status])).toEqual([
      ["Interrupted", "error"],
      ["Conversation compacted", "ok"],
    ]);
    const kinds = es.map((e) => e.kind);
    expect(kinds.indexOf("notice")).toBeGreaterThan(kinds.lastIndexOf("tool"));
  });

  it("ends done, with the newest token_count's context", () => {
    const parser = parseFixture();
    expect(parser.turnState()).toBe("done");
    expect(parser.contextTokens()).toBe(4230);
  });
});

describe("CodexRolloutParser", () => {
  it("moves the turn: started, aborted, started, complete", () => {
    const p = new CodexRolloutParser();
    expect(p.turnState()).toBeNull();
    p.push(event({ type: "task_started", turn_id: "t1" }));
    expect(p.turnState()).toBe("working");
    p.push(event({ type: "turn_aborted", turn_id: "t1", reason: "interrupted" }), 10);
    expect(p.turnState()).toBe("interrupted");
    p.push(event({ type: "turn_started", turn_id: "t2" }));
    expect(p.turnState()).toBe("working");
    p.push(event({ type: "turn_complete", turn_id: "t2", last_agent_message: null }));
    expect(p.turnState()).toBe("done");
  });

  it("settles a tool from an output that arrives before the patch event, and still shows the edit", () => {
    const p = new CodexRolloutParser();
    p.push(item({ type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch" }));
    expect(p.entry("c1")).toMatchObject({ kind: "tool", name: "apply_patch", summary: "a.txt", status: "pending" });
    p.push(item({ type: "custom_tool_call_output", call_id: "c1", output: "Success." }));
    expect(p.entry("c1")).toMatchObject({ kind: "tool", status: "ok" });
    const out = p.push(
      event({ type: "patch_apply_end", call_id: "c1", success: true, changes: { "a.txt": { type: "add", content: "x\n" } } }),
    );
    expect(out).toEqual([
      expect.objectContaining({ kind: "edit", id: "c1", path: "a.txt", added: 1, removed: 0 }),
    ]);
  });

  it("settles an apply_patch whose output isn't a success as an error, with no patch event", () => {
    for (const output of [
      "apply_patch verification failed: Failed to find expected lines in src/a.ts",
      "patch rejected by user",
      JSON.stringify({ output: "error: invalid hunk at line 3", metadata: { exit_code: 1 } }),
    ]) {
      const p = new CodexRolloutParser();
      p.push(item({ type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" }));
      p.push(item({ type: "custom_tool_call_output", call_id: "c1", output }));
      expect(p.entry("c1")).toMatchObject({ kind: "tool", status: "error" });
      expect((p.entry("c1") as { detail?: string }).detail).toBeTruthy();
    }
  });

  it("settles a refused shell call as an error, but not a command that printed the words", () => {
    const p = new CodexRolloutParser();
    const call = (id: string) =>
      item({ type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: "rm -rf build" }) });
    p.push(call("c1"));
    p.push(item({ type: "function_call_output", call_id: "c1", output: "exec command rejected by user" }));
    p.push(call("c2"));
    p.push(item({ type: "function_call_output", call_id: "c2", output: "rejected by configuration" }));
    p.push(call("c3"));
    p.push(
      item({
        type: "function_call_output",
        call_id: "c3",
        output: "Process exited with code 0\nOutput:\nrequest rejected by user\n",
      }),
    );
    expect([p.entry("c1"), p.entry("c2"), p.entry("c3")].map((e) => e?.kind === "tool" && e.status)).toEqual([
      "error",
      "error",
      "ok",
    ]);
  });

  it("keeps a multi-file patch's cards together, ahead of a call that ran alongside it", () => {
    const p = new CodexRolloutParser();
    p.push(item({ type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "" }));
    p.push(item({ type: "function_call", call_id: "c2", name: "shell", arguments: JSON.stringify({ command: ["ls"] }) }));
    p.push(
      event({
        type: "patch_apply_end",
        call_id: "c1",
        success: true,
        changes: {
          "a.txt": { type: "add", content: "a\n" },
          "b.txt": { type: "add", content: "b\n" },
          "c.txt": { type: "add", content: "c\n" },
        },
      }),
    );
    expect(p.entries().map((e) => e.id)).toEqual(["c1", "c1#1", "c1#2", "c2"]);
  });

  it("settles a failed patch as an error with its stderr", () => {
    const p = new CodexRolloutParser();
    p.push(item({ type: "function_call", call_id: "c1", name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: b.ts\n@@\n-a\n+b\n*** End Patch" }) }));
    p.push(event({ type: "patch_apply_end", call_id: "c1", success: false, stderr: "Failed to find context", changes: {} }));
    expect(p.entry("c1")).toMatchObject({ kind: "tool", summary: "b.ts", status: "error", detail: "Failed to find context" });
  });

  it("names a moved file by where it ends up, and shows a deleted one as removed lines", () => {
    const p = new CodexRolloutParser();
    p.push(line("session_meta", { id: "s", cwd: "/w" }));
    p.push(item({ type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "" }));
    p.push(
      event({
        type: "patch_apply_end",
        call_id: "c1",
        success: true,
        changes: {
          "/w/old.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n", move_path: "/w/new.ts" },
          "/w/gone.ts": { type: "delete", content: "x\ny\n" },
        },
      }),
    );
    expect(p.entries()).toMatchObject([
      { kind: "edit", id: "c1", path: "new.ts", added: 1, removed: 1 },
      { kind: "edit", id: "c1#1", path: "gone.ts", added: 0, removed: 2, hunks: [{ oldStart: 1, oldLines: 2, lines: ["-x", "-y"] }] },
    ]);
  });

  it("reads a local_shell_call and a hosted web search", () => {
    const p = new CodexRolloutParser();
    p.push(item({ type: "local_shell_call", call_id: "c1", status: "completed", action: { type: "exec", command: ["ls", "-la"] } }));
    p.push(item({ type: "function_call_output", call_id: "c1", output: { content: "a\nb", success: true } }));
    p.push(item({ type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "vitest snapshot" } }));
    expect(p.entries()).toMatchObject([
      { kind: "tool", id: "c1", name: "shell", summary: "ls -la", status: "ok", detail: "a\nb" },
      { kind: "tool", id: "ws_1", name: "web_search", summary: "vitest snapshot", status: "ok" },
    ]);
  });

  it("reads a paginated rollout's messages from its completed items, not its response items", () => {
    const p = new CodexRolloutParser();
    p.push(line("session_meta", { id: "s", cwd: "/w", history_mode: "paginated" }));
    p.push(event({ type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "hi" }] } }));
    p.push(item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }), 50);
    p.push(event({ type: "item_completed", item: { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "hello" }] } }));
    expect(p.entries()).toMatchObject([
      { kind: "user", id: "u1", text: "hi" },
      { kind: "assistant", id: "a1", text: "hello" },
    ]);
  });

  it("skips reasoning, developer messages, malformed lines and unknown records", () => {
    const p = new CodexRolloutParser();
    expect(p.push("{not json")).toEqual([]);
    expect(p.push(item({ type: "reasoning", summary: [{ type: "summary_text", text: "hm" }] }))).toEqual([]);
    expect(p.push(item({ type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] }))).toEqual([]);
    expect(p.push(event({ type: "agent_reasoning", text: "hm" }))).toEqual([]);
    expect(p.push(line("something_new", { a: 1 }))).toEqual([]);
    expect(p.entries()).toEqual([]);
  });

  it("names a line with no id of its own by its offset, so a re-read and a tail agree", () => {
    const a = new CodexRolloutParser();
    const b = new CodexRolloutParser();
    const l = event({ type: "user_message", message: "hi" });
    expect(a.push(l, 120)).toEqual(b.push(l, 120));
    expect(a.entries()[0].id).toBe("@120");
  });

  it("settles a pending call whose output line was too long to read", () => {
    const p = new CodexRolloutParser();
    p.push(item({ type: "function_call", call_id: "call_big", name: "shell", arguments: '{"command":["cat","big.log"]}' }));
    const head = '{"timestamp":"2026-01-01T00:00:00.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_big","output":"aaaa';
    expect(p.oversized({ head, tail: 'aaaa"}}' })).toEqual([
      expect.objectContaining({ id: "call_big", status: "error", detail: "Output too large to show" }),
    ]);
  });
});

describe("parseUnifiedPatch, on Codex's update diffs", () => {
  it("reads several hunks and skips file headers", () => {
    expect(parseUnifiedPatch("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10 +10,2 @@\n-z\n+y\n+w\n")).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+c"] },
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: ["-z", "+y", "+w"] },
    ]);
  });

  it("keeps a removed line that looks like a file header", () => {
    expect(parseUnifiedPatch("@@ -1 +1 @@\n--- x\n+++ y\n")).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["--- x", "+++ y"] },
    ]);
  });

  it("counts a no-newline marker neither added nor removed on the card", () => {
    const p = new CodexRolloutParser();
    p.push(item({ type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "" }));
    p.push(
      event({
        type: "patch_apply_end",
        call_id: "c1",
        success: true,
        changes: { "a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n" } },
      }),
    );
    expect(p.entry("c1")).toMatchObject({ kind: "edit", added: 1, removed: 1 });
  });
});

describe("codexAdapter.promptWrites", () => {
  it("pastes the text, newlines and all, then presses Enter on its own", () => {
    expect(codexAdapter.promptWrites("fix it\r\nthen test")).toEqual([
      "\x1b[200~fix it\nthen test\x1b[201~",
      "\r",
    ]);
  });

  it("drops control bytes, so the text can't end the paste early", () => {
    expect(codexAdapter.promptWrites("a\x1b[201~b")).toEqual(["\x1b[200~a[201~b\x1b[201~", "\r"]);
  });

  it("has no task transcripts yet", () => {
    expect(
      codexAdapter.childTranscriptPath("/r.jsonl", {
        kind: "task",
        id: "c",
        ts: T,
        taskKind: "agent",
        title: "x",
        background: false,
        status: "running",
      }),
    ).toBeNull();
  });
});
