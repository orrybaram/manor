import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalTranscriptSource,
  type TranscriptRead,
  type TranscriptSource,
} from "../transcript-source";
import { ChatMirror, type PaneAgent } from "../mirror";
import type { ChatPush } from "../transcript";

const T = "2026-01-01T00:00:00.000Z";
const PANE = "pane-1";

function line(obj: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: T, ...obj }) + "\n";
}

function user(uuid: string, text: string): string {
  return line({ type: "user", uuid, message: { role: "user", content: text } });
}

function assistant(uuid: string, content: unknown[]): string {
  return line({ type: "assistant", uuid, message: { role: "assistant", content } });
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

const QUESTION = {
  question: "Which color?",
  header: "Color",
  options: [
    { label: "Red", description: "warm" },
    { label: "Blue", description: "cool" },
  ],
  multiSelect: false,
};

function ask(uuid: string, id: string, multiSelect = false): string {
  return assistant(uuid, [
    {
      type: "tool_use",
      id,
      name: "AskUserQuestion",
      input: { questions: [{ ...QUESTION, multiSelect }] },
    },
  ]);
}

function plan(uuid: string, id: string): string {
  return assistant(uuid, [
    { type: "tool_use", id, name: "ExitPlanMode", input: { plan: "Do it" } },
  ]);
}

/** A background `Agent` launch, and its result naming the subagent's agentId. */
function launch(toolUseId: string, agentId: string): string {
  return (
    assistant(`a-${toolUseId}`, [
      {
        type: "tool_use",
        id: toolUseId,
        name: "Agent",
        input: { description: "Explore", subagent_type: "Explore", prompt: "go", run_in_background: true },
      },
    ]) +
    line({
      type: "user",
      uuid: `r-${toolUseId}`,
      toolUseResult: { isAsync: true, status: "async_launched", agentId },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Async agent launched" }],
      },
    })
  );
}

function finished(uuid: string, toolUseId: string): string {
  return user(
    uuid,
    `<task-notification><tool-use-id>${toolUseId}</tool-use-id><status>completed</status><summary>done</summary></task-notification>`,
  );
}

/** A line of a subagent's own transcript: every one is a sidechain line. */
function side(uuid: string, text: string): string {
  return line({ type: "user", uuid, isSidechain: true, message: { role: "user", content: text } });
}

