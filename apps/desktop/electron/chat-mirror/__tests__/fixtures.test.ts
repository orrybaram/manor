/**
 * Golden tests over real Claude Code transcripts, scrubbed by
 * `scripts/scrub-transcript.ts`. Each fixture is named for the Claude Code
 * version that wrote it and what it shows. Its golden is what the parser
 * makes of it; a parser change that moves one shows up as a golden diff.
 *
 * Update the goldens with `pnpm vitest run -u` and read the diff.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../adapters/claude";
import { TranscriptStream } from "../stream";
import { TranscriptParser, type ChatEntry, type ChatPush } from "../transcript";
import { LocalTranscriptSource } from "../transcript-source";

const FIXTURES = path.join(__dirname, "..", "__fixtures__");
const fixtures = fs
  .readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".jsonl"))
  .sort();

function load(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/** The parser over the whole fixture, each line named by its byte offset. */
function parse(name: string): TranscriptParser {
  const parser = new TranscriptParser();
  let offset = 0;
  for (const l of load(name).split("\n").slice(0, -1)) {
    parser.push(l, offset);
    offset += Buffer.byteLength(l, "utf8") + 1;
  }
  return parser;
}

function entries(name: string): ChatEntry[] {
  return parse(name).entries();
}

function byKind<K extends ChatEntry["kind"]>(es: ChatEntry[], kind: K): Extract<ChatEntry, { kind: K }>[] {
  return es.filter((e): e is Extract<ChatEntry, { kind: K }> => e.kind === kind);
}

describe("scrubbed transcript fixtures", () => {
  it("has fixtures, each named for the Claude Code version that wrote it", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) {
      expect(f).toMatch(/^claude-code-\d+\.\d+\.\d+-[a-z0-9-]+\.jsonl$/);
      const version = /^claude-code-(\d+\.\d+\.\d+)-/.exec(f)![1];
      const versions = new Set(
        load(f)
          .split("\n")
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { version?: string }).version)
          .filter(Boolean),
      );
      expect([...versions]).toEqual([version]);
    }
  });

  describe.each(fixtures)("%s", (name) => {
    it("parses to its golden", async () => {
      const parser = parse(name);
      const golden = {
        turnState: parser.turnState(),
        contextTokens: parser.contextTokens(),
        skills: parser.skills().length,
        entries: parser.entries(),
      };
      await expect(JSON.stringify(golden, null, 2) + "\n").toMatchFileSnapshot(
        path.join(FIXTURES, "golden", name.replace(/\.jsonl$/, ".json")),
      );
    });

    describe("through the stream", () => {
      let dir: string;
      let file: string;

      beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-fixture-"));
        file = path.join(dir, "t.jsonl");
      });

      afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });

      /** Read the file as it is appended in `chunks`, reading after each. */
      async function tail(chunks: Buffer[]) {
        const pushes: ChatPush[] = [];
        const stream = new TranscriptStream({
          label: "fixture",
          adapter: claudeAdapter,
          pollIntervalMs: 60_000,
          unwatchedPollIntervalMs: 60_000,
          onPush: (p) => pushes.push(p),
        });
        fs.writeFileSync(file, "");
        stream.point({ path: file, adapter: claudeAdapter, source: new LocalTranscriptSource() }, false);
        try {
          for (const c of chunks) {
            fs.appendFileSync(file, c);
            await stream.read();
          }
        } finally {
          stream.release();
        }
        const latest = new Map<string, ChatPush>();
        for (const p of pushes) latest.set(p.id, p);
        const turn = latest.get("turn");
        const usage = latest.get("usage");
        latest.delete("turn");
        latest.delete("usage");
        return {
          entries: [...latest.values()],
          turnState: turn?.kind === "turn" ? turn.state : null,
          contextTokens: usage?.kind === "usage" ? usage.contextTokens : null,
        };
      }

      it("reads the same whole as tailed in chunks that split lines and characters", async () => {
        const bytes = Buffer.from(load(name), "utf8");
        const whole = await tail([bytes]);
        const parser = parse(name);
        expect(whole).toEqual({
          entries: parser.entries(),
          turnState: parser.turnState(),
          contextTokens: parser.contextTokens(),
        });

        // Odd sizes, so cuts land mid-line and, in places, mid-character.
        const sizes = [1, 13, 257, 4093, 65_537];
        const chunks: Buffer[] = [];
        for (let at = 0, i = 0; at < bytes.length; i++) {
          const n = sizes[i % sizes.length];
          chunks.push(bytes.subarray(at, at + n));
          at += n;
        }
        expect(await tail(chunks)).toEqual(whole);
      });
    });
  });
});

