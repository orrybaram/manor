import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSessionRef, PREVIEW_TURNS, readSessionPreview, zstdLimits, type SessionRef } from "../preview";
import { createSqliteCopyCache, readSqliteStore } from "../sqlite-store";
import type { SessionEnv } from "../types";

const FIXTURES = join(__dirname, "../__fixtures__");
const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const zstdCompressSync = (zlib as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;

const CLAUDE_A = "claude/projects/-home-u-work-my-repo/aaaaaaaa-0000-4000-8000-000000000001.jsonl";
const CODEX_A = "codex/sessions/2026/10/20/rollout-2026-10-20T09-15-00-aaaaaaaa-0000-4000-8000-00000000000a.jsonl";
const PI_A = "pi/agent/sessions/--home-u-work-my-repo--/2026-10-20T10-00-00-000Z_aaaaaaaa-0000-4000-8000-0000000000a1.jsonl";

let dir: string;
let env: SessionEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-preview-"));
  await cp(FIXTURES, join(dir, "stores"), { recursive: true });
  await mkdir(join(dir, "data", "opencode"), { recursive: true });
  env = {
    home: join(dir, "home"),
    env: {
      CLAUDE_CONFIG_DIR: join(dir, "stores", "claude"),
      CODEX_HOME: join(dir, "stores", "codex"),
      PI_CODING_AGENT_DIR: join(dir, "stores", "pi", "agent"),
      XDG_DATA_HOME: join(dir, "data"),
    },
  };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ref(kind: SessionRef["kind"], path: string, sessionId = "s"): SessionRef {
  return { hostId: "local", kind, sessionId, path };
}

const store = (rel: string): string => join(dir, "stores", rel);

describe("a Claude preview", () => {
  it("reads turns through the chat mirror's parser: prompts, answers and one line per tool, no tool output", async () => {
    const preview = await readSessionPreview(ref("claude", store(CLAUDE_A)), env);
    expect(preview).toEqual({
      truncated: false,
      turns: [
        { role: "user", text: "Fix the flaky toast test" },
        { role: "assistant", text: "On it." },
        { role: "user", text: "and the deck too" },
        { role: "tool", name: "Bash", summary: "Run the deck tests" },
        { role: "assistant", text: "Done." },
      ],
    });
  });

  it("ends with the last turns, opened by the first prompt, when the transcript is long", async () => {
    const path = store("claude/projects/-home-u-work-my-repo/ffffffff-0000-4000-8000-00000000000f.jsonl");
    const record = (i: number, type: "user" | "assistant", text: string) =>
      JSON.stringify({
        type,
        uuid: `u${i}`,
        timestamp: "2026-10-20T10:00:00.000Z",
        message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
      });
    const lines = [record(0, "user", "The very first ask")];
    // Far longer than the window, which reads back only from the end.
    for (let i = 1; i <= 2000; i++) lines.push(record(i, i % 2 ? "assistant" : "user", `turn ${i} ${"x".repeat(5000)}`));
    await writeFile(path, `${lines.join("\n")}\n`);
    const preview = await readSessionPreview(ref("claude", path), env);
    expect(preview.truncated).toBe(true);
    expect(preview.turns).toHaveLength(PREVIEW_TURNS + 1);
    expect(preview.turns[0]).toEqual({ role: "user", text: "The very first ask", first: true });
    const last = preview.turns[preview.turns.length - 1];
    expect(last.role === "user" && last.text.startsWith("turn 2000 ")).toBe(true);
    // Each text is capped.
    expect(last.role === "user" && last.text.length).toBe(4097);
  });
});

describe("the opening prompt", () => {
  it("is added by position: a later prompt with the same words does not stand in for it", async () => {
    const path = store("pi/agent/sessions/--home-u-work-my-repo--/2026-10-24T00-00-00-000Z_99999999-0000-4000-8000-000000000099.jsonl");
    const msg = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: text } });
    const lines = [JSON.stringify({ type: "session", version: 3, id: "x", cwd: "/w" }), msg("user", "go")];
    for (let i = 0; i < PREVIEW_TURNS; i++) lines.push(msg("assistant", `step ${i}`));
    lines.push(msg("user", "go"), msg("assistant", "done"));
    await writeFile(path, `${lines.join("\n")}\n`);
    const preview = await readSessionPreview(ref("pi", path), env);
    expect(preview.truncated).toBe(true);
    expect(preview.turns[0]).toEqual({ role: "user", text: "go", first: true });
    expect(preview.turns.slice(-2)).toEqual([
      { role: "user", text: "go" },
      { role: "assistant", text: "done" },
    ]);
  });

  it("is found past a first message longer than the first head window", async () => {
    const path = store("pi/agent/sessions/--home-u-work-my-repo--/2026-10-24T00-00-00-000Z_88888888-0000-4000-8000-000000000088.jsonl");
    const first = JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "image", data: "A".repeat(400_000) }, { type: "text", text: "What is this?" }] },
    });
    const rest = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ type: "message", message: { role: "assistant", content: `answer ${i} ${"q".repeat(8000)}` } }),
    );
    await writeFile(path, `${[JSON.stringify({ type: "session", id: "y" }), first, ...rest].join("\n")}\n`);
    const preview = await readSessionPreview(ref("pi", path), env);
    expect(preview.turns[0]).toEqual({ role: "user", text: "What is this?", first: true });
  });
});

