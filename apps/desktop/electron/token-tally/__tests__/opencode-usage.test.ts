/**
 * The opencode reader against small databases built here, in both of
 * opencode's schemas, as `chat-mirror/__tests__/opencode-db-source.test.ts`
 * builds them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { opencodeLocator } from "../../sessions/opencode-locator";
import { createOpencodeUsageReader } from "../opencode-usage";

const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const tokens = (input: number, output: number, reasoning: number, write: number, read = 50_000) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
});

describe("opencode usage reader", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;
  const reader = createOpencodeUsageReader({ sqlite });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-opencode-usage-"));
    dbPath = path.join(dir, "opencode.db");
    db = new sqlite.DatabaseSync(dbPath);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function v1(): void {
    db.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
        time_updated INTEGER, data TEXT);
    `);
  }
  const message = (id: string, session: string, t: number) =>
    db.prepare("INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?, ?)").run(id, session, t, t, JSON.stringify({ role: "assistant" }));
  const part = (id: string, session: string, created: number, updated: number, data: object) =>
    db
      .prepare("INSERT OR REPLACE INTO part VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, "msg_1", session, created, updated, JSON.stringify(data));
  const stepFinish = (id: string, session: string, t: number, tk: object) =>
    part(id, session, t, t, { type: "step-finish", tokens: tk });

  it("counts step-finish parts once each, leaving out cache reads and other parts", async () => {
    v1();
    message("msg_1", "ses_a", 100);
    part("prt_text", "ses_a", 100, 100, { type: "text", text: "hi", tokens: tokens(999, 999, 0, 0) });
    stepFinish("prt_1", "ses_a", 110, tokens(10, 20, 5, 100));
    stepFinish("prt_x", "ses_b", 110, tokens(7, 7, 7, 7));
    const locator = opencodeLocator(dbPath, "ses_a");

    const first = await reader.read({ offset: 0 }, locator);
    expect(first.fresh).toBe(135);
    expect(first.next.offset).toBe(110);
    expect(JSON.stringify(first.next)).not.toContain("prt_1");

    // Read again with nothing new, then a part in the cursor's own millisecond and a later one.
    expect((await reader.read(first.next, locator)).fresh).toBe(0);
    stepFinish("prt_2", "ses_a", 110, tokens(1, 1, 0, 0));
    stepFinish("prt_3", "ses_a", 200, tokens(2, 2, 0, 0));
    const second = await reader.read(first.next, locator);
    expect(second.fresh).toBe(6);
    expect(second.next.offset).toBe(200);
  });

  it("starts a marker at the end, and leaves out rows created before the floor", async () => {
    v1();
    message("msg_1", "ses_a", 100);
    stepFinish("prt_1", "ses_a", 100, tokens(10, 10, 0, 0));
    const locator = opencodeLocator(dbPath, "ses_a");
    expect(await reader.createdAt(locator)).toBe(100);

    const end = await reader.markerAtEnd(locator);
    expect((await reader.read(end, locator)).fresh).toBe(0);
    stepFinish("prt_2", "ses_a", 300, tokens(1, 0, 0, 0));
    expect((await reader.read(end, locator)).fresh).toBe(1);

    const floored = await reader.read({ offset: 0, floor: 200 }, locator);
    expect(floored.fresh).toBe(1);
  });

  it("counts v2 assistant rows, topping up one updated in place", async () => {
    db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
    const row = (id: string, type: string, seq: number, created: number, updated: number, data: object) =>
      db
        .prepare("INSERT OR REPLACE INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, "ses_a", type, seq, created, updated, JSON.stringify(data));
    row("m1", "user", 1, 100, 100, { text: "hi" });
    row("m2", "assistant", 2, 110, 110, { tokens: tokens(5, 1, 0, 0) });
    const locator = opencodeLocator(dbPath, "ses_a");

    const first = await reader.read({ offset: 0 }, locator);
    expect(first.fresh).toBe(6);
    row("m2", "assistant", 2, 110, 150, { tokens: tokens(5, 40, 10, 0) });
    expect((await reader.read(first.next, locator)).fresh).toBe(49);
  });

  it("reads nothing without node:sqlite or the database", async () => {
    const none = createOpencodeUsageReader({ sqlite: null });
    const locator = opencodeLocator(dbPath, "ses_a");
    expect(await none.read({ offset: 0 }, locator)).toEqual({ fresh: 0, next: { offset: 0 } });
    const gone = opencodeLocator(path.join(dir, "missing.db"), "ses_a");
    expect((await reader.read({ offset: 5 }, gone)).next.offset).toBe(5);
  });
});
