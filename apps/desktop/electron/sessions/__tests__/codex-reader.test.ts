import {
  appendFile,
  cp,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codexHome,
  codexStateDb,
  createCodexReader,
  parseSessionIndex,
} from "../codex-reader";
import type { SessionEnv, SessionSummary } from "../types";

const FIXTURES = join(__dirname, "../__fixtures__/codex");

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const E = "eeeeeeee-0000-4000-8000-00000000000e";
const Z = "ffffffff-0000-4000-8000-00000000000f";

const A_PATH =
  "sessions/2026/10/20/rollout-2026-10-20T09-15-00-aaaaaaaa-0000-4000-8000-00000000000a.jsonl";

type Sqlite = typeof import("node:sqlite");
const sqlite = process.getBuiltinModule?.("node:sqlite") as Sqlite | undefined;
const zstdCompressSync = (
  zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }
).zstdCompressSync;

let dir: string;
let home: string;
let env: SessionEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-reader-"));
  home = join(dir, "codex");
  await cp(FIXTURES, home, { recursive: true });
  env = { home: join(dir, "home"), env: { CODEX_HOME: home } };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function byId(list: SessionSummary[]): Record<string, SessionSummary> {
  return Object.fromEntries(list.map((s) => [s.sessionId, s]));
}

describe("codexHome", () => {
  it("uses CODEX_HOME when set, else ~/.codex; the index follows CODEX_SQLITE_HOME", () => {
    expect(codexHome({ home: "/h", env: { CODEX_HOME: "/c" } })).toBe("/c");
    expect(codexHome({ home: "/h", env: {} })).toBe("/h/.codex");
    expect(codexStateDb({ home: "/h", env: {} })).toBe(
      "/h/.codex/state_5.sqlite",
    );
    expect(codexStateDb({ home: "/h", env: { CODEX_SQLITE_HOME: "/s" } })).toBe(
      "/s/state_5.sqlite",
    );
  });
});

describe("parseSessionIndex", () => {
  it("keeps the newest name per thread and skips broken lines", () => {
    const names = parseSessionIndex(
      [
        '{"id":"x","thread_name":"one"}',
        "{broken",
        '{"id":"x","thread_name":"two"}',
        "",
      ].join("\n"),
    );
    expect(names.get("x")).toBe("two");
  });
});

describe("the Codex reader, from rollouts", () => {
  it("lists archived threads too, but not sub-agents' or ones no one spoke in", async () => {
    const list = await createCodexReader().list(env);
    expect(list.map((s) => s.sessionId).sort()).toEqual([A, B, E]);
    expect(list.every((s) => s.kind === "codex")).toBe(true);
  });

  it("reads who, where and when from session_meta, and the prompt the user typed", async () => {
    await utimes(
      join(home, A_PATH),
      new Date("2026-10-20T10:00:00Z"),
      new Date("2026-10-20T10:00:00Z"),
    );
    const a = byId(await createCodexReader().list(env))[A];
    expect(a).toMatchObject({
      id: `codex:${A}`,
      sessionId: A,
      // The newest name in session_index.jsonl.
      title: "Toast cleanup",
      // Not the AGENTS.md or environment_context Codex injects.
      firstPrompt: "Fix the flaky toast test",
      cwd: "/home/u/work/my-repo",
      gitBranch: "fix/toast",
      createdAt: "2026-10-20T09:15:00.100Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
      // The latest turn's model.
      model: "gpt-5.5-codex",
      messageCount: null,
      path: join(home, A_PATH),
      parentSessionId: null,
    });
  });

  it("titles an unnamed thread by its first prompt, and names its fork parent", async () => {
    const sessions = byId(await createCodexReader().list(env));
    expect(sessions[B].title).toBe("Write the scanner with tests");
    expect(sessions[B].firstPrompt).toBe("Write the scanner\n\nwith tests");
    expect(sessions[B].parentSessionId).toBe(A);
    expect(sessions[E].cwd).toBe("/home/u/old");
  });

  it("re-reads only what changed, and re-titles when the index does", async () => {
    const reader = createCodexReader();
    await reader.list(env);
    await appendFile(
      join(home, "session_index.jsonl"),
      `{"id":"${B}","thread_name":"Scanner"}\n`,
    );
    expect(byId(await reader.list(env))[B].title).toBe("Scanner");
    await unlink(join(home, A_PATH));
    expect(byId(await reader.list(env))[A]).toBeUndefined();
  });

  it("never writes to the store", async () => {
    const before = await readFile(join(home, A_PATH), "utf8");
    await createCodexReader().list(env);
    expect(await readFile(join(home, A_PATH), "utf8")).toBe(before);
  });

  it.skipIf(!zstdCompressSync)(
    "reads the head of a compressed rollout, preferring a plain sibling",
    async () => {
      const plain = await readFile(join(home, A_PATH));
      const zstPath = `sessions/2026/10/20/rollout-2026-10-20T08-00-00-${Z}.jsonl.zst`;
      await writeFile(
        join(home, zstPath),
        zstdCompressSync!(Buffer.from(plain.toString().split(A).join(Z))),
      );
      // A stale compressed copy of A beside its plain rollout is skipped.
      await writeFile(
        join(home, `${A_PATH}.zst`),
        zstdCompressSync!(Buffer.from("not read")),
      );
      const sessions = byId(await createCodexReader().list(env));
      expect(sessions[Z]).toMatchObject({
        firstPrompt: "Fix the flaky toast test",
        path: join(home, zstPath),
      });
      expect(sessions[A].path).toBe(join(home, A_PATH));
    },
  );
});