describe("a Codex preview", () => {
  it("reads response items, skipping injected context and tool output", async () => {
    const preview = await readSessionPreview(ref("codex", store(CODEX_A)), env);
    expect(preview).toEqual({
      truncated: false,
      turns: [
        { role: "user", text: "Fix the flaky toast test" },
        { role: "assistant", text: "Looking at it." },
        { role: "tool", name: "shell", summary: "pnpm test toast" },
        { role: "tool", name: "apply_patch", summary: "src/toast.ts" },
        { role: "assistant", text: "Fixed: the **timer** leaked." },
      ],
    });
  });

  it("names the files an apply_patch function call touches", async () => {
    const path = store(CODEX_A);
    const call = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "apply_patch",
        arguments: JSON.stringify({ input: "*** Begin Patch\n*** Add File: docs/a.md\n+x\n*** End Patch" }),
      },
    };
    await writeFile(path, `${await readFile(path, "utf8")}${JSON.stringify(call)}\n`);
    const preview = await readSessionPreview(ref("codex", path), env);
    expect(preview.turns[preview.turns.length - 1]).toEqual({ role: "tool", name: "apply_patch", summary: "docs/a.md" });
  });

  it.skipIf(!zstdCompressSync)("says when a compressed rollout was too large to read to its end", async () => {
    const message = (role: string, text: string) =>
      JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "output_text", text }] } });
    const lines = [message("user", "Start here")];
    for (let i = 0; i < 400; i++) lines.push(message("assistant", `step ${i} ${"z".repeat(1000)}`));
    const zst = store(CODEX_A.replace("09-15-00", "07-00-00").concat(".zst"));
    await writeFile(zst, zstdCompressSync!(Buffer.from(`${lines.join("\n")}\n`)));
    const before = zstdLimits.maxBytes;
    zstdLimits.maxBytes = 100_000;
    try {
      const preview = await readSessionPreview(ref("codex", zst), env);
      expect(preview.partial).toBe(true);
      expect(preview.truncated).toBe(true);
      expect(preview.turns[0]).toEqual({ role: "user", text: "Start here", first: true });
    } finally {
      zstdLimits.maxBytes = before;
    }
    // Read whole, it is not partial: the cache keyed on size and mtime does not keep the capped read.
    await writeFile(zst, zstdCompressSync!(Buffer.from(`${lines.slice(0, 5).join("\n")}\n`)));
    const whole = await readSessionPreview(ref("codex", zst), env);
    expect(whole.partial).toBeUndefined();
    expect(whole.turns).toHaveLength(5);
  });

  it.skipIf(!zstdCompressSync)("reads a compressed rollout", async () => {
    const zst = store(CODEX_A.replace("09-15-00", "08-00-00").concat(".zst"));
    await writeFile(zst, zstdCompressSync!(await readFile(store(CODEX_A))));
    const preview = await readSessionPreview(ref("codex", zst), env);
    expect(preview.turns.map((t) => t.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
  });
});

