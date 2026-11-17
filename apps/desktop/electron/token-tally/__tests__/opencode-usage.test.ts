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
import { TokenTally } from "../token-tally";
import type { UsageMarker, UsageRead } from "../usage-reader";

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
  /** A read that must succeed. */
  const read = async (marker: UsageMarker, locator: string): Promise<UsageRead> => {
    const result = await reader.read(marker, locator);
    if (!result) throw new Error("unreadable");
    return result;
  };

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

    const first = await read({ offset: 0 }, locator);
    expect(first.fresh).toBe(135);
    expect(first.next.offset).toBe(110);
    expect(JSON.stringify(first.next)).not.toContain("prt_1");

    // Read again with nothing new, then a part in the cursor's own millisecond and a later one.
    expect((await read(first.next, locator)).fresh).toBe(0);
    stepFinish("prt_2", "ses_a", 110, tokens(1, 1, 0, 0));
    stepFinish("prt_3", "ses_a", 200, tokens(2, 2, 0, 0));
    const second = await read(first.next, locator);
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
    if (!end) throw new Error("unreadable");
    expect((await read(end, locator)).fresh).toBe(0);
    stepFinish("prt_2", "ses_a", 300, tokens(1, 0, 0, 0));
    expect((await read(end, locator)).fresh).toBe(1);

    const floored = await read({ offset: 0, floor: 200 }, locator);
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

    const first = await read({ offset: 0 }, locator);
    expect(first.fresh).toBe(6);
    row("m2", "assistant", 2, 110, 150, { tokens: tokens(5, 40, 10, 0) });
    expect((await read(first.next, locator)).fresh).toBe(49);
  });

  it("says an unreadable source is unreadable, so no marker is kept", async () => {
    const none = createOpencodeUsageReader({ sqlite: null });
    const locator = opencodeLocator(dbPath, "ses_a");
    expect(await none.read({ offset: 0 }, locator)).toBeNull();
    expect(await none.markerAtEnd(locator)).toBeNull();
    const gone = opencodeLocator(path.join(dir, "missing.db"), "ses_a");
    expect(await reader.read({ offset: 5 }, gone)).toBeNull();
    expect(await reader.markerAtEnd(gone)).toBeNull();
    expect(await reader.createdAt(gone)).toBeNull();
  });

  it("first sees a session again once its database can be read, rather than backfilling it", async () => {
    v1();
    message("msg_1", "ses_a", 100);
    stepFinish("prt_1", "ses_a", 100, tokens(10, 10, 0, 0));
    const locator = opencodeLocator(dbPath, "ses_a");
    const counted: number[] = [];
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-opencode-tally-"));
    try {
      const without = new TokenTally({
        dataDir,
        record: (n) => counted.push(n),
        readers: { opencode: createOpencodeUsageReader({ sqlite: null }) },
      });
      await without.tally({ agentKind: "opencode", transcriptPath: locator });
      without.dispose();
      const markers = JSON.parse(fs.readFileSync(path.join(dataDir, "token-tally.json"), "utf8")).markers;
      expect(Object.keys(markers)).toHaveLength(0);

      // Node gains node:sqlite: the session predates the tally, so it starts at its end.
      const withSqlite = new TokenTally({ dataDir, record: (n) => counted.push(n), readers: { opencode: reader } });
      await withSqlite.tally({ agentKind: "opencode", transcriptPath: locator });
      withSqlite.dispose();
      expect(counted).toEqual([]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("dates a session by its session row, so a fork's copied messages don't count and its own do", async () => {
    v1();
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_created INTEGER, time_updated INTEGER)");
    // A fork created at 5000, its copied messages and steps dated as the original's.
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_fork", "fork", 5000, 5000);
    message("msg_1", "ses_fork", 100);
    stepFinish("prt_old", "ses_fork", 100, tokens(1000, 1000, 0, 0));
    stepFinish("prt_new", "ses_fork", 6000, tokens(3, 4, 0, 0));
    const locator = opencodeLocator(dbPath, "ses_fork");
    expect(await reader.createdAt(locator)).toBe(5000);

    // And a session with its row but no messages yet still has a creation time.
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_empty", "new", 7000, 7000);
    expect(await reader.createdAt(opencodeLocator(dbPath, "ses_empty"))).toBe(7000);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "manor-opencode-tally-"));
    try {
      fs.writeFileSync(path.join(dataDir, "token-tally.json"), JSON.stringify({ version: 1, since: 1000, markers: {} }));
      const counted: number[] = [];
      const tally = new TokenTally({
        dataDir,
        record: (n) => counted.push(n),
        readers: { opencode: reader },
        now: () => 10_000,
      });
      await tally.tally({ agentKind: "opencode", transcriptPath: locator });
      tally.dispose();
      expect(counted).toEqual([7]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