/** A `threads` table shaped like Codex's, with the columns given. */
function makeDb(
  path: string,
  columns: string,
  rows: Record<string, unknown>[],
): void {
  const db = new sqlite!.DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE threads (${columns})`);
  for (const row of rows) {
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO threads (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    ).run(...(Object.values(row) as (string | number | null)[]));
  }
  db.close();
}

const THREAD_COLUMNS = [
  "id TEXT PRIMARY KEY",
  "rollout_path TEXT",
  "created_at INTEGER",
  "updated_at INTEGER",
  "created_at_ms INTEGER",
  "updated_at_ms INTEGER",
  "source TEXT",
  "model TEXT",
  "cwd TEXT",
  "title TEXT",
  "name TEXT",
  "first_user_message TEXT",
  "has_user_event INTEGER",
  "archived INTEGER",
  "git_branch TEXT",
  "attached_thread_parent_id TEXT",
].join(", ");

describe.skipIf(!sqlite)("the Codex reader, from the SQLite index", () => {
  it("maps threads rows, keeps archived ones, and skips sub-agents and empty threads", async () => {
    makeDb(join(home, "state_5.sqlite"), THREAD_COLUMNS, [
      {
        id: "t1",
        rollout_path: "/r/t1.jsonl",
        created_at: 1792000000,
        updated_at: 1792000500,
        created_at_ms: 1792000000123,
        updated_at_ms: 1792000500456,
        source: "cli",
        model: "gpt-5.5-codex",
        cwd: "/home/u/work/my-repo",
        title: "Fix toast test",
        name: null,
        first_user_message: "Fix the flaky toast test",
        has_user_event: 1,
        archived: 0,
        git_branch: "fix/toast",
      },
      // Named in the row; archived.
      {
        id: "t2",
        created_at: 1792000000,
        updated_at: 1792000100,
        name: "Scanner",
        title: "x",
        has_user_event: 1,
        archived: 1,
        attached_thread_parent_id: "t1",
      },
      // A sub-agent's thread.
      {
        id: "t3",
        created_at: 1792000000,
        updated_at: 1792000100,
        source: '{"subagent":{"review":{}}}',
        first_user_message: "Review",
        has_user_event: 1,
      },
      // No one spoke.
      {
        id: "t4",
        created_at: 1792000000,
        updated_at: 1792000100,
        source: "cli",
        has_user_event: 0,
      },
      // Named only in session_index.jsonl; seconds-only times.
      {
        id: A,
        created_at: 1792000000,
        updated_at: 1792000200,
        first_user_message: "Fix the flaky toast test",
        has_user_event: 1,
      },
    ]);
    const list = await createCodexReader().list(env);
    // The index wins: no rollout-only threads (B, E) are listed.
    expect(list.map((s) => s.sessionId).sort()).toEqual([A, "t1", "t2"].sort());
    const sessions = byId(list);
    expect(sessions.t1).toEqual({
      id: "codex:t1",
      hostId: "local",
      kind: "codex",
      sessionId: "t1",
      title: "Fix toast test",
      firstPrompt: "Fix the flaky toast test",
      cwd: "/home/u/work/my-repo",
      gitBranch: "fix/toast",
      createdAt: new Date(1792000000123).toISOString(),
      updatedAt: new Date(1792000500456).toISOString(),
      messageCount: null,
      model: "gpt-5.5-codex",
      path: "/r/t1.jsonl",
      parentSessionId: null,
    });
    expect(sessions.t2).toMatchObject({
      title: "Scanner",
      parentSessionId: "t1",
      path: "",
    });
    expect(sessions[A]).toMatchObject({
      title: "Toast cleanup",
      createdAt: new Date(1792000000 * 1000).toISOString(),
      updatedAt: new Date(1792000200 * 1000).toISOString(),
    });
  });

  it("reads a minimal, older threads table", async () => {
    makeDb(
      join(home, "state_5.sqlite"),
      "id TEXT, created_at INTEGER, updated_at INTEGER, title TEXT",
      [
        {
          id: "old",
          created_at: 1792000000,
          updated_at: 1792000100,
          title: "Old thread",
        },
      ],
    );
    const [only] = await createCodexReader().list(env);
    expect(only).toMatchObject({
      id: "codex:old",
      sessionId: "old",
      title: "Old thread",
      cwd: "",
      model: null,
      gitBranch: null,
    });
  });

  it("falls back to the rollouts when the database has no threads table", async () => {
    makeDb(join(home, "state_5.sqlite"), "id TEXT", []);
    const db = new sqlite!.DatabaseSync(join(home, "state_5.sqlite"));
    db.exec("DROP TABLE threads");
    db.close();
    const list = await createCodexReader().list(env);
    expect(list.map((s) => s.sessionId).sort()).toEqual([A, B, E]);
  });

  it("falls back to the rollouts when the database is not one", async () => {
    await writeFile(join(home, "state_5.sqlite"), "not a database");
    const list = await createCodexReader().list(env);
    expect(list.map((s) => s.sessionId).sort()).toEqual([A, B, E]);
  });

  it("writes nothing beside the database, whether or not Codex has it open", async () => {
    const path = join(home, "state_5.sqlite");
    makeDb(path, THREAD_COLUMNS, [
      { id: "t1", created_at: 1792000000, updated_at: 1792000100, title: "One" },
    ]);
    // Closed: no -wal or -shm, and reading makes none.
    const closed = await readdir(home);
    expect(closed.filter((name) => name.startsWith("state_5.sqlite"))).toEqual(["state_5.sqlite"]);
    expect((await createCodexReader().list(env)).map((s) => s.sessionId)).toEqual(["t1"]);
    expect(await readdir(home)).toEqual(closed);

    // Open: Codex's own -wal and -shm, and nothing new.
    const codex = new sqlite!.DatabaseSync(path);
    codex.prepare("INSERT INTO threads (id, created_at, updated_at, title) VALUES (?, ?, ?, ?)").run("t2", 1792000000, 1792000200, "Two");
    const open = await readdir(home);
    expect(open).toContain("state_5.sqlite-wal");
    expect((await createCodexReader().list(env)).map((s) => s.sessionId).sort()).toEqual(["t1", "t2"]);
    expect(await readdir(home)).toEqual(open);
    codex.close();
  });

  it("sees new rows on a rescan, and never writes to the database", async () => {
    const path = join(home, "state_5.sqlite");
    makeDb(path, THREAD_COLUMNS, [
      {
        id: "t1",
        created_at: 1792000000,
        updated_at: 1792000100,
        title: "One",
      },
    ]);
    const reader = createCodexReader();
    expect((await reader.list(env)).map((s) => s.sessionId)).toEqual(["t1"]);
    const db = new sqlite!.DatabaseSync(path);
    db.prepare(
      "INSERT INTO threads (id, created_at, updated_at, title) VALUES (?, ?, ?, ?)",
    ).run("t2", 1792000000, 1792000200, "Two");
    db.close();
    const before = await readFile(path);
    expect((await reader.list(env)).map((s) => s.sessionId).sort()).toEqual([
      "t1",
      "t2",
    ]);
    expect((await readFile(path)).equals(before)).toBe(true);
  });
});
