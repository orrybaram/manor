import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { parseOpencodeLocator } from "../sessions/opencode-locator";
import { createSqliteCopyCache, loadSqlite, readSqliteStore, type SqliteModule } from "../sessions/sqlite-store";
import { count, isRecord } from "./jsonl-scan";
import { countMessage, countState, type CountState } from "./seen-messages";
import type { UsageMarker, UsageRead, UsageReader } from "./usage-reader";

/**
 * opencode's usage, from its database. An opencode **Agent**'s
 * `transcriptPath` is a locator, `<db path>#<session id>`
 * (`../sessions/opencode-locator.ts`), read as the chat mirror reads it
 * (`../chat-mirror/opencode-db-source.ts`): opened read-only, through a copy
 * when locked, never writing beside it.
 *
 * - v1 schema: each `step-finish` part's `tokens`, one per model step;
 * - v2 schema (`session_message` has the session's rows): each `assistant`
 *   row's `tokens`.
 *
 * Fresh tokens are `input + output + reasoning + cache.write`. Rows are
 * updated in place, so the marker's `offset` is a cursor, the newest
 * `time_updated` counted; a read takes the rows updated at or after it, and
 * `seen` counts each row once, adding only an increase when one is read
 * again. Rows created before the marker's `floor` don't count.
 */

/** Rows a marker remembers: more than one step's worth re-read at the cursor. */
const RECENT_ROWS = 256;

type Row = Record<string, unknown>;

/** Fresh tokens in an opencode `tokens` object. */
export function opencodeFreshTokens(tokens: unknown): number {
  if (!isRecord(tokens)) return 0;
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  return count(tokens.input) + count(tokens.output) + count(tokens.reasoning) + count(cache.write);
}

function num(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function hasColumns(db: DatabaseSync, table: string, columns: string[]): boolean {
  if (!hasTable(db, table)) return false;
  const names = new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Row[]).map((c) => String(c.name)));
  return columns.every((c) => names.has(c));
}

/** Which schema holds the session: v2 when `session_message` has its rows. */
function schemaOf(db: DatabaseSync, sessionId: string): "v1" | "v2" | "none" {
  if (
    hasTable(db, "session_message") &&
    db.prepare("SELECT 1 FROM session_message WHERE session_id = ? LIMIT 1").get(sessionId) !== undefined
  ) {
    return "v2";
  }
  return hasTable(db, "part") ? "v1" : "none";
}

/** The session's usage rows updated at or after `cursor`, oldest update first. */
function usageRows(db: DatabaseSync, sessionId: string, cursor: number): Row[] {
  const schema = schemaOf(db, sessionId);
  if (schema === "v2") {
    return db
      .prepare(
        `SELECT id, time_created, time_updated,
           CASE WHEN json_valid(data) THEN json_extract(data, '$.tokens') END AS tokens
         FROM session_message
         WHERE session_id = ? AND type = 'assistant' AND time_updated >= ?
         ORDER BY time_updated, id`,
      )
      .all(sessionId, cursor) as Row[];
  }
  if (schema === "v1") {
    return db
      .prepare(
        `SELECT id, time_created, time_updated, json_extract(data, '$.tokens') AS tokens
         FROM part
         WHERE session_id = ? AND time_updated >= ? AND json_valid(data)
           AND json_extract(data, '$.type') = 'step-finish'
         ORDER BY time_updated, id`,
      )
      .all(sessionId, cursor) as Row[];
  }
  return [];
}

/**
 * When the session was created: its `session` row's `time_created` (a fork's
 * copied messages keep the original's times), else its first message's;
 * null when neither is there yet.
 */
function sessionCreatedAt(db: DatabaseSync, sessionId: string): number | null {
  for (const table of ["session_v2", "session"]) {
    if (!hasColumns(db, table, ["id", "time_created"])) continue;
    const row = db.prepare(`SELECT time_created FROM "${table}" WHERE id = ?`).get(sessionId) as Row | undefined;
    if (row && row.time_created !== null && row.time_created !== undefined) return num(row.time_created);
  }
  const schema = schemaOf(db, sessionId);
  const table = schema === "v2" ? "session_message" : schema === "v1" && hasTable(db, "message") ? "message" : null;
  if (!table) return null;
  const row = db.prepare(`SELECT min(time_created) AS first FROM ${table} WHERE session_id = ?`).get(sessionId) as
    | Row
    | undefined;
  return row?.first === null || row?.first === undefined ? null : num(row.first);
}

/**
 * Counts `rows` into `state`, unless `counting` is false (a marker at the
 * end: the rows are remembered, not counted). Returns the newest update.
 */
function countRows(state: CountState, rows: Row[], cursor: number, floor: number | undefined, counting: boolean): number {
  let newest = cursor;
  for (const row of rows) {
    newest = Math.max(newest, num(row.time_updated));
    const tokens = typeof row.tokens === "string" ? parseJson(row.tokens) : row.tokens;
    const fresh = opencodeFreshTokens(tokens);
    const before = state.fresh;
    countMessage(state, String(row.id), fresh, RECENT_ROWS);
    if (!counting || (floor !== undefined && num(row.time_created) < floor)) state.fresh = before;
  }
  return newest;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The opencode reader, over `sqlite` (default: this Node's `node:sqlite`, or none). */
export function createOpencodeUsageReader(opts: { sqlite?: SqliteModule | null } = {}): UsageReader {
  const sqlite = opts.sqlite === undefined ? loadSqlite() : opts.sqlite;
  const copies = createSqliteCopyCache();

  /** `read` on the locator's database; null when there is none to read. */
  async function withSession<T>(
    locator: string,
    read: (db: DatabaseSync, sessionId: string) => T,
  ): Promise<T | null> {
    const target = parseOpencodeLocator(locator);
    if (!sqlite || !target || !fs.existsSync(target.db)) return null;
    return readSqliteStore(
      sqlite,
      target.db,
      (db) => {
        // One read transaction: the schema check and the rows see one database.
        db.exec("BEGIN");
        try {
          return read(db, target.sessionId);
        } finally {
          db.exec("COMMIT");
        }
      },
      { tempPrefix: "manor-opencode-tally-", copies },
    );
  }

  /** Null when the source can't be read now (`UsageReader.read`). */
  async function scan(marker: UsageMarker, locator: string, counting: boolean): Promise<UsageRead | null> {
    const read = await withSession(locator, (db, sessionId) => {
      const state = countState(marker.seen);
      const offset = countRows(state, usageRows(db, sessionId, marker.offset), marker.offset, marker.floor, counting);
      return { state, offset };
    });
    if (!read) return null;
    const { state, offset } = read;
    const next: UsageMarker = { ...marker, offset, ...(state.seen.length > 0 ? { seen: state.seen } : {}) };
    return { fresh: state.fresh, next };
  }

  return {
    async sources(transcriptPath) {
      return [transcriptPath];
    },

    async createdAt(locator) {
      return withSession(locator, sessionCreatedAt);
    },

    async markerAtEnd(locator) {
      return (await scan({ offset: 0 }, locator, false))?.next ?? null;
    },

    read(marker, locator) {
      return scan(marker, locator, true);
    },
  };
}