/** Let the mirror's file reads settle without touching (possibly fake) timers. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("condition never became true");
}

describe("ChatMirror", () => {
  let dir: string;
  let agent: PaneAgent | null;
  let published: { paneId: string; entry: ChatPush }[];
  let taskPublished: { paneId: string; taskId: string; entry: ChatPush }[];
  let writes: { paneId: string; data: string }[];
  let mirror: ChatMirror;
  let source: TranscriptSource;

  function file(name: string, content = ""): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  function makeMirror(): ChatMirror {
    return new ChatMirror({
      agentForPane: (paneId) => (paneId === PANE ? agent : null),
      write: (paneId, data) => writes.push({ paneId, data }),
      publish: (paneId, entry) => published.push({ paneId, entry }),
      publishTask: (paneId, taskId, entry) => taskPublished.push({ paneId, taskId, entry }),
      sourceFor: () => source,
      pollIntervalMs: 10,
      unwatchedPollIntervalMs: 10,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mirror-"));
    agent = null;
    published = [];
    taskPublished = [];
    writes = [];
    source = new LocalTranscriptSource();
    mirror = makeMirror();
  });

  afterEach(() => {
    mirror.dispose();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("history", () => {
    it("says why a pane has no chat", async () => {
      expect(await mirror.getHistory("other")).toEqual({ ok: false, reason: "no-agent" });
      agent = { hostId: "local", agentKind: "claude", transcriptPath: null };
      expect(await mirror.getHistory(PANE)).toEqual({ ok: false, reason: "no-transcript" });
    });

    it("has no chat for an agent without an adapter (ADR-224 D1)", async () => {
      agent = {
        hostId: "local",
        agentKind: "codex",
        transcriptPath: file("t.jsonl", user("u1", "hi")),
      };
      expect(await mirror.getHistory(PANE)).toEqual({
        ok: false,
        reason: "unsupported-agent",
      });
    });

    it("reads an agent on a remote host through its source (ADR-216 D4)", async () => {
      agent = { hostId: "devbox", agentKind: "claude", transcriptPath: file("t.jsonl", user("u1", "hi")) };
      expect(await mirror.getHistory(PANE)).toEqual({
        ok: true,
        entries: [{ kind: "user", id: "u1", ts: T, text: "hi" }],
        contextTokens: null,
      });
    });

    it("treats a transcript that is not written yet as empty", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: path.join(dir, "missing.jsonl") };
      expect(await mirror.getHistory(PANE)).toEqual({ ok: true, entries: [], contextTokens: null });
    });

    it("reads the transcript from the start without publishing it", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("t.jsonl", user("u1", "hi")) };
      const history = await mirror.getHistory(PANE);
      expect(history).toEqual({
        ok: true,
        entries: [{ kind: "user", id: "u1", ts: T, text: "hi" }],
        contextTokens: null,
      });
      expect(published).toEqual([]);
    });
  });

  describe("commands (ADR-217 D3)", () => {
    function listing(names: Record<string, string>, isInitial = true): string {
      return line({
        type: "attachment",
        attachment: {
          type: "skill_listing",
          isInitial,
          names: Object.keys(names),
          content: Object.entries(names)
            .map(([n, d]) => `- ${n}: ${d}`)
            .join("\n"),
        },
      });
    }

    async function commands() {
      const result = await mirror.getCommands(PANE);
      if (!result.ok) throw new Error(result.reason);
      return result;
    }

    it("merges built-ins with the transcript's skills, sorted by name", async () => {
      agent = {
        hostId: "local",
        agentKind: "claude",
        transcriptPath: file("t.jsonl", listing({ zeta: "Last", alpha: "First" }) + user("u1", "hi")),
      };
      const result = await commands();
      expect(result.skillsKnown).toBe(true);
      expect(result.commands.filter((c) => c.source === "skill")).toEqual([
        { name: "alpha", description: "First", source: "skill" },
        { name: "zeta", description: "Last", source: "skill" },
      ]);
      expect(result.commands.some((c) => c.name === "clear" && c.source === "builtin")).toBe(true);
      const names = result.commands.map((c) => c.name);
      expect(names).toEqual([...names].sort());
    });

    it("has built-ins only, and skillsKnown false, before any listing", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("t.jsonl", "") };
      const result = await commands();
      expect(result.skillsKnown).toBe(false);
      expect(result.commands.every((c) => c.source === "builtin")).toBe(true);
      expect(result.commands.length).toBeGreaterThan(0);
    });

    it("keeps the previous skills when the transcript changes to one with no listing", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("a.jsonl", listing({ alpha: "First" })) };
      await commands();
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("b.jsonl", user("u1", "hi")) };
      const result = await commands();
      expect(result.skillsKnown).toBe(true);
      expect(result.commands.filter((c) => c.source === "skill")).toEqual([
        { name: "alpha", description: "First", source: "skill" },
      ]);
    });

    it("lets a skill replace the built-in of the same name", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("t.jsonl", listing({ review: "My review" })) };
      const result = await commands();
      expect(result.commands.filter((c) => c.name === "review")).toEqual([
        { name: "review", description: "My review", source: "skill" },
      ]);
    });

    it("says why a pane has no commands, and host-offline on a failed read", async () => {
      expect(await mirror.getCommands("other")).toEqual({ ok: false, reason: "no-agent" });
      source = { read: () => Promise.resolve({ ok: false, error: "host offline" }) };
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("t.jsonl", "") };
      expect(await mirror.getCommands(PANE)).toEqual({ ok: false, reason: "host-offline" });
    });
  });

  describe("tailing", () => {
    it("publishes appended lines to the pane while watched", async () => {
      const p = file("t.jsonl", user("u1", "hi"));
      agent = { hostId: "local", agentKind: "claude", transcriptPath: p };
      mirror.setWatched(PANE, true);
      await mirror.getHistory(PANE);

      fs.appendFileSync(p, assistant("a1", [{ type: "text", text: "hello" }]));
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect(published[0]).toEqual({
        paneId: PANE,
        entry: { kind: "assistant", id: "a1:0", ts: T, text: "hello" },
      });

      fs.appendFileSync(p, assistant("a2", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]));
      fs.appendFileSync(p, toolResult("u2", "t1", "file.txt"));
      await vi.waitFor(() => expect(published).toHaveLength(3));
      expect(published.map((x) => x.entry)).toMatchObject([
        { id: "a1:0" },
        { id: "t1", status: "pending" },
        { id: "t1", status: "ok", detail: "file.txt" },
      ]);
    });

    it("carries the context size in history and publishes a usage entry when it changes", async () => {
      const said = (uuid: string, text: string, input: number) =>
        line({
          type: "assistant",
          uuid,
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            usage: { input_tokens: input, cache_read_input_tokens: 1000 },
          },
        });
      const p = file("t.jsonl", said("a1", "hi", 5));
      agent = { hostId: "local", agentKind: "claude", transcriptPath: p };
      mirror.setWatched(PANE, true);
      expect(await mirror.getHistory(PANE)).toMatchObject({ contextTokens: 1005 });
      expect(published).toEqual([]);

      // The same size again (another block of one message) publishes no usage.
      fs.appendFileSync(p, said("a2", "same", 5));
      await vi.waitFor(() => expect(published).toHaveLength(1));
      fs.appendFileSync(p, said("a3", "more", 50));
      await vi.waitFor(() => expect(published).toHaveLength(3));
      expect(published.map((x) => x.entry.kind)).toEqual(["assistant", "assistant", "usage"]);
      expect(published[2].entry).toMatchObject({ kind: "usage", id: "usage", contextTokens: 1050 });
      expect(await mirror.getHistory(PANE)).toMatchObject({ contextTokens: 1050 });
    });

    it("stops publishing once nobody watches, and catches up on the next watch", async () => {
      const p = file("t.jsonl", user("u1", "hi"));
      agent = { hostId: "local", agentKind: "claude", transcriptPath: p };
      mirror.setWatched(PANE, true);
      await mirror.getHistory(PANE);
      mirror.setWatched(PANE, false);

      fs.appendFileSync(p, user("u2", "while away"));
      await new Promise((r) => setTimeout(r, 50));
      expect(published).toEqual([]);

      mirror.setWatched(PANE, true);
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect(published[0].entry).toMatchObject({ id: "u2", text: "while away" });
    });

    it("holds a partial trailing line until its newline arrives", async () => {
      const p = file("t.jsonl");
      agent = { hostId: "local", agentKind: "claude", transcriptPath: p };
      await mirror.getHistory(PANE);

      // Split inside the two bytes of "é", as two writes might.
      const bytes = Buffer.from(user("u1", "héllo"), "utf8");
      const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
      fs.appendFileSync(p, bytes.subarray(0, cut));
      expect(await mirror.getHistory(PANE)).toEqual({ ok: true, entries: [], contextTokens: null });

      fs.appendFileSync(p, bytes.subarray(cut));
      expect(await mirror.getHistory(PANE)).toEqual({
        ok: true,
        entries: [{ kind: "user", id: "u1", ts: T, text: "héllo" }],
        contextTokens: null,
      });
      expect(published.map((x) => x.entry.id)).toEqual(["u1"]);
    });

    it("resets and re-reads when the pane's transcript path changes", async () => {
      const a = file("a.jsonl", user("u1", "old session"));
      const b = file("b.jsonl", user("u9", "new session"));
      agent = { hostId: "local", agentKind: "claude", transcriptPath: a };
      mirror.setWatched(PANE, true);
      expect(await mirror.getHistory(PANE)).toMatchObject({ entries: [{ id: "u1" }] });

      agent = { hostId: "local", agentKind: "claude", transcriptPath: b };
      mirror.agentChanged(PANE);
      expect(await mirror.getHistory(PANE)).toEqual({
        ok: true,
        entries: [{ kind: "user", id: "u9", ts: T, text: "new session" }],
        contextTokens: null,
      });
      // The new file is tailed; the old one is not.
      fs.appendFileSync(a, user("u2", "stale"));
      fs.appendFileSync(b, user("u10", "fresh"));
      await vi.waitFor(() => expect(published.map((x) => x.entry.id)).toContain("u10"));
      expect(published.map((x) => x.entry.id)).not.toContain("u2");
    });
  });

  describe("unreadable transcript", () => {
    /** The local file, until `offline` is set. */
    let offline: boolean;
    beforeEach(() => {
      offline = false;
      const local = new LocalTranscriptSource();
      source = {
        read: (p, offset): Promise<TranscriptRead> =>
          offline
            ? Promise.resolve({ ok: false, error: "host offline" })
            : local.read(p, offset),
      };
    });

    it("answers host-offline for history, then recovers on the next read", async () => {
      const p = file("t.jsonl", user("u1", "hi"));
      agent = { hostId: "local", agentKind: "claude", transcriptPath: p };
      offline = true;
      expect(await mirror.getHistory(PANE)).toEqual({ ok: false, reason: "host-offline" });

      offline = false;
      expect(await mirror.getHistory(PANE)).toEqual({
        ok: true,
        entries: [{ kind: "user", id: "u1", ts: T, text: "hi" }],
        contextTokens: null,
      });
    });

    it("keeps a subscriber's entries while offline and publishes what follows once back", async () => {
      const p = file("t.jsonl", user("u1", "hi"));
      agent = { hostId: "local", agentKind: "claude", transcriptPath: p };
      mirror.setWatched(PANE, true);
      await mirror.getHistory(PANE);

      offline = true;
      fs.appendFileSync(p, user("u2", "while offline"));
      await new Promise((r) => setTimeout(r, 50));
      expect(published).toEqual([]);
      expect(await mirror.getHistory(PANE)).toEqual({ ok: false, reason: "host-offline" });

      offline = false;
      await vi.waitFor(() => expect(published).toHaveLength(1));
      expect(published[0].entry).toMatchObject({ id: "u2", text: "while offline" });
      expect(await mirror.getHistory(PANE)).toMatchObject({
        ok: true,
        entries: [{ id: "u1" }, { id: "u2" }],
      });
    });

    it("refuses an answer it cannot check, and types nothing", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("t.jsonl", plan("a1", "p1")) };
      await mirror.getHistory(PANE);
      offline = true;
      expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({
        ok: false,
        reason: "host-offline",
      });
      expect(writes).toEqual([]);
    });
  });

  describe("answer", () => {
    it("types the encoded answer for the newest open question", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("t.jsonl", ask("a1", "q1")) };
      const result = await mirror.answer(PANE, "q1", {
        kind: "question",
        answers: [{ kind: "option", indexes: [1] }],
      });
      expect(result).toEqual({ ok: true });
      expect(writes).toEqual([{ paneId: PANE, data: "\x1b[B\r" }]);
    });

    it("approves a plan with Enter", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("t.jsonl", plan("a1", "p1")) };
      expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({ ok: true });
      expect(writes).toEqual([{ paneId: PANE, data: "\r" }]);
    });

    it("refuses a stale answer and types nothing", async () => {
      const p = file("t.jsonl", ask("a1", "q1") + ask("a2", "q2"));
      agent = { hostId: "local", agentKind: "claude", transcriptPath: p };
      const pick = { kind: "question" as const, answers: [{ kind: "option" as const, indexes: [0] }] };

      // Not the newest picker.
      expect(await mirror.answer(PANE, "q1", pick)).toEqual({ ok: false, reason: "stale" });
      // No such picker.
      expect(await mirror.answer(PANE, "nope", pick)).toEqual({ ok: false, reason: "stale" });
      // A double tap: the first goes through, the second does not.
      const [first, second] = await Promise.all([
        mirror.answer(PANE, "q2", pick),
        mirror.answer(PANE, "q2", pick),
      ]);
      expect([first, second]).toEqual([{ ok: true }, { ok: false, reason: "stale" }]);
      expect(writes).toHaveLength(1);

      // Answered already (on the desktop, say).
      fs.appendFileSync(p, toolResult("u1", "q2", "answered") + plan("a3", "p1") + toolResult("u2", "p1", "ok"));
      expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({ ok: false, reason: "stale" });
      expect(writes).toHaveLength(1);
    });

    it("refuses what the encoder can't express, or the wrong kind of answer", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("t.jsonl", ask("a1", "q1", true)) };
      expect(
        await mirror.answer(PANE, "q1", { kind: "question", answers: [{ kind: "other", text: "green" }] }),
      ).toEqual({ ok: false, reason: "unsupported" });
      expect(await mirror.answer(PANE, "q1", { kind: "plan-approve" })).toEqual({
        ok: false,
        reason: "unsupported",
      });
      expect(writes).toEqual([]);
    });

    it("answers a pane on a remote host", async () => {
      agent = { hostId: "devbox", agentKind: "claude", transcriptPath: file("t.jsonl", plan("a1", "p1")) };
      expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({ ok: true });
      expect(writes).toEqual([{ paneId: PANE, data: "\r" }]);
    });
  });

  describe("needs-terminal timeout", () => {
    beforeEach(() => {
      // Timers only: the mirror's file reads must still resolve.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      mirror.dispose();
      mirror = makeMirror();
    });

    it("marks the entry needsTerminal when no tool_result arrives in time", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("t.jsonl", plan("a1", "p1")) };
      expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({ ok: true });

      vi.advanceTimersByTime(7_999);
      await new Promise((r) => setImmediate(r));
      expect(published).toEqual([]);

      vi.advanceTimersByTime(1);
      await until(() => published.length > 0);
      expect(published[0]).toEqual({
        paneId: PANE,
        entry: { kind: "plan", id: "p1", ts: T, plan: "Do it", outcome: null, needsTerminal: true },
      });
      // The history says so too, and the answer is never retried.
      expect(await mirror.getHistory(PANE)).toMatchObject({ entries: [{ id: "p1", needsTerminal: true }] });
      expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({ ok: false, reason: "stale" });
      expect(writes).toHaveLength(1);
    });

    it("does nothing when the tool_result arrives in time", async () => {
      const p = file("t.jsonl", plan("a1", "p1"));
      agent = { hostId: "local", agentKind: "claude", transcriptPath: p };
      await mirror.answer(PANE, "p1", { kind: "plan-approve" });
      fs.appendFileSync(p, toolResult("u1", "p1", "approved"));

      vi.advanceTimersByTime(8_000);
      // The watcher's publish of the result can lag under a loaded suite:
      // wait for it, then enough turns for an expiry's read to have run,
      // had it fired.
      await until(() => published.length > 0);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(published.map((x) => x.entry)).toEqual([
        { kind: "plan", id: "p1", ts: T, plan: "Do it", outcome: "approved" },
      ]);
    });
  });

  describe("task streams (ADR-224 D3)", () => {
    /** The parent at `<dir>/sess.jsonl`, and agent `agentId`'s transcript beside it. */
    function session(parent: string): string {
      fs.mkdirSync(path.join(dir, "sess", "subagents"), { recursive: true });
      return file("sess.jsonl", parent);
    }
    function childFile(agentId: string): string {
      return path.join(dir, "sess", "subagents", `agent-${agentId}.jsonl`);
    }

    it("reads a task's own transcript, sidechain lines and all", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: session(launch("toolu_1", "ag1")) };
      fs.writeFileSync(childFile("ag1"), side("s1", "go") + assistant("s2", [{ type: "text", text: "on it" }]));
      expect(await mirror.getTaskHistory(PANE, "toolu_1")).toEqual({
        ok: true,
        entries: [
          { kind: "user", id: "s1", ts: T, text: "go" },
          { kind: "assistant", id: "s2:0", ts: T, text: "on it" },
        ],
        contextTokens: null,
      });
      expect(taskPublished).toEqual([]);
      expect(published).toEqual([]);
    });

    it("says no-transcript for an unknown task, or one with no transcript", async () => {
      expect(await mirror.getTaskHistory("other", "toolu_1")).toEqual({ ok: false, reason: "no-agent" });
      const bg = assistant("a1", [
        { type: "tool_use", id: "bash1", name: "Bash", input: { command: "sleep 9", run_in_background: true } },
      ]);
      agent = { hostId: "local", agentKind: "claude", transcriptPath: session(bg + user("u1", "hi")) };
      expect(await mirror.getTaskHistory(PANE, "nope")).toEqual({ ok: false, reason: "no-transcript" });
      expect(await mirror.getTaskHistory(PANE, "u1")).toEqual({ ok: false, reason: "no-transcript" });
      expect(await mirror.getTaskHistory(PANE, "bash1")).toEqual({ ok: false, reason: "no-transcript" });
    });

    it("reads a missing transcript as empty, and fills in once it is written", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: session(launch("toolu_1", "ag1")) };
      expect(await mirror.getTaskHistory(PANE, "toolu_1")).toEqual({ ok: true, entries: [], contextTokens: null });
      fs.writeFileSync(childFile("ag1"), side("s1", "go"));
      expect(await mirror.getTaskHistory(PANE, "toolu_1")).toMatchObject({ ok: true, entries: [{ id: "s1" }] });
    });

    it("tails a watched task through publishTask, and nothing through publish", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: session(launch("toolu_1", "ag1")) };
      fs.writeFileSync(childFile("ag1"), side("s1", "go"));
      mirror.setTaskWatched(PANE, "toolu_1", true);
      expect(await mirror.getTaskHistory(PANE, "toolu_1")).toMatchObject({ entries: [{ id: "s1" }] });

      fs.appendFileSync(childFile("ag1"), assistant("s2", [{ type: "text", text: "found it" }]));
      await vi.waitFor(() => expect(taskPublished).toHaveLength(1));
      expect(taskPublished[0]).toEqual({
        paneId: PANE,
        taskId: "toolu_1",
        entry: { kind: "assistant", id: "s2:0", ts: T, text: "found it" },
      });
      expect(published).toEqual([]);
    });

    it("starts tailing a task watched before its agentId was known", async () => {
      const parent = session(
        assistant("a1", [
          { type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Explore", prompt: "go" } },
        ]),
      );
      agent = { hostId: "local", agentKind: "claude", transcriptPath: parent };
      fs.writeFileSync(childFile("ag1"), side("s1", "go"));
      mirror.setWatched(PANE, true);
      mirror.setTaskWatched(PANE, "toolu_1", true);
      expect(await mirror.getTaskHistory(PANE, "toolu_1")).toEqual({ ok: false, reason: "no-transcript" });

      fs.appendFileSync(
        parent,
        line({
          type: "user",
          uuid: "r1",
          toolUseResult: { agentId: "ag1" },
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        }),
      );
      await vi.waitFor(() => expect(published.map((x) => x.entry.id)).toContain("toolu_1"));
      fs.appendFileSync(childFile("ag1"), side("s2", "more"));
      await vi.waitFor(() => expect(taskPublished.map((x) => x.entry.id)).toContain("s2"));
    });

    it("drops the task streams when the pane's transcript resets", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: session(launch("toolu_1", "ag1")) };
      fs.writeFileSync(childFile("ag1"), side("s1", "go"));
      mirror.setTaskWatched(PANE, "toolu_1", true);
      await mirror.getTaskHistory(PANE, "toolu_1");

      // `/clear`: a new transcript, which has no such task.
      agent = { hostId: "local", agentKind: "claude", transcriptPath: file("next.jsonl", user("u1", "fresh")) };
      mirror.agentChanged(PANE);
      fs.appendFileSync(childFile("ag1"), side("s2", "stale"));
      await new Promise((r) => setTimeout(r, 50));
      expect(taskPublished).toEqual([]);
      expect(await mirror.getTaskHistory(PANE, "toolu_1")).toEqual({ ok: false, reason: "no-transcript" });
    });

    it("drops the task streams when the pane closes", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: session(launch("toolu_1", "ag1")) };
      fs.writeFileSync(childFile("ag1"), side("s1", "go"));
      mirror.setTaskWatched(PANE, "toolu_1", true);
      await mirror.getTaskHistory(PANE, "toolu_1");
      mirror.closePane(PANE);
      fs.appendFileSync(childFile("ag1"), side("s2", "after"));
      await new Promise((r) => setTimeout(r, 50));
      expect(taskPublished).toEqual([]);
    });

    it("marks a task with a transcript the adapter can find, in history and in pushes", async () => {
      agent = { hostId: "local", agentKind: "claude", transcriptPath: session(launch("toolu_1", "ag1")) };
      const history = await mirror.getHistory(PANE);
      expect(history.ok && history.entries.find((e) => e.id === "toolu_1")).toMatchObject({
        kind: "task",
        hasTranscript: true,
      });

      mirror.setWatched(PANE, true);
      fs.appendFileSync(agent.transcriptPath!, finished("n1", "toolu_1"));
      await vi.waitFor(() =>
        expect(published.find((p) => p.entry.id === "toolu_1")?.entry).toMatchObject({
          status: "ok",
          hasTranscript: true,
        }),
      );
    });

    it.each([
      ["running", ""],
      ["finished", finished("n1", "toolu_1")],
    ])("drops a %s task's stream when unwatched", async (_state, tail) => {
      const parent = session(launch("toolu_1", "ag1") + tail);
      agent = { hostId: "local", agentKind: "claude", transcriptPath: parent };
      fs.writeFileSync(childFile("ag1"), side("s1", "go"));
      mirror.setTaskWatched(PANE, "toolu_1", true);
      await mirror.getTaskHistory(PANE, "toolu_1");
      mirror.setTaskWatched(PANE, "toolu_1", false);

      fs.appendFileSync(childFile("ag1"), side("s2", "late"));
      mirror.setTaskWatched(PANE, "toolu_1", true);
      // A fresh stream: its first read is history, not events.
      expect(await mirror.getTaskHistory(PANE, "toolu_1")).toMatchObject({
        entries: [{ id: "s1" }, { id: "s2" }],
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(taskPublished).toEqual([]);
    });
  });
});