describe("what the fixtures show", () => {
  it("a queued prompt is a user entry, in order; a peer's queued message is not", () => {
    const es = entries("claude-code-2.1.309-queued-prompts.jsonl");
    const users = byKind(es, "user");
    expect(users).toHaveLength(2);
    // Each lands after the tool call it was queued behind.
    const firstUser = es.indexOf(users[0]);
    expect(es.slice(0, firstUser).some((e) => e.kind === "tool" && e.name === "Skill")).toBe(true);

    const peer = entries("claude-code-2.1.308-queued-peer-messages.jsonl");
    expect(byKind(peer, "user")).toEqual([]);
  });

  it("a queued prompt with a pasted image keeps its text", () => {
    const es = entries("claude-code-2.1.301-edits-and-queued-image.jsonl");
    const users = byKind(es, "user");
    expect(users.length).toBeGreaterThan(0);
    expect(users[0].text).toMatch(/^\[\w+ #\d+\]$/);
  });

  it("a queued task notification is a notice, made once", () => {
    const es = entries("claude-code-2.1.308-queued-peer-messages.jsonl");
    const notices = byKind(es, "notice");
    expect(notices).toHaveLength(2);
    expect(new Set(notices.map((n) => n.text)).size).toBe(2);
  });

  it("a background agent runs until its notification settles it", () => {
    const tasks = byKind(entries("claude-code-2.1.300-background-agents.jsonl"), "task");
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.taskKind === "agent" && t.background && t.taskRef)).toBe(true);
    expect(tasks.map((t) => t.status).sort()).toEqual(["ok", "running"]);
    expect(tasks.find((t) => t.status === "ok")?.result).toBeTruthy();
  });

  it("an interrupt is a notice, not a user bubble, and interrupts the turn", () => {
    const parser = parse("claude-code-2.1.302-slash-command-and-interrupt.jsonl");
    const es = parser.entries();
    expect(es[es.length - 1]).toMatchObject({ kind: "notice", text: "Interrupted", status: "error" });
    expect(byKind(es, "user").some((u) => u.text.includes("[Request interrupted"))).toBe(false);
    expect(parser.turnState()).toBe("interrupted");
  });

  it("an error tool result settles its tool as an error, its content written before its id", () => {
    const es = entries("claude-code-2.1.302-slash-command-and-interrupt.jsonl");
    const raw = load("claude-code-2.1.302-slash-command-and-interrupt.jsonl");
    expect(raw).toMatch(/"content":"[^"]*","is_error":true,"tool_use_id"/);
    expect(byKind(es, "tool").some((t) => t.status === "error" && t.detail)).toBe(true);
  });

  it("a slash command is a command entry, and its caveat is hidden", () => {
    const es = entries("claude-code-2.1.302-slash-command-and-interrupt.jsonl");
    expect(es[0]).toMatchObject({ kind: "command", name: "clear", args: "" });
    expect(es.some((e) => "text" in e && e.text.includes("local-command-caveat"))).toBe(false);
  });

  it("a ! command is a command entry, with no output when Claude Code says there was none", () => {
    const raw = load("claude-code-2.1.300-bang-command.jsonl");
    expect(raw).toContain("<bash-stdout>(Bash completed with no output)</bash-stdout>");
    const commands = byKind(entries("claude-code-2.1.300-bang-command.jsonl"), "command");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ shell: true, args: "" });
    expect(commands[0].output).toBeUndefined();
  });

  it("a compaction is one notice; the summary prompt after it is hidden", () => {
    const es = entries("claude-code-2.1.308-compaction.jsonl");
    expect(byKind(es, "notice").filter((n) => n.text === "Conversation compacted")).toHaveLength(1);
    expect(byKind(es, "user").some((u) => u.text.startsWith("This session is being continued"))).toBe(false);
  });

  it("a synthetic API error line is shown and ends the turn, without moving the context size", () => {
    const parser = parse("claude-code-2.1.308-compaction.jsonl");
    const es = parser.entries();
    // The error, then the /login it asked for.
    expect(es[es.length - 2]?.kind).toBe("assistant");
    expect(parser.turnState()).toBe("done");
    expect(parser.contextTokens()).toBeGreaterThan(0);
  });

  it("a local command written as system lines is a command entry with its output, and starts no turn", () => {
    const es = entries("claude-code-2.1.308-compaction.jsonl");
    expect(es[es.length - 1]).toMatchObject({ kind: "command", name: "login", args: "" });
    expect((es[es.length - 1] as { output?: string }).output).toBeTruthy();
  });

  it("an end_turn line ends the turn", () => {
    expect(parse("claude-code-2.1.300-bang-command.jsonl").turnState()).toBe("done");
  });

  it("a landed Edit is an edit entry with its structuredPatch", () => {
    const edits = byKind(entries("claude-code-2.1.301-edits-and-queued-image.jsonl"), "edit");
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) {
      expect(e.name).toBe("Edit");
      expect(e.added + e.removed).toBeGreaterThan(0);
      expect(e.hunks.every((h) => h.lines.every((l) => /^[-+ \\]/.test(l)))).toBe(true);
    }
  });

  it("a Write that creates a file is an edit entry of added lines", () => {
    const [w] = byKind(entries("claude-code-2.1.308-question-and-write.jsonl"), "edit");
    expect(w).toMatchObject({ name: "Write", removed: 0 });
    expect(w.added).toBeGreaterThan(0);
    expect(w.hunks[0].lines.every((l) => l.startsWith("+"))).toBe(true);
  });

  it("an answered AskUserQuestion is a question with its answer", () => {
    const [q] = byKind(entries("claude-code-2.1.308-question-and-write.jsonl"), "question");
    expect(q.questions.length).toBeGreaterThan(0);
    expect(q.questions[0].options.length).toBeGreaterThan(0);
    expect(q.answer).toBeTruthy();
  });

  it("a declined AskUserQuestion is declined, with no answer", () => {
    const [q] = byKind(entries("claude-code-2.1.296-question-declined.jsonl"), "question");
    expect(q).toMatchObject({ answer: null, declined: true });
  });

  it("pasted content stays visible", () => {
    const users = byKind(entries("claude-code-2.1.301-pasted-content.jsonl"), "user");
    expect(users.some((u) => u.text.includes("<pasted_content"))).toBe(true);
  });
});