describe("a pi preview", () => {
  it("reads message entries, dropping images and tool results", async () => {
    const preview = await readSessionPreview(ref("pi", store(PI_A)), env);
    expect(preview.truncated).toBe(false);
    expect(preview.turns.slice(0, 3)).toEqual([
      { role: "user", text: "Fix the flaky\n\ntoast test" },
      { role: "assistant", text: "On it." },
      { role: "tool", name: "bash", summary: "pnpm test" },
    ]);
    expect(preview.turns.some((t) => t.role === "user" && t.text.includes("AAAA"))).toBe(false);
  });
});

describe("the window", () => {
  it("grows back past a record longer than itself, to the turns before it", async () => {
    const path = store(PI_A);
    const huge = JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(600_000) }] } });
    const answer = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "All green." }] } });
    await writeFile(path, `${await readFile(path, "utf8")}${huge}\n${answer}\n`);
    const preview = await readSessionPreview(ref("pi", path), env);
    expect(preview.truncated).toBe(false);
    expect(preview.turns[0]).toEqual({ role: "user", text: "Fix the flaky\n\ntoast test" });
    expect(preview.turns[preview.turns.length - 1]).toEqual({ role: "assistant", text: "All green." });
  });
});

describe("an opencode preview", () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = join(dir, "data", "opencode", "opencode.db");
  });

  function db(): DatabaseSync {
    return new sqlite.DatabaseSync(dbPath);
  }

  it("reads v2 session messages, newest last", async () => {
    const d = db();
    d.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
    const insert = d.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, 0, 0, ?)");
    insert.run("m1", "ses_a", "user", 1, JSON.stringify({ text: "Fix the toast" }));
    insert.run("m2", "ses_a", "model-switched", 2, JSON.stringify({ model: { id: "x" } }));
    insert.run(
      "m3",
      "ses_a",
      "assistant",
      3,
      JSON.stringify({
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "Looking." },
          { type: "tool", name: "read", state: { status: "completed", input: { filePath: "/r/toast.ts" }, content: [{ type: "text", text: "big" }] } },
          { type: "text", text: "Found it." },
        ],
      }),
    );
    insert.run("m4", "ses_other", "user", 1, JSON.stringify({ text: "not this one" }));
    d.close();
    const preview = await readSessionPreview(ref("opencode", dbPath, "ses_a"), env);
    expect(preview).toEqual({
      truncated: false,
      turns: [
        { role: "user", text: "Fix the toast" },
        { role: "assistant", text: "Looking." },
        { role: "tool", name: "read", summary: "/r/toast.ts" },
        { role: "assistant", text: "Found it." },
      ],
    });
    // Read without writing beside the database.
    expect((await readdir(join(dir, "data", "opencode"))).sort()).toEqual(["opencode.db"]);
  });

  it("reads v1 messages and parts, keeping only the newest turns", async () => {
    const d = db();
    d.exec(`
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    d.exec("BEGIN");
    const message = d.prepare("INSERT INTO message VALUES (?, 'ses_b', ?, ?, ?)");
    const part = d.prepare("INSERT INTO part VALUES (?, ?, 'ses_b', 0, 0, ?)");
    for (let i = 0; i < 30; i++) {
      const u = `m${String(i).padStart(3, "0")}u`;
      const a = `m${String(i).padStart(3, "0")}a`;
      message.run(u, i * 10, i * 10, JSON.stringify({ role: "user" }));
      part.run(`${u}-0`, u, JSON.stringify({ type: "text", text: i === 0 ? "First ask" : `ask ${i}` }));
      part.run(`${u}-1`, u, JSON.stringify({ type: "text", text: "injected", synthetic: true }));
      message.run(a, i * 10 + 1, i * 10 + 1, JSON.stringify({ role: "assistant" }));
      part.run(`${a}-0`, a, JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "ls" }, output: "big" } }));
      part.run(`${a}-1`, a, JSON.stringify({ type: "text", text: `answer ${i}` }));
    }
    d.exec("COMMIT");
    d.close();
    const preview = await readSessionPreview(ref("opencode", dbPath, "ses_b"), env);
    expect(preview.truncated).toBe(true);
    expect(preview.turns[0]).toEqual({ role: "user", text: "First ask", first: true });
    expect(preview.turns.slice(1)).toHaveLength(PREVIEW_TURNS);
    expect(preview.turns.slice(-3)).toEqual([
      { role: "user", text: "ask 29" },
      { role: "tool", name: "bash", summary: "ls" },
      { role: "assistant", text: "answer 29" },
    ]);
  });
});

describe("a database that can't be read in place", () => {
  it("is read from one cached copy, made once and shared while the database is unchanged", async () => {
    const dbPath = join(dir, "data", "opencode", "opencode.db");
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
    db.prepare("INSERT INTO session_message VALUES ('m1', 'ses_c', 'user', 1, 0, 0, ?)").run(JSON.stringify({ text: "From the WAL" }));
    // A crash's leftover: a WAL without its -shm, which a read-only open can't join.
    await rm(`${dbPath}-shm`);
    const copies = createSqliteCopyCache();
    const read = () =>
      readSqliteStore(sqlite, dbPath, (d) => d.prepare("SELECT COUNT(*) AS n FROM session_message").get(), {
        tempPrefix: "manor-test-",
        copies,
      });
    expect(await read()).toEqual({ n: 1 });
    const one = await copies.lease(sqlite, dbPath, "manor-test-");
    const two = await copies.lease(sqlite, dbPath, "manor-test-");
    expect(two.path).toBe(one.path);
    one.release();
    two.release();
    // The database moved on: a fresh copy.
    db.prepare("INSERT INTO session_message VALUES ('m2', 'ses_c', 'user', 2, 0, 0, ?)").run(JSON.stringify({ text: "More" }));
    await rm(`${dbPath}-shm`, { force: true });
    const three = await copies.lease(sqlite, dbPath, "manor-test-");
    expect(three.path).not.toBe(one.path);
    three.release();
    expect(await read()).toEqual({ n: 2 });
    const preview = await readSessionPreview(ref("opencode", dbPath, "ses_c"), env);
    expect(preview.turns).toEqual([
      { role: "user", text: "From the WAL" },
      { role: "user", text: "More" },
    ]);
    db.close();
  });
});

describe("which paths a preview reads", () => {
  it("refuses a file outside the kind's store, or another kind's", async () => {
    const outside = join(dir, "secret.jsonl");
    await writeFile(outside, '{"type":"user","message":{"role":"user","content":"secret"}}\n');
    await expect(readSessionPreview(ref("claude", outside), env)).rejects.toThrow(/not in this host's claude store/);
    await expect(readSessionPreview(ref("claude", store(CODEX_A)), env)).rejects.toThrow(/claude store/);
    await expect(
      readSessionPreview(ref("claude", `${store("claude/projects")}/../../../secret.jsonl`), env),
    ).rejects.toThrow(/claude store/);
    // A link inside the store to a file outside it.
    const link = store("claude/projects/-home-u-work-my-repo/link.jsonl");
    await symlink(outside, link);
    await expect(readSessionPreview(ref("claude", link), env)).rejects.toThrow(/claude store/);
    // opencode reads only its own database.
    await expect(readSessionPreview(ref("opencode", outside, "ses_a"), env)).rejects.toThrow(/opencode store/);
  });

  it("validates the ref's shape", () => {
    expect(() => assertSessionRef({ hostId: "local", kind: "bash", sessionId: "s", path: "/a" })).toThrow(/kind/);
    expect(() => assertSessionRef({ hostId: "local", kind: "pi", sessionId: 3, path: "/a" })).toThrow(/sessionId/);
    expect(() => assertSessionRef({ hostId: "local", kind: "pi", sessionId: "s", path: "a.jsonl" })).toThrow(/path/);
    expect(assertSessionRef({ hostId: "box", kind: "pi", sessionId: "s", path: "/a", extra: 1 })).toEqual({
      hostId: "box",
      kind: "pi",
      sessionId: "s",
      path: "/a",
    });
  });
});
