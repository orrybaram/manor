/**
 * opencode's Sessions: rows in its SQLite database, `$OPENCODE_DB`, else
 * `opencode.db` in its data directory (`$XDG_DATA_HOME/opencode`, else
 * `~/.local/share/opencode`, on macOS too). A relative `$OPENCODE_DB`
 * resolves under the data directory. Builds on other release channels write
 * `opencode-<channel>.db`; those are not listed.
 *
 * The schema is mid-migration, so both shapes are read, each column
 * checked before it is used:
 * - v2 (`session_v2` + `session_message`): `model` is JSON `{id, providerID}`,
 *   a `user` message's `data.text` is what was typed;
 * - v1 (`session` + `message` + `part`): a message's `data.role` and
 *   `data.modelID`, a part's `data.type === "text"` with `data.text`.
 * When both exist, v1 rows not yet copied into `session_v2` are listed too.
 *
 * Child sessions (`parent_id`: a subtask's) and archived ones are not in
 * opencode's own picker, so they are not listed. A fork's
 * `fork_session_id` is its parent Session. The pre-1.2 JSON store
 * (`storage/session/**`) is not read: 1.2 migrated it into the database.
 *
 * The database is opened read-only through Node's built-in `node:sqlite`
 * (unflagged from Node 22.13; Electron's Node has it). Where Node lacks it,
 * opencode's Sessions are not listed. Opening it never writes beside it,
 * not even the `-wal`/`-shm` SQLite would make (`./sqlite-store.ts`).
 */

import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { LOCAL_HOST_ID } from "../backend/types";
import { loadSqlite, readSqliteStore, type SqliteModule } from "./sqlite-store";
import { sessionRecordId } from "./summary";
import type { SessionEnv, SessionReader, SessionSummary } from "./types";

/** opencode's database on the host `env` describes; null when it is in memory. */
export function opencodeDbPath({ home, env }: SessionEnv): string | null {
  const xdg = env.XDG_DATA_HOME?.trim();
  const dataDir = join(xdg ? xdg : join(home, ".local", "share"), "opencode");
  const db = env.OPENCODE_DB?.trim();
  if (!db) return join(dataDir, "opencode.db");
  if (db === ":memory:") return null;
  return isAbsolute(db) ? db : resolve(dataDir, db);
}

const FIRST_PROMPT_MAX = 1000;
const TITLE_MAX = 200;
/** Sessions summarized between yields to the event loop. */
const BATCH = 50;

