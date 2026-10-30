/**
 * An opencode session's transcript, read from opencode's database.
 *
 * opencode writes no transcript file: a session is rows in `opencode.db`,
 * and they are updated in place (a part streams its text, a tool part moves
 * from pending to completed). So an opencode **Agent**'s `transcriptPath` is
 * a locator, `<db path>#<session id>` (the plugin, `../opencode-plugin.ts`,
 * sends it), and this source turns the session's rows into lines the
 * opencode adapter (`./adapters/opencode.ts`) reads, one JSON object per row:
 *
 * - v1 schema: `{"t":"message",id,time_created,time_updated,data}` and
 *   `{"t":"part",id,message_id,time_created,time_updated,data}`;
 * - v2 schema: `{"t":"session_message",id,type,seq,time_created,time_updated,data}`;
 * - where this Node has no `node:sqlite`: one `{"t":"unsupported",node}`.
 *
 * The stream's offset is a cursor here, not a byte count (`TranscriptRead.next`):
 * the newest `time_updated` read. Each read returns the rows updated at or
 * after it (the boundary millisecond again, since rows are snapshots the
 * parser upserts by id), and `next` and `size` are the newest `time_updated`
 * now. Before reading rows, a cheap probe (row counts and newest
 * `time_updated`) answers "nothing changed" without reading any.
 *
 * Rows are deleted too: `/undo` and then a prompt drop the reverted turn's
 * rows. The source keeps the ids of the rows it has returned, so a count
 * that isn't those plus the new ones means rows went (or came in under the
 * cursor); that, an older newest row or another schema reads as `replaced`,
 * and the stream reads the session afresh and tells its subscribers.
 *
 * A session is read from v2 when `session_message` has rows for it, else
 * from v1. The database is opened as `sessions/sqlite-store.ts` opens it,
 * never writing beside it, through a copy when it is locked.
 */

import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteCopyCache, loadSqlite, readSqliteStore, type SqliteModule } from "../sessions/sqlite-store";
import { parseOpencodeLocator } from "../sessions/opencode-locator";
import type { TranscriptRead, TranscriptSource } from "./transcript-source";

type Row = Record<string, unknown>;

/** The probe's answer: what the session's rows add up to now. */
interface Probe {
  schema: "v1" | "v2" | "none";
  count: number;
  newest: number;
}

/** What the last read of a locator saw, to skip a read that would find nothing new. */
interface Seen {
  stamp: string;
  cursor: number;
  probe: Probe;
  /** Every row returned since the read from 0, as `<table>:<id>`. */
  ids: Set<string>;
}

/**
 * Columns a tool part can carry megabytes in: a tool's whole output and a
 * file's before and after. Dropped in SQL; the output's head is kept.
 */
const OUTPUT_HEAD = 4000;
const V1_PART_DATA = `json_remove(data, '$.state.output', '$.state.metadata.output',
  '$.state.metadata.filediff.before', '$.state.metadata.filediff.after')`;

function num(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function tables(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[];
  return new Set(rows.map((r) => String(r.name)));
}

function probe(db: DatabaseSync, sessionId: string, names: Set<string>): Probe {
  const stats = (sql: string): { count: number; newest: number } => {
    const row = db.prepare(sql).get(sessionId) as Row | undefined;
    return { count: num(row?.count), newest: num(row?.newest) };
  };
  if (names.has("session_message")) {
    const v2 = stats("SELECT count(*) AS count, max(time_updated) AS newest FROM session_message WHERE session_id = ?");
    if (v2.count > 0) return { schema: "v2", ...v2 };
  }
  if (names.has("message") && names.has("part")) {
    const m = stats("SELECT count(*) AS count, max(time_updated) AS newest FROM message WHERE session_id = ?");
    const p = stats("SELECT count(*) AS count, max(time_updated) AS newest FROM part WHERE session_id = ?");
    if (m.count > 0) return { schema: "v1", count: m.count + p.count, newest: Math.max(m.newest, p.newest) };
  }
  return { schema: "none", count: 0, newest: 0 };
}

/** The session's rows updated at or after `cursor`, as lines, in order. */
function rows(
  db: DatabaseSync,
  sessionId: string,
  schema: Probe["schema"],
  cursor: number,
): { lines: string[]; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];
  if (schema === "v2") {
    const found = db
      .prepare(
        `SELECT id, type, seq, time_created, time_updated, data FROM session_message
         WHERE session_id = ? AND time_updated >= ? ORDER BY seq`,
      )
      .all(sessionId, cursor) as Row[];
    for (const r of found) {
      ids.push(`session_message:${String(r.id)}`);
      lines.push(
        JSON.stringify({
          t: "session_message",
          id: r.id,
          type: r.type,
          seq: num(r.seq),
          time_created: num(r.time_created),
          time_updated: num(r.time_updated),
          data: json(r.data),
        }),
      );
    }
    return { lines, ids };
  }
  if (schema !== "v1") return { lines, ids };
  const messages = db
    .prepare(
      `SELECT id, time_created, time_updated, data FROM message
       WHERE session_id = ? AND time_updated >= ? ORDER BY id`,
    )
    .all(sessionId, cursor) as Row[];
  for (const r of messages) {
    ids.push(`message:${String(r.id)}`);
    lines.push(
      JSON.stringify({
        t: "message",
        id: r.id,
        time_created: num(r.time_created),
        time_updated: num(r.time_updated),
        data: json(r.data),
      }),
    );
  }
  const parts = db
    .prepare(
      `SELECT id, message_id, time_created, time_updated,
         CASE WHEN json_valid(data) THEN ${V1_PART_DATA} ELSE NULL END AS data,
         CASE WHEN json_valid(data) THEN substr(json_extract(data, '$.state.output'), 1, ${OUTPUT_HEAD}) END AS output
       FROM part WHERE session_id = ? AND time_updated >= ? ORDER BY message_id, id`,
    )
    .all(sessionId, cursor) as Row[];
  for (const r of parts) {
    ids.push(`part:${String(r.id)}`);
    const data = json(r.data);
    if (data && typeof data === "object" && typeof r.output === "string") {
      const state = (data as Row).state;
      if (state && typeof state === "object") (state as Row).output = r.output;
    }
    lines.push(
      JSON.stringify({
        t: "part",
        id: r.id,
        message_id: r.message_id,
        time_created: num(r.time_created),
        time_updated: num(r.time_updated),
        data,
      }),
    );
  }
  return { lines, ids };
}

