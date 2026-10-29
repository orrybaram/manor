import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOpencodeReader, opencodeDbPath } from "../opencode-reader";
import type { SessionEnv, SessionSummary } from "../types";

const sqlite = process.getBuiltinModule(
  "node:sqlite",
) as typeof import("node:sqlite");

let dir: string;
let dbPath: string;
let env: SessionEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-reader-"));
  await mkdir(join(dir, "data", "opencode"), { recursive: true });
  dbPath = join(dir, "data", "opencode", "opencode.db");
  env = { home: join(dir, "home"), env: { XDG_DATA_HOME: join(dir, "data") } };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function byId(list: SessionSummary[]): Record<string, SessionSummary> {
  return Object.fromEntries(list.map((s) => [s.sessionId, s]));
}

function open(): DatabaseSync {
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/** The v1 tables as opencode 1.2 made them (a subset of their columns). */
function v1Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT,
      title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT);
  `);
}

function v1Session(
  db: DatabaseSync,
  s: {
    id: string;
    title: string;
    dir: string;
    parent?: string;
    archived?: number;
    at: number;
  },
): void {
  db.prepare(
    "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, 'p', ?, 's', ?, ?, '1.2.0', ?, ?, ?)",
  ).run(
    s.id,
    s.parent ?? null,
    s.dir,
    s.title,
    s.at,
    s.at + 60_000,
    s.archived ?? null,
  );
}

function v1Message(
  db: DatabaseSync,
  id: string,
  sessionId: string,
  at: number,
  data: object,
  parts: object[] = [],
): void {
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
    id,
    sessionId,
    at,
    at,
    JSON.stringify(data),
  );
  parts.forEach((part, i) => {
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(
      `${id}-p${i}`,
      id,
      sessionId,
      at,
      at,
      JSON.stringify(part),
    );
  });
}

/** The v2 tables as opencode's `dev` has them (a subset of their columns). */
function v2Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, fork_session_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT, version TEXT NOT NULL, agent TEXT, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
}

function v2Session(
  db: DatabaseSync,
  s: {
    id: string;
    title: string | null;
    dir: string;
    parent?: string;
    fork?: string;
    model?: object;
    at: number;
  },
): void {
  db.prepare(
    "INSERT INTO session_v2 (id, project_id, parent_id, fork_session_id, slug, directory, title, version, model, time_created, time_updated) VALUES (?, 'p', ?, ?, 's', ?, ?, '2.0.0', ?, ?, ?)",
  ).run(
    s.id,
    s.parent ?? null,
    s.fork ?? null,
    s.dir,
    s.title,
    s.model ? JSON.stringify(s.model) : null,
    s.at,
    s.at + 120_000,
  );
}

function v2Message(
  db: DatabaseSync,
  sessionId: string,
  seq: number,
  type: string,
  data: object,
): void {
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    `${sessionId}-m${seq}`,
    sessionId,
    type,
    seq,
    T0,
    T0,
    JSON.stringify(data),
  );
}

describe("opencodeDbPath", () => {
  it("uses OPENCODE_DB, relative to the data dir, else opencode.db under XDG_DATA_HOME or ~/.local/share", () => {
    expect(opencodeDbPath({ home: "/h", env: {} })).toBe(
      "/h/.local/share/opencode/opencode.db",
    );
    expect(opencodeDbPath({ home: "/h", env: { XDG_DATA_HOME: "/x" } })).toBe(
      "/x/opencode/opencode.db",
    );
    expect(
      opencodeDbPath({ home: "/h", env: { OPENCODE_DB: "/db/o.db" } }),
    ).toBe("/db/o.db");
    expect(
      opencodeDbPath({ home: "/h", env: { OPENCODE_DB: "other.db" } }),
    ).toBe("/h/.local/share/opencode/other.db");
    expect(
      opencodeDbPath({ home: "/h", env: { OPENCODE_DB: ":memory:" } }),
    ).toBeNull();
  });
});

describe("the opencode reader", () => {
  it("lists nothing when there is no database", async () => {
    expect(await createOpencodeReader().list(env)).toEqual([]);
  });

  it("reads v1 sessions, their first typed prompt, latest model and message count", async () => {
    const db = open();
    v1Schema(db);
    v1Session(db, {
      id: "ses_a",
      title: "Fix the toast",
      dir: "/repo/a",
      at: T0,
    });
    v1Session(db, {
      id: "ses_b",
      title: `New session - ${new Date(T0).toISOString()}`,
      dir: "/repo/b",
      at: T0 + 1,
    });
    v1Session(db, {
      id: "ses_child",
      title: "Subtask",
      dir: "/repo/a",
      parent: "ses_a",
      at: T0,
    });
    v1Session(db, {
      id: "ses_old",
      title: "Archived",
      dir: "/repo/a",
      archived: T0,
      at: T0,
    });
    v1Message(db, "m1", "ses_a", T0, { role: "user" }, [
      { type: "text", text: "context from a file", synthetic: true },
      { type: "text", text: "Why is the toast flaky?" },
    ]);
    v1Message(db, "m2", "ses_a", T0 + 1, {
      role: "assistant",
      modelID: "claude-sonnet-4",
      providerID: "anthropic",
    });
    v1Message(db, "m3", "ses_a", T0 + 2, {
      role: "assistant",
      modelID: "gpt-5",
      providerID: "openai",
    });
    v1Message(db, "m4", "ses_b", T0, { role: "user" }, [
      { type: "text", text: "  Write\n the scanner  " },
    ]);
    db.close();

    const list = await createOpencodeReader().list(env);
    expect(list.map((s) => s.sessionId).sort()).toEqual(["ses_a", "ses_b"]);
    const sessions = byId(list);
    expect(sessions.ses_a).toEqual({
      hostId: "local",
      kind: "opencode",
      sessionId: "ses_a",
      title: "Fix the toast",
      firstPrompt: "Why is the toast flaky?",
      cwd: "/repo/a",
      gitBranch: null,
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0 + 60_000).toISOString(),
      messageCount: 3,
      model: "gpt-5",
      path: dbPath,
      parentSessionId: null,
    });
    // opencode's placeholder title gives way to the first prompt.
    expect(sessions.ses_b.title).toBe("Write the scanner");
    expect(sessions.ses_b.firstPrompt).toBe("Write\n the scanner");
  });

  it("reads v2 sessions, and v1 ones not yet copied into session_v2", async () => {
    const db = open();
    v1Schema(db);
    v2Schema(db);
    v1Session(db, { id: "ses_both", title: "Old copy", dir: "/old", at: T0 });
    v1Session(db, { id: "ses_v1", title: "Only in v1", dir: "/v1", at: T0 });
    v2Session(db, {
      id: "ses_both",
      title: "Migrated",
      dir: "/new",
      model: { id: "gpt-5", providerID: "openai" },
      at: T0,
    });
    v2Session(db, {
      id: "ses_fork",
      title: null,
      dir: "/new",
      fork: "ses_both",
      at: T0 + 5,
    });
    v2Session(db, {
      id: "ses_kid",
      title: "Child",
      dir: "/new",
      parent: "ses_both",
      at: T0,
    });
    v2Message(db, "ses_both", 0, "synthetic", { text: "not typed" });
    v2Message(db, "ses_both", 1, "user", { text: "Port the reader" });
    v2Message(db, "ses_both", 2, "assistant", {
      model: { id: "gpt-5", providerID: "openai" },
      content: [],
    });
    v2Message(db, "ses_fork", 0, "user", { text: "Try it another way" });
    v2Message(db, "ses_fork", 1, "assistant", {
      model: { id: "claude-opus-4", providerID: "anthropic" },
    });
    db.close();

    const sessions = byId(await createOpencodeReader().list(env));
    expect(Object.keys(sessions).sort()).toEqual([
      "ses_both",
      "ses_fork",
      "ses_v1",
    ]);
    expect(sessions.ses_both).toMatchObject({
      title: "Migrated",
      cwd: "/new",
      firstPrompt: "Port the reader",
      model: "gpt-5",
      messageCount: 2,
      updatedAt: new Date(T0 + 120_000).toISOString(),
    });
    expect(sessions.ses_fork).toMatchObject({
      title: "Try it another way",
      model: "claude-opus-4",
      parentSessionId: "ses_both",
    });
    expect(sessions.ses_v1.title).toBe("Only in v1");
  });

  it("sees what opencode committed while it still holds the database open", async () => {
    const db = open();
    v2Schema(db);
    v2Session(db, { id: "ses_1", title: "One", dir: "/r", at: T0 });
    const reader = createOpencodeReader();
    expect((await reader.list(env)).map((s) => s.sessionId)).toEqual(["ses_1"]);
    // An open write transaction does not block the read; its rows are not seen yet.
    db.exec("BEGIN");
    v2Session(db, { id: "ses_2", title: "Two", dir: "/r", at: T0 });
    expect((await reader.list(env)).map((s) => s.sessionId)).toEqual(["ses_1"]);
    db.exec("COMMIT");
    expect((await reader.list(env)).map((s) => s.sessionId).sort()).toEqual([
      "ses_1",
      "ses_2",
    ]);
    db.close();
  });

  it("reads a copy when opencode holds an exclusive lock", async () => {
    const db = open();
    v2Schema(db);
    v2Session(db, { id: "ses_1", title: "One", dir: "/r", at: T0 });
    db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    const list = await createOpencodeReader().list(env);
    db.exec("COMMIT");
    db.close();
    expect(list.map((s) => s.sessionId)).toEqual(["ses_1"]);
    expect(list[0].path).toBe(dbPath);
  });

  it("reuses its result while the database and its WAL are unchanged, and never changes the database", async () => {
    const db = open();
    v2Schema(db);
    v2Session(db, { id: "ses_1", title: "One", dir: "/r", at: T0 });
    db.close();
    const before = await stat(dbPath);
    const reader = createOpencodeReader();
    await reader.list(env);
    const first = await reader.list(env);
    expect(await reader.list(env)).toBe(first);
    const after = await stat(dbPath);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
  });

  it("lists nothing, rather than failing, on a Node without node:sqlite", async () => {
    const db = open();
    v2Schema(db);
    db.close();
    expect(await createOpencodeReader(null).list(env)).toEqual([]);
  });
});