type Rec = Record<string, unknown>;
type Row = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function capped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** An opencode time (epoch ms; seconds tolerated) as ISO, or null. */
function isoTime(value: unknown): string | null {
  const n = typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

/** The title opencode gives a Session before it has one of its own. */
function isPlaceholderTitle(title: string): boolean {
  return /^(New|Child) session - \d{4}-\d{2}-\d{2}T/.test(title);
}

function modelId(value: unknown): string | null {
  const model = json(value);
  if (typeof model === "string") return str(model);
  if (!isRec(model)) return null;
  return str(model.id) ?? str(model.modelID);
}

/** Each table's columns, from `sqlite_master` and `PRAGMA table_info`. */
function tableColumns(db: DatabaseSync): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Row[];
  for (const { name } of names) {
    if (typeof name !== "string") continue;
    const cols = db
      .prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`)
      .all() as Row[];
    tables.set(name, new Set(cols.map((c) => String(c.name))));
  }
  return tables;
}

/** `col` when `cols` has it, else NULL under that name: a column a schema lacks reads as null. */
function pick(cols: Set<string>, col: string): string {
  return cols.has(col) ? `"${col}"` : `NULL AS "${col}"`;
}

const SESSION_COLUMNS = [
  "id",
  "title",
  "directory",
  "parent_id",
  "fork_session_id",
  "model",
  "time_created",
  "time_updated",
  "time_archived",
];

interface SessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  forkOf: string | null;
  model: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** `time_updated` as stored: opencode bumps it on every message, so it keys the facts cache. */
  stamp: string;
}

/** The top-level, unarchived Sessions in `table`. */
function sessionRows(
  db: DatabaseSync,
  table: string,
  cols: Set<string>,
): SessionRow[] {
  const select = SESSION_COLUMNS.map((c) => pick(cols, c)).join(", ");
  const rows = db.prepare(`SELECT ${select} FROM "${table}"`).all() as Row[];
  const out: SessionRow[] = [];
  for (const row of rows) {
    const id = str(row.id);
    if (!id || str(row.parent_id) || row.time_archived != null) continue;
    const forkOf = str(row.fork_session_id);
    out.push({
      id,
      title: str(row.title),
      directory: str(row.directory),
      forkOf: forkOf && forkOf !== id ? forkOf : null,
      model: modelId(row.model),
      createdAt: isoTime(row.time_created),
      updatedAt: isoTime(row.time_updated),
      stamp: String(row.time_updated),
    });
  }
  return out;
}

/** What one Session's messages say: its first prompt, its latest model, how many there are. */
interface MessageFacts {
  firstPrompt: string | null;
  model: string | null;
  messageCount: number | null;
}

/** One Session's facts; its latest model only when `needModel` (its row names none). */
type MessageReader = (sessionId: string, needModel: boolean) => MessageFacts;

/** Facts by Session id, kept while its `time_updated` is unchanged. */
type FactsCache = Map<string, { key: string; facts: MessageFacts }>;

const NO_MESSAGES: MessageReader = () => ({
  firstPrompt: null,
  model: null,
  messageCount: null,
});

function count(row: Row | undefined): number | null {
  const n = row ? Object.values(row)[0] : null;
  return typeof n === "number" ? n : typeof n === "bigint" ? Number(n) : null;
}

/** v2: `session_message`, one row per message, `type` saying whose. */
function v2Messages(
  db: DatabaseSync,
  cols: Set<string> | undefined,
): MessageReader {
  if (!cols || !["session_id", "type", "seq", "data"].every((c) => cols.has(c)))
    return NO_MESSAGES;
  const first = db.prepare(
    "SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq",
  );
  const latest = db.prepare(
    "SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY seq DESC LIMIT 1",
  );
  const total = db.prepare(
    "SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant')",
  );
  return (sessionId, needModel) => {
    let firstPrompt: string | null = null;
    for (const row of first.iterate(sessionId) as Iterable<Row>) {
      const data = json(row.data);
      const text = isRec(data) ? str(data.text)?.trim() : null;
      if (text) {
        firstPrompt = capped(text, FIRST_PROMPT_MAX);
        break;
      }
    }
    const answer = needModel ? json((latest.get(sessionId) as Row | undefined)?.data) : null;
    return {
      firstPrompt,
      model: isRec(answer) ? modelId(answer.model) : null,
      messageCount: count(total.get(sessionId) as Row | undefined),
    };
  };
}

/** v1: `message` rows (`data.role`), their words in `part` rows. */
function v1Messages(
  db: DatabaseSync,
  message: Set<string> | undefined,
  part: Set<string> | undefined,
): MessageReader {
  if (!message || !["id", "session_id", "data"].every((c) => message.has(c)))
    return NO_MESSAGES;
  const order = message.has("time_created") ? "time_created, id" : "id";
  const ascending = db.prepare(
    `SELECT id, data FROM message WHERE session_id = ? ORDER BY ${order}`,
  );
  const descending = db.prepare(
    `SELECT data FROM message WHERE session_id = ? ORDER BY ${order.replace(/(\w+)/g, "$1 DESC")}`,
  );
  const total = db.prepare(
    "SELECT COUNT(*) AS n FROM message WHERE session_id = ?",
  );
  const parts =
    part && part.has("message_id") && part.has("data")
      ? db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id")
      : null;
  const typed = (messageId: string): string | null => {
    if (!parts) return null;
    const texts: string[] = [];
    for (const row of parts.all(messageId) as Row[]) {
      const data = json(row.data);
      if (
        !isRec(data) ||
        data.type !== "text" ||
        data.synthetic ||
        data.ignored
      )
        continue;
      const text = str(data.text);
      if (text) texts.push(text);
    }
    return texts.join("\n\n").trim() || null;
  };
  return (sessionId, needModel) => {
    let firstPrompt: string | null = null;
    for (const row of ascending.iterate(sessionId) as Iterable<Row>) {
      const data = json(row.data);
      const id = str(row.id);
      if (!isRec(data) || data.role !== "user" || !id) continue;
      const text = typed(id);
      if (text) {
        firstPrompt = capped(text, FIRST_PROMPT_MAX);
        break;
      }
    }
    let model: string | null = null;
    for (const row of needModel ? (descending.iterate(sessionId) as Iterable<Row>) : []) {
      const data = json(row.data);
      if (!isRec(data) || data.role !== "assistant") continue;
      model = str(data.modelID) ?? modelId(data.model);
      if (model) break;
    }
    return {
      firstPrompt,
      model,
      messageCount: count(total.get(sessionId) as Row | undefined),
    };
  };
}

function summarize(
  path: string,
  row: SessionRow,
  facts: MessageFacts,
): SessionSummary {
  const updatedAt = row.updatedAt ?? row.createdAt ?? new Date(0).toISOString();
  const named = row.title && !isPlaceholderTitle(row.title) ? row.title : null;
  return {
    id: sessionRecordId("opencode", row.id),
    hostId: LOCAL_HOST_ID,
    kind: "opencode",
    sessionId: row.id,
    title: capped(
      (named ?? facts.firstPrompt ?? row.title ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      TITLE_MAX,
    ),
    firstPrompt: facts.firstPrompt ?? "",
    cwd: row.directory ?? "",
    gitBranch: null,
    createdAt: row.createdAt ?? updatedAt,
    updatedAt,
    messageCount: facts.messageCount,
    model: row.model ?? facts.model,
    path,
    parentSessionId: row.forkOf,
  };
}

/** Let the event loop run between batches: a large store must not hold up the server. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Every listable Session in the open database `db`, which lives at `path`.
 * A Session's messages are read only when its `time_updated` moved since
 * `cache` saw it.
 */
async function readSessions(
  db: DatabaseSync,
  path: string,
  cache: FactsCache,
): Promise<SessionSummary[]> {
  const tables = tableColumns(db);
  const jobs: { row: SessionRow; messages: MessageReader; table: string }[] = [];
  const seen = new Set<string>();
  const v2 = tables.get("session_v2");
  if (v2?.has("id")) {
    const messages = v2Messages(db, tables.get("session_message"));
    for (const row of sessionRows(db, "session_v2", v2)) {
      seen.add(row.id);
      jobs.push({ row, messages, table: "v2" });
    }
  }
  const v1 = tables.get("session");
  if (v1?.has("id")) {
    const messages = v1Messages(db, tables.get("message"), tables.get("part"));
    for (const row of sessionRows(db, "session", v1)) {
      if (!seen.has(row.id)) jobs.push({ row, messages, table: "v1" });
    }
  }
  const out: SessionSummary[] = [];
  const listed = new Set<string>();
  for (const [i, { row, messages, table }] of jobs.entries()) {
    listed.add(row.id);
    const needModel = row.model === null;
    const key = `${table}|${row.stamp}|${needModel}`;
    let facts = cache.get(row.id)?.key === key ? cache.get(row.id)?.facts : undefined;
    if (!facts) {
      facts = messages(row.id, needModel);
      cache.set(row.id, { key, facts });
    }
    out.push(summarize(path, row, facts));
    if ((i + 1) % BATCH === 0) await yieldToLoop();
  }
  for (const id of cache.keys()) if (!listed.has(id)) cache.delete(id);
  return out;
}

/**
 * opencode's Sessions in the database at `path`, read without writing
 * beside it. No busy timeout: SQLite's wait would sleep on this thread, so
 * a lock goes straight to reading a copy.
 */
function readDatabase(sqlite: SqliteModule, path: string, cache: FactsCache): Promise<SessionSummary[]> {
  return readSqliteStore(sqlite, path, (db) => readSessions(db, path, cache), {
    tempPrefix: "manor-opencode-",
  });
}

/** A file's size and mtime, or "-" when it is absent. */
async function fileKey(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return "-";
  }
}

/**
 * opencode's reader. The whole database is one cache entry, kept while the
 * database's and its WAL's sizes and mtimes are unchanged.
 */
export function createOpencodeReader(
  sqlite: SqliteModule | null = loadSqlite(),
): SessionReader {
  let cached: { path: string; key: string; list: SessionSummary[] } | null =
    null;
  let warned = false;
  const facts: FactsCache = new Map();
  return {
    kind: "opencode",
    async list(env) {
      const path = opencodeDbPath(env);
      if (!path) return [];
      const dbKey = await fileKey(path);
      if (dbKey === "-") return [];
      if (!sqlite) {
        if (!warned)
          console.warn(
            `[sessions] this Node (${process.versions.node}) has no node:sqlite; opencode sessions are not listed`,
          );
        warned = true;
        return [];
      }
      const key = `${dbKey}|${await fileKey(`${path}-wal`)}`;
      if (cached && cached.path === path && cached.key === key)
        return cached.list;
      if (cached?.path !== path) facts.clear();
      const list = await readDatabase(sqlite, path, facts);
      // Keyed on what was there before the read, so a write made during it is read next time.
      cached = { path, key, list };
      return list;
    },
  };
}