describe("ChatMirror — poke and poll (ADR-216 D3)", () => {
  /** A source with no `watch`, whose reads finish when the test says. */
  let reads: { offset: number; finish: (r: TranscriptRead) => void }[];
  let agent: PaneAgent | null;
  let published: ChatPush[];
  let mirror: ChatMirror;
  let content: string;

  const source: TranscriptSource = {
    read: (_path, offset) =>
      new Promise<TranscriptRead>((resolve) => {
        reads.push({ offset, finish: resolve });
      }),
  };

  /** Finish the oldest unfinished read with the file as it is now. */
  function finishRead(): void {
    const read = reads.find((r) => r.finish !== noop);
    if (!read) throw new Error("no read in flight");
    const bytes = Buffer.from(content);
    read.finish({
      ok: true,
      size: bytes.length,
      data: bytes.subarray(read.offset).toString("utf8"),
    });
    read.finish = noop;
  }
  const noop = () => {};
  const flush = () => new Promise((r) => setImmediate(r));

  function make(pollMs: number): ChatMirror {
    return new ChatMirror({
      agentForPane: (paneId) => (paneId === PANE ? agent : null),
      write: () => {},
      publish: (_paneId, entry) => published.push(entry),
      publishTask: () => {},
      sourceFor: () => source,
      unwatchedPollIntervalMs: pollMs,
    });
  }

  beforeEach(() => {
    reads = [];
    published = [];
    content = user("u1", "hi");
    agent = { hostId: "devbox", agentKind: "claude", transcriptPath: "/remote/t.jsonl" };
    mirror = make(60_000);
  });

  afterEach(() => {
    mirror.dispose();
    vi.useRealTimers();
  });

  /** Subscribe, and let the first read finish. */
  async function watch(): Promise<void> {
    mirror.setWatched(PANE, true);
    await until(() => reads.length === 1);
    finishRead();
    await flush();
  }

  it("does nothing for a pane nobody is subscribed to", async () => {
    mirror.poke(PANE);
    mirror.poke("other");
    await flush();
    expect(reads).toEqual([]);
  });

  it("reads on a poke and publishes what is new", async () => {
    await watch();
    content += user("u2", "more");
    mirror.poke(PANE);
    await until(() => reads.length === 2);
    expect(reads[1].offset).toBe(Buffer.byteLength(user("u1", "hi")));
    finishRead();
    await until(() => published.length === 1);
    expect(published[0]).toMatchObject({ id: "u2", text: "more" });
  });

  it("never overlaps reads: pokes during one coalesce into a single read again", async () => {
    await watch();
    mirror.poke(PANE);
    await until(() => reads.length === 2);
    // Read 2 is in flight; these all join one more.
    mirror.poke(PANE);
    mirror.poke(PANE);
    mirror.poke(PANE);
    await flush();
    expect(reads).toHaveLength(2);
    finishRead();
    await until(() => reads.length === 3);
    finishRead();
    await flush();
    expect(reads).toHaveLength(3);
  });

  it("polls a source without watch only from the first subscriber to the last", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    mirror.dispose();
    mirror = make(2_000);

    vi.advanceTimersByTime(10_000);
    expect(reads).toHaveLength(0);

    await watch();
    vi.advanceTimersByTime(2_000);
    await until(() => reads.length === 2);
    finishRead();
    await flush();
    vi.advanceTimersByTime(2_000);
    await until(() => reads.length === 3);
    finishRead();
    await flush();

    mirror.setWatched(PANE, false);
    vi.advanceTimersByTime(10_000);
    mirror.poke(PANE);
    await flush();
    expect(reads).toHaveLength(3);
  });

  it("is host-offline while reads fail, and catches up on the next poke", async () => {
    await watch();
    content += user("u2", "while away");
    mirror.poke(PANE);
    await until(() => reads.length === 2);
    reads[1].finish({ ok: false, error: "host offline" });
    reads[1].finish = noop;
    await flush();

    const history = mirror.getHistory(PANE);
    await until(() => reads.length === 3);
    reads[2].finish({ ok: false, error: "host offline" });
    reads[2].finish = noop;
    expect(await history).toEqual({ ok: false, reason: "host-offline" });
    expect(published).toEqual([]);

    mirror.poke(PANE);
    await until(() => reads.length === 4);
    finishRead();
    await until(() => published.length === 1);
    expect(published[0]).toMatchObject({ id: "u2" });
  });

  it("steps over a line the source says to skip, and reads on after it", async () => {
    const big = user("big", "x".repeat(100));
    content = user("u1", "hi") + big + user("u2", "after");
    mirror.setWatched(PANE, true);
    await until(() => reads.length === 1);
    // The first read stops before the long line, as a capped read would.
    reads[0].finish({ ok: true, size: Buffer.byteLength(content), data: user("u1", "hi") + "{" });
    reads[0].finish = noop;
    await flush();

    mirror.poke(PANE);
    await until(() => reads.length === 2);
    const at = Buffer.byteLength(user("u1", "hi"));
    expect(reads[1].offset).toBe(at);
    reads[1].finish({ ok: true, size: Buffer.byteLength(content), data: "", skip: Buffer.byteLength(big) });
    reads[1].finish = noop;
    await until(() => reads.length === 3);
    expect(reads[2].offset).toBe(at + Buffer.byteLength(big));
    finishRead();
    await until(() => published.length === 1);
    expect(published.map((e) => e.id)).toEqual(["u2"]);
  });
});