export interface OpencodeDbSourceOptions {
  /** `node:sqlite`; null where this Node lacks it. Default: this Node's. */
  sqlite?: SqliteModule | null;
}

/** opencode sessions' rows, from the databases on this machine. */
export class OpencodeDbSource implements TranscriptSource {
  private readonly sqlite: SqliteModule | null;
  private readonly seen = new Map<string, Seen>();
  private readonly copies = createSqliteCopyCache();

  constructor(opts: OpencodeDbSourceOptions = {}) {
    this.sqlite = opts.sqlite === undefined ? loadSqlite() : opts.sqlite;
  }

  async read(locator: string, cursor: number): Promise<TranscriptRead> {
    const target = parseOpencodeLocator(locator);
    if (!target) return { ok: false, error: `not an opencode session: ${locator}` };
    if (!this.sqlite) {
      // Said once, at the start; the cursor past it reads nothing more.
      const data = cursor === 0 ? `${JSON.stringify({ t: "unsupported", node: process.versions.node })}\n` : "";
      return { ok: true, size: 1, next: 1, data };
    }
    if (!fs.existsSync(target.db)) return { ok: true, size: 0, data: "" }; // Not written yet.
    const sqlite = this.sqlite;
    try {
      return await readSqliteStore(
        sqlite,
        target.db,
        (db) => this.readSession(db, locator, target.sessionId, cursor),
        { tempPrefix: "manor-opencode-chat-", copies: this.copies },
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private readSession(db: DatabaseSync, locator: string, sessionId: string, cursor: number): TranscriptRead {
    // One read transaction: the probe and the rows see the same database.
    db.exec("BEGIN");
    try {
      return this.readSnapshot(db, locator, sessionId, cursor);
    } finally {
      db.exec("COMMIT");
    }
  }

  private readSnapshot(db: DatabaseSync, locator: string, sessionId: string, cursor: number): TranscriptRead {
    const now = probe(db, sessionId, tables(db));
    const stamp = `${now.schema}:${now.count}:${now.newest}`;
    // A read from 0 starts afresh; any other continues the last one.
    const last = cursor > 0 ? this.seen.get(locator) : undefined;
    if (cursor === 0) this.seen.delete(locator);
    const replaced = (): TranscriptRead => {
      this.seen.delete(locator);
      return { ok: true, size: 0, data: "", replaced: true };
    };
    // Nothing known of what the stream read before, another schema, or older rows.
    if (cursor > 0 && (!last || now.schema !== last.probe.schema || now.newest < last.probe.newest)) {
      return replaced();
    }
    if (now.schema === "none") return { ok: true, size: 0, data: "" }; // Not written yet.
    if (last && last.stamp === stamp && last.cursor === cursor) {
      return { ok: true, size: cursor, next: cursor, data: "" };
    }
    const read = rows(db, sessionId, now.schema, cursor);
    const ids = new Set(last?.ids);
    for (const id of read.ids) ids.add(id);
    // Rows went, or came in under the cursor: what was read before is not the session now.
    if (cursor > 0 && ids.size !== now.count) return replaced();
    this.seen.set(locator, { stamp, cursor: now.newest, probe: now, ids });
    return {
      ok: true,
      size: now.newest,
      next: now.newest,
      data: read.lines.length > 0 ? `${read.lines.join("\n")}\n` : "",
    };
  }

  /** opencode writes through its WAL: a change there is a change to the session, likely. */
  watch(locator: string, onChange: () => void): () => void {
    const target = parseOpencodeLocator(locator);
    if (!target) return () => {};
    let watcher: fs.FSWatcher | null = null;
    try {
      watcher = fs.watch(`${target.db}-wal`, { persistent: false }, onChange);
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      // No WAL yet, or not watchable: the stream's poll covers it.
      watcher = null;
    }
    return () => {
      watcher?.close();
      watcher = null;
    };
  }
}
