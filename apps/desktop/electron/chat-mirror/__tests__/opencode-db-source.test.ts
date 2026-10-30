/**
 * `OpencodeDbSource` against small databases built here, in both of
 * opencode's schemas (no real session data: the repo is public), alone and
 * through a `TranscriptStream` with the opencode adapter.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { opencodeAdapter } from "../adapters/opencode";
import { OpencodeDbSource } from "../opencode-db-source";
import { TranscriptStream } from "../stream";
import type { ChatPush } from "../transcript";
import { opencodeLocator } from "../../sessions/opencode-locator";

const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

function v1Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT);
  `);
}

function v2Schema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
}

describe("OpencodeDbSource", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let source: OpencodeDbSource;

  const message = (id: string, session: string, t: number, data: object) =>
    db.prepare("INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?, ?)").run(id, session, t, t, JSON.stringify(data));
  const part = (id: string, msg: string, session: string, created: number, updated: number, data: object) =>
    db
      .prepare("INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, msg, session, created, updated, JSON.stringify(data));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-opencode-source-"));
    dbPath = path.join(dir, "opencode.db");
    db = new sqlite.DatabaseSync(dbPath);
    source = new OpencodeDbSource({ sqlite });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function lines(data: string): Array<Record<string, unknown>> {
    return data
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("reads a v1 session's messages and parts, then only what changed since", async () => {
    v1Schema(db);
    message("msg_1", "ses_a", 100, { role: "user", time: { created: 100 } });
    part("prt_1", "msg_1", "ses_a", 100, 100, { type: "text", text: "Fix it" });
    message("msg_2", "ses_a", 200, { role: "assistant", time: { created: 200 } });
    part("prt_2", "msg_2", "ses_a", 200, 210, {
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "ls" }, output: "x".repeat(10_000), metadata: { output: "big" } },
    });
    message("msg_other", "ses_b", 300, { role: "user" });
    const locator = opencodeLocator(dbPath, "ses_a");

    const first = await source.read(locator, 0);
    if (!first.ok) throw new Error(first.error);
    expect(first.next).toBe(210);
    expect(first.size).toBe(210);
    const rows = lines(first.data);
    expect(rows.map((r) => [r.t, r.id])).toEqual([
      ["message", "msg_1"],
      ["message", "msg_2"],
      ["part", "prt_1"],
      ["part", "prt_2"],
    ]);
    // A tool's output is cut to its head in SQL, and its metadata copy dropped.
    const state = (rows[3].data as { state: Record<string, unknown> }).state;
    expect((state.output as string).length).toBe(4000);
    expect(state.metadata).toEqual({});

    // Nothing changed: nothing read.
    expect(await source.read(locator, 210)).toEqual({ ok: true, size: 210, next: 210, data: "" });

    // A part updated in place: it, and the boundary millisecond again.
    part("prt_3", "msg_2", "ses_a", 220, 230, { type: "text", text: "Done." });
    const second = await source.read(locator, 210);
    if (!second.ok) throw new Error(second.error);
    expect(lines(second.data).map((r) => r.id)).toEqual(["prt_2", "prt_3"]);
    expect(second.next).toBe(230);
  });

  it("reads a v2 session from session_message, preferring it to v1 rows", async () => {
    v1Schema(db);
    v2Schema(db);
    message("msg_1", "ses_a", 100, { role: "user" });
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "msg_v2",
      "ses_a",
      "user",
      1,
      100,
      150,
      JSON.stringify({ text: "hi" }),
    );
    const read = await source.read(opencodeLocator(dbPath, "ses_a"), 0);
    if (!read.ok) throw new Error(read.error);
    expect(lines(read.data)).toEqual([
      { t: "session_message", id: "msg_v2", type: "user", seq: 1, time_created: 100, time_updated: 150, data: { text: "hi" } },
    ]);
    expect(read.next).toBe(150);
  });

  it("reads a session whose rows went backwards as replaced", async () => {
    v1Schema(db);
    message("msg_1", "ses_a", 100, { role: "user" });
    message("msg_2", "ses_a", 200, { role: "user" });
    const locator = opencodeLocator(dbPath, "ses_a");
    await source.read(locator, 0);
    db.prepare("DELETE FROM message WHERE id = 'msg_2'").run();
    expect(await source.read(locator, 200)).toEqual({ ok: true, size: 0, data: "", replaced: true });
    const again = await source.read(locator, 0);
    expect(again.ok && lines(again.data).map((r) => r.id)).toEqual(["msg_1"]);
  });

  it("sees rows deleted while more were added, though the count grew", async () => {
    v1Schema(db);
    message("msg_1", "ses_a", 100, { role: "user" });
    part("prt_1", "msg_1", "ses_a", 100, 100, { type: "text", text: "one" });
    message("msg_2", "ses_a", 200, { role: "user" });
    part("prt_2", "msg_2", "ses_a", 200, 200, { type: "text", text: "undone" });
    const locator = opencodeLocator(dbPath, "ses_a");
    await source.read(locator, 0);
    // /undo, then a prompt: the reverted rows go, the new turn's come.
    db.prepare("DELETE FROM part WHERE id = 'prt_2'").run();
    db.prepare("DELETE FROM message WHERE id = 'msg_2'").run();
    message("msg_3", "ses_a", 300, { role: "user" });
    part("prt_3", "msg_3", "ses_a", 300, 300, { type: "text", text: "redo" });
    message("msg_4", "ses_a", 310, { role: "assistant" });
    part("prt_4", "msg_4", "ses_a", 310, 310, { type: "text", text: "ok" });
    expect(await source.read(locator, 200)).toEqual({ ok: true, size: 0, data: "", replaced: true });
    const again = await source.read(locator, 0);
    expect(again.ok && lines(again.data).map((r) => r.id)).toEqual(["msg_1", "msg_3", "msg_4", "prt_1", "prt_3", "prt_4"]);
    // And reads on from there as usual.
    part("prt_5", "msg_4", "ses_a", 320, 320, { type: "text", text: "more" });
    const next = await source.read(locator, 310);
    expect(next.ok && lines(next.data).map((r) => r.id)).toEqual(["msg_4", "prt_4", "prt_5"]);
  });

  it("reads nothing yet for a missing database or session, and refuses a non-locator", async () => {
    expect(await source.read(opencodeLocator(path.join(dir, "none.db"), "ses_a"), 0)).toEqual({ ok: true, size: 0, data: "" });
    v1Schema(db);
    expect(await source.read(opencodeLocator(dbPath, "ses_none"), 0)).toEqual({ ok: true, size: 0, data: "" });
    expect((await source.read(dbPath, 0)).ok).toBe(false);
  });

  it("says once that a Node without node:sqlite can't read it", async () => {
    const none = new OpencodeDbSource({ sqlite: null });
    const locator = opencodeLocator(dbPath, "ses_a");
    const first = await none.read(locator, 0);
    expect(first.ok && lines(first.data)).toEqual([{ t: "unsupported", node: process.versions.node }]);
    expect(await none.read(locator, 1)).toEqual({ ok: true, size: 1, next: 1, data: "" });
  });

  describe("through a stream", () => {
    let pushes: Array<{ entry: ChatPush; publish: boolean }>;
    let stream: TranscriptStream;

    beforeEach(() => {
      pushes = [];
      stream = new TranscriptStream({
        label: "test",
        adapter: opencodeAdapter,
        pollIntervalMs: 60_000,
        unwatchedPollIntervalMs: 60_000,
        onPush: (entry, publish) => pushes.push({ entry, publish }),
      });
    });

    afterEach(() => stream.release());

    it("keeps the cursor, publishing only rows updated after the first read", async () => {
      v1Schema(db);
      message("msg_1", "ses_a", 100, { role: "user", time: { created: 100 } });
      part("prt_1", "msg_1", "ses_a", 100, 100, { type: "text", text: "Fix it" });
      message("msg_2", "ses_a", 200, { role: "assistant", time: { created: 200 } });
      part("prt_2", "msg_2", "ses_a", 200, 200, {
        type: "tool",
        tool: "read",
        state: { status: "running", input: { filePath: "/r/a.ts" } },
      });
      stream.point({ path: opencodeLocator(dbPath, "ses_a"), adapter: opencodeAdapter, source }, false);
      await stream.read();
      expect(pushes.every((p) => !p.publish)).toBe(true);
      expect(stream.parser.entries().map((e) => [e.kind, e.id])).toEqual([
        ["user", "prt_1"],
        ["tool", "prt_2"],
      ]);
      expect(stream.parser.turnState()).toBe("working");

      pushes = [];
      await stream.read();
      expect(pushes).toEqual([]);

      part("prt_2", "msg_2", "ses_a", 200, 300, {
        type: "tool",
        tool: "read",
        state: { status: "completed", input: { filePath: "/r/a.ts" }, output: "contents" },
      });
      message("msg_2", "ses_a", 300, { role: "assistant", time: { created: 200, completed: 300 }, finish: "stop" });
      await stream.read();
      expect(pushes.map((p) => [p.entry.kind, p.publish])).toEqual([
        ["tool", true],
        ["turn", true],
      ]);
      expect(pushes[0].entry).toMatchObject({ id: "prt_2", status: "ok", detail: "contents" });
      expect(stream.parser.turnState()).toBe("done");
    });

    it("tells subscribers when rows were deleted, and reads the session as it is now", async () => {
      v1Schema(db);
      message("msg_1", "ses_a", 100, { role: "user" });
      part("prt_1", "msg_1", "ses_a", 100, 100, { type: "text", text: "Fix it" });
      message("msg_2", "ses_a", 200, { role: "assistant", time: { created: 200, completed: 210 }, finish: "stop" });
      part("prt_2", "msg_2", "ses_a", 200, 210, { type: "text", text: "Reverted reply" });
      stream.point({ path: opencodeLocator(dbPath, "ses_a"), adapter: opencodeAdapter, source }, false);
      await stream.read();
      expect(stream.parser.turnState()).toBe("done");

      // /undo, then a new prompt.
      db.prepare("DELETE FROM part WHERE message_id = 'msg_2'").run();
      db.prepare("DELETE FROM message WHERE id = 'msg_2'").run();
      message("msg_3", "ses_a", 300, { role: "user" });
      part("prt_3", "msg_3", "ses_a", 300, 300, { type: "text", text: "Try again" });
      pushes = [];
      await stream.read();
      // The re-read is history; the reset says to fetch it.
      expect(pushes.filter((p) => p.publish).map((p) => p.entry.kind)).toEqual(["reset"]);
      expect(stream.parser.entries().map((e) => e.id)).toEqual(["prt_1", "prt_3"]);
      expect(stream.parser.turnState()).toBe("working");

      // Later rows publish as usual.
      pushes = [];
      message("msg_4", "ses_a", 400, { role: "assistant", time: { created: 400 } });
      part("prt_4", "msg_4", "ses_a", 400, 400, { type: "text", text: "On it" });
      await stream.read();
      expect(pushes.filter((p) => p.publish).map((p) => p.entry.id)).toEqual(["prt_4"]);
    });
  });
});