describe("ChatMirror — task streams on a source without watch (ADR-224 D3)", () => {
  const PARENT = "/remote/sess.jsonl";
  const CHILD = "/remote/sess/subagents/agent-ag1.jsonl";
  let files: Map<string, string>;
  let reads: string[];
  let taskPublished: ChatPush[];
  let mirror: ChatMirror;

  /** A remote host's files: posix paths, no change signal, only pokes and a slow poll. */
  const source: TranscriptSource = {
    read: (p, offset) => {
      reads.push(p);
      const bytes = Buffer.from(files.get(p) ?? "");
      return Promise.resolve({
        ok: true,
        size: bytes.length,
        data: bytes.subarray(offset).toString("utf8"),
      });
    },
  };

  beforeEach(() => {
    files = new Map([[PARENT, launch("toolu_1", "ag1")], [CHILD, side("s1", "go")]]);
    reads = [];
    taskPublished = [];
    mirror = new ChatMirror({
      agentForPane: (paneId) =>
        paneId === PANE ? { hostId: "devbox", agentKind: "claude", transcriptPath: PARENT } : null,
      write: () => {},
      publish: () => {},
      publishTask: (_paneId, _taskId, entry) => taskPublished.push(entry),
      sourceFor: () => source,
      unwatchedPollIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    mirror.dispose();
  });

  it("reads a watched task's transcript on a poke", async () => {
    mirror.setTaskWatched(PANE, "toolu_1", true);
    expect(await mirror.getTaskHistory(PANE, "toolu_1")).toMatchObject({ entries: [{ id: "s1" }] });
    await until(() => reads.includes(CHILD));

    files.set(CHILD, files.get(CHILD) + side("s2", "more"));
    reads = [];
    mirror.poke(PANE);
    await until(() => taskPublished.length === 1);
    expect(taskPublished[0]).toMatchObject({ id: "s2", text: "more" });
    // Nobody watches the pane's own chat, so the poke left its transcript alone.
    expect(reads).toEqual([CHILD]);
  });

  it("does not read an unwatched task's transcript on a poke", async () => {
    await mirror.getTaskHistory(PANE, "toolu_1");
    reads = [];
    mirror.poke(PANE);
    await new Promise((r) => setImmediate(r));
    expect(reads).toEqual([]);
  });
});
