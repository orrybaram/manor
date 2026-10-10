import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalTranscriptSource } from "../transcript-source";
import { ChatMirror, pickPaneAgent, type PaneAgent } from "../mirror";
import type { ChatEntry } from "../transcript";

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
  let published: { paneId: string; entry: ChatEntry }[];
  let writes: { paneId: string; data: string }[];
  let mirror: ChatMirror;

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
      sourceFor: () => new LocalTranscriptSource(),
      pollIntervalMs: 10,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-mirror-"));
    agent = null;
    published = [];
    writes = [];
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
      agent = { hostId: "local", transcriptPath: null };
      expect(await mirror.getHistory(PANE)).toEqual({ ok: false, reason: "no-transcript" });
      agent = { hostId: "devbox", transcriptPath: file("t.jsonl") };
      expect(await mirror.getHistory(PANE)).toEqual({ ok: false, reason: "remote" });
    });

    it("treats a transcript that is not written yet as empty", async () => {
      agent = { hostId: "local", transcriptPath: path.join(dir, "missing.jsonl") };
      expect(await mirror.getHistory(PANE)).toEqual({ ok: true, entries: [] });
    });

    it("reads the transcript from the start without publishing it", async () => {
      agent = { hostId: "local", transcriptPath: file("t.jsonl", user("u1", "hi")) };
      const history = await mirror.getHistory(PANE);
      expect(history).toEqual({
        ok: true,
        entries: [{ kind: "user", id: "u1", ts: T, text: "hi" }],
      });
      expect(published).toEqual([]);
    });
  });

  describe("tailing", () => {
    it("publishes appended lines to the pane while watched", async () => {
      const p = file("t.jsonl", user("u1", "hi"));
      agent = { hostId: "local", transcriptPath: p };
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

    it("stops publishing once nobody watches, and catches up on the next watch", async () => {
      const p = file("t.jsonl", user("u1", "hi"));
      agent = { hostId: "local", transcriptPath: p };
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
      agent = { hostId: "local", transcriptPath: p };
      await mirror.getHistory(PANE);

      // Split inside the two bytes of "é", as two writes might.
      const bytes = Buffer.from(user("u1", "héllo"), "utf8");
      const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
      fs.appendFileSync(p, bytes.subarray(0, cut));
      expect(await mirror.getHistory(PANE)).toEqual({ ok: true, entries: [] });

      fs.appendFileSync(p, bytes.subarray(cut));
      expect(await mirror.getHistory(PANE)).toEqual({
        ok: true,
        entries: [{ kind: "user", id: "u1", ts: T, text: "héllo" }],
      });
      expect(published.map((x) => x.entry.id)).toEqual(["u1"]);
    });

    it("resets and re-reads when the pane's transcript path changes", async () => {
      const a = file("a.jsonl", user("u1", "old session"));
      const b = file("b.jsonl", user("u9", "new session"));
      agent = { hostId: "local", transcriptPath: a };
      mirror.setWatched(PANE, true);
      expect(await mirror.getHistory(PANE)).toMatchObject({ entries: [{ id: "u1" }] });

      agent = { hostId: "local", transcriptPath: b };
      mirror.agentChanged(PANE);
      expect(await mirror.getHistory(PANE)).toEqual({
        ok: true,
        entries: [{ kind: "user", id: "u9", ts: T, text: "new session" }],
      });
      // The new file is tailed; the old one is not.
      fs.appendFileSync(a, user("u2", "stale"));
      fs.appendFileSync(b, user("u10", "fresh"));
      await vi.waitFor(() => expect(published.map((x) => x.entry.id)).toContain("u10"));
      expect(published.map((x) => x.entry.id)).not.toContain("u2");
    });
  });

  describe("answer", () => {
    it("types the encoded answer for the newest open question", async () => {
      agent = { hostId: "local", transcriptPath: file("t.jsonl", ask("a1", "q1")) };
      const result = await mirror.answer(PANE, "q1", {
        kind: "question",
        answers: [{ kind: "option", indexes: [1] }],
      });
      expect(result).toEqual({ ok: true });
      expect(writes).toEqual([{ paneId: PANE, data: "\x1b[B\r" }]);
    });

    it("approves a plan with Enter", async () => {
      agent = { hostId: "local", transcriptPath: file("t.jsonl", plan("a1", "p1")) };
      expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({ ok: true });
      expect(writes).toEqual([{ paneId: PANE, data: "\r" }]);
    });

    it("refuses a stale answer and types nothing", async () => {
      const p = file("t.jsonl", ask("a1", "q1") + ask("a2", "q2"));
      agent = { hostId: "local", transcriptPath: p };
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
      agent = { hostId: "local", transcriptPath: file("t.jsonl", ask("a1", "q1", true)) };
      expect(
        await mirror.answer(PANE, "q1", { kind: "question", answers: [{ kind: "other", text: "green" }] }),
      ).toEqual({ ok: false, reason: "unsupported" });
      expect(await mirror.answer(PANE, "q1", { kind: "plan-approve" })).toEqual({
        ok: false,
        reason: "unsupported",
      });
      expect(writes).toEqual([]);
    });

    it("refuses a remote pane", async () => {
      agent = { hostId: "devbox", transcriptPath: file("t.jsonl", plan("a1", "p1")) };
      expect(await mirror.answer(PANE, "p1", { kind: "plan-approve" })).toEqual({ ok: false, reason: "remote" });
      expect(writes).toEqual([]);
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
      agent = { hostId: "local", transcriptPath: file("t.jsonl", plan("a1", "p1")) };
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
      agent = { hostId: "local", transcriptPath: p };
      await mirror.answer(PANE, "p1", { kind: "plan-approve" });
      fs.appendFileSync(p, toolResult("u1", "p1", "approved"));

      vi.advanceTimersByTime(8_000);
      // Enough turns for an expiry's read to have run, had it fired.
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(published.map((x) => x.entry)).toEqual([
        { kind: "plan", id: "p1", ts: T, plan: "Do it", outcome: "approved" },
      ]);
    });
  });
});

describe("pickPaneAgent", () => {
  const base = { paneId: "p", status: "completed", createdAt: "2026-01-01" };

  it("prefers the pane's active agent, else its newest", () => {
    const old = { ...base, createdAt: "2026-01-01" };
    const newer = { ...base, createdAt: "2026-02-01" };
    const active = { ...base, status: "active", createdAt: "2025-12-01" };
    expect(pickPaneAgent([old, newer], "p")).toBe(newer);
    expect(pickPaneAgent([old, active, newer], "p")).toBe(active);
    expect(pickPaneAgent([{ ...base, paneId: "q" }], "p")).toBeNull();
  });
});
