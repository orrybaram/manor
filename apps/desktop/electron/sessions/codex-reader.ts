/**
 * Codex CLI's Sessions, under `$CODEX_HOME` (else `~/.codex`).
 *
 * Codex keeps two stores of the same threads:
 * - a SQLite index, `state_5.sqlite` (in `$CODEX_SQLITE_HOME` when set),
 *   whose `threads` table holds a listing row per thread. Read first, read
 *   only, through `node:sqlite` where the running Node has it (Electron's
 *   does; a host on Node older than 22.13 does not);
 * - the rollouts themselves, `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`
 *   (and `archived_sessions/`), read when the index can't be: no
 *   `node:sqlite`, no database, or no `threads` table. Only each file's
 *   head and tail are read. Cold rollouts may be zstd-compressed
 *   (`.jsonl.zst`); their head is decompressed when this Node has zstd,
 *   else they are listed from the filename alone.
 *
 * User-given names also live in `session_index.jsonl` (`{id, thread_name}`,
 * newest line wins), used when the index row has none.
 *
 * Archived threads are listed: archiving is a filing choice in Codex, and
 * they are still resumable history. Sub-agent threads are not, as Claude's
 * subagent transcripts are not.
 *
 * Both stores are internal to Codex, so every column and field is read
 * defensively: the `threads` columns are discovered with `PRAGMA
 * table_info`, never assumed.
 */

import { open, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as zlib from "node:zlib";

import { LOCAL_HOST_ID } from "../backend/types";
import { readJsonlWindows } from "./jsonl-window";
import { readSqliteStore, type SqliteModule } from "./sqlite-store";
import { bareSummary, sessionRecordId } from "./summary";
import type { SessionEnv, SessionReader, SessionSummary } from "./types";

/** Codex's home on the host `env` describes. */
export function codexHome({ home, env }: SessionEnv): string {
  const dir = env.CODEX_HOME?.trim();
  return dir ? dir : join(home, ".codex");
}

/** Codex's SQLite index on the host `env` describes. */
export function codexStateDb(at: SessionEnv): string {
  const dir = at.env.CODEX_SQLITE_HOME?.trim();
  return join(dir ? dir : codexHome(at), "state_5.sqlite");
}

const FIRST_PROMPT_MAX = 1000;
const TITLE_MAX = 200;
/** A rollout's first record carries Codex's base instructions, which can run long. */
const ROLLOUT_WINDOW_BYTES = 256 * 1024;

/** What a user-role message that isn't the user's own starts with: Codex's injected context. */
const NOT_A_PROMPT = [
  "<environment_context>",
  "<user_instructions>",
  "<user_shell_command>",
  "<turn_aborted>",
  "# AGENTS.md instructions",
];

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function capped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asTitle(text: string): string {
  return capped(text.replace(/\s+/g, " ").trim(), TITLE_MAX);
}

function asPrompt(text: string | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed || NOT_A_PROMPT.some((prefix) => trimmed.startsWith(prefix)))
    return null;
  return capped(trimmed, FIRST_PROMPT_MAX);
}

/**
 * An ISO time from a column or field: epoch milliseconds, epoch seconds
 * (Codex's older `created_at`), or a date string. Null when unreadable.
 */
function isoTime(value: unknown): string | null {
  let ms: number | null = null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === "bigint") {
    return isoTime(Number(value));
  } else if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return isoTime(n);
    const parsed = Date.parse(value);
    ms = Number.isNaN(parsed) ? null : parsed;
  }
  return ms === null ? null : new Date(ms).toISOString();
}

/** Whether a thread's `source` marks it a sub-agent's (Codex writes `{"subagent": …}`). */
function isSubagentSource(source: unknown): boolean {
  if (isRec(source)) return "subagent" in source || "SubAgent" in source;
  return typeof source === "string" && /sub_?agent/i.test(source);
}

/** Let the event loop run between files: a large store must not hold up the server. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

async function stamp(path: string): Promise<FileStamp | null> {
  try {
    const info = await stat(path);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  return a?.size === b?.size && a?.mtimeMs === b?.mtimeMs;
}

// ---------------------------------------------------------------------------
// session_index.jsonl

/** Thread names by id from `session_index.jsonl`; the newest line wins. */
export function parseSessionIndex(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // A half-written line.
    }
    if (!isRec(record)) continue;
    const id = str(record.id);
    const name = str(record.thread_name);
    if (id && name) names.set(id, name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// The SQLite index

/**
 * `node:sqlite`, when this Node has it unflagged with read-only opens
 * (22.13+; Electron 44's Node 24 does). Through `getBuiltinModule`, so an
 * older Node, or a bundler that doesn't know the module, just gets null.
 */
function loadSqlite(): SqliteModule | null {
  try {
    const mod = process.getBuiltinModule?.("node:sqlite") as
      | SqliteModule
      | undefined;
    return mod && typeof mod.DatabaseSync === "function" ? mod : null;
  } catch {
    return null;
  }
}

/** The `threads` columns, by the names a summary needs, in order of preference. */
const COLUMNS = {
  id: ["id"],
  rolloutPath: ["rollout_path"],
  name: ["name", "thread_name"],
  title: ["title"],
  firstPrompt: ["first_user_message", "preview"],
  cwd: ["cwd"],
  gitBranch: ["git_branch"],
  model: ["model"],
  createdAt: ["created_at_ms", "created_at"],
  updatedAt: ["updated_at_ms", "updated_at", "recency_at_ms", "recency_at"],
  parent: ["forked_from_id", "parent_thread_id", "attached_thread_parent_id"],
  source: ["source"],
  hasUserEvent: ["has_user_event"],
} as const;

type Field = keyof typeof COLUMNS;

function pick(row: Rec, columns: Set<string>, field: Field): unknown {
  for (const column of COLUMNS[field]) {
    if (!columns.has(column)) continue;
    const value = row[column];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

/** One `threads` row's summary; null for a sub-agent's thread or one no one spoke in. */
export function summarizeCodexThread(
  row: Rec,
  columns: Set<string>,
  names: ReadonlyMap<string, string>,
): SessionSummary | null {
  const sessionId = str(pick(row, columns, "id"));
  if (!sessionId) return null;
  const sourceText = pick(row, columns, "source");
  let source: unknown = sourceText;
  if (typeof sourceText === "string" && sourceText.startsWith("{")) {
    try {
      source = JSON.parse(sourceText);
    } catch {
      // Not JSON after all; test the text.
    }
  }
  if (isSubagentSource(source)) return null;
  const firstPrompt = asPrompt(str(pick(row, columns, "firstPrompt")));
  const name = str(pick(row, columns, "name")) ?? names.get(sessionId) ?? null;
  const agentTitle = str(pick(row, columns, "title"));
  const hasUserEvent = pick(row, columns, "hasUserEvent");
  if (!firstPrompt && !name && (hasUserEvent === 0 || hasUserEvent === 0n))
    return null;
  const updatedAt =
    isoTime(pick(row, columns, "updatedAt")) ??
    isoTime(pick(row, columns, "createdAt"));
  const createdAt = isoTime(pick(row, columns, "createdAt")) ?? updatedAt;
  if (!updatedAt || !createdAt) return null;
  const parent = str(pick(row, columns, "parent"));
  return {
    id: sessionRecordId("codex", sessionId),
    hostId: LOCAL_HOST_ID,
    kind: "codex",
    sessionId,
    title: asTitle(name ?? agentTitle ?? firstPrompt ?? ""),
    firstPrompt: firstPrompt ?? "",
    cwd: str(pick(row, columns, "cwd")) ?? "",
    gitBranch: str(pick(row, columns, "gitBranch")),
    createdAt,
    updatedAt,
    messageCount: null,
    model: str(pick(row, columns, "model")),
    path: str(pick(row, columns, "rolloutPath")) ?? "",
    parentSessionId: parent && parent !== sessionId ? parent : null,
  };
}

/** Every row of `threads` in `db`, with its column names; null when the table is missing. */
function readThreads(
  db: DatabaseSync,
): { rows: Rec[]; columns: Set<string> } | null {
  const info = db.prepare("PRAGMA table_info(threads)").all();
  const columns = new Set(
    info.map((c) => (isRec(c) ? String(c.name) : "")).filter(Boolean),
  );
  if (!columns.has("id")) return null;
  const rows = db.prepare("SELECT * FROM threads").all().filter(isRec);
  return { rows, columns };
}

/**
 * `threads` from the database at `path`, read without writing beside it
 * (`./sqlite-store.ts`). Null when the table isn't there or no read works.
 */
async function queryThreads(
  sqlite: SqliteModule,
  path: string,
): Promise<{ rows: Rec[]; columns: Set<string> } | null> {
  try {
    return await readSqliteStore(sqlite, path, readThreads, {
      tempPrefix: "manor-codex-state-",
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rollout files

/** The thread id at the end of a rollout's name: `rollout-<ts>-<uuid>[_<uuid>].jsonl[.zst]`. */
const ROLLOUT_NAME =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]+)?\.jsonl(\.zst)?$/i;

function isRolloutName(name: string): boolean {
  return ROLLOUT_NAME.test(name);
}

/** The filename's timestamp (UTC) as ISO. */
function rolloutNameTime(ts: string): string | null {
  const [date, time] = ts.split("T");
  return isoTime(`${date}T${time.replace(/-/g, ":")}Z`);
}

/** The words of a `response_item` message's content. */
function messageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter(isRec)
    .filter((block) => block.type === "input_text" || block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""));
  return texts.join("\n");
}

/** The prompt the user typed in `record`, or null when it is anything else. */
function rolloutUserPrompt(
  record: Rec,
): { text: string; event: boolean } | null {
  const payload = isRec(record.payload) ? record.payload : null;
  if (!payload) return null;
  if (record.type === "event_msg" && payload.type === "user_message") {
    const text = asPrompt(str(payload.message));
    return text ? { text, event: true } : null;
  }
  if (
    record.type === "response_item" &&
    payload.type === "message" &&
    payload.role === "user"
  ) {
    const text = asPrompt(messageText(payload.content));
    return text ? { text, event: false } : null;
  }
  return null;
}

/**
 * One rollout's summary from its head and tail records; null for a
 * sub-agent's thread or one no one spoke in. `path` and `mtimeMs` fill
 * what the records don't.
 */
export function summarizeCodexRollout(
  path: string,
  mtimeMs: number,
  head: readonly unknown[],
  tail: readonly unknown[],
  names: ReadonlyMap<string, string>,
): SessionSummary | null {
  const match = ROLLOUT_NAME.exec(basename(path));
  let sessionId = match?.[2] ?? null;
  let createdAt = match ? rolloutNameTime(match[1]) : null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let parentSessionId: string | null = null;
  let firstPrompt: string | null = null;
  // Codex's own `user_message` event is the prompt as typed; a raw message is the fallback.
  let firstMessage: string | null = null;
  let model: string | null = null;
  let sawMeta = false;
  for (const record of head) {
    if (!isRec(record)) continue;
    const payload = isRec(record.payload) ? record.payload : null;
    if (record.type === "session_meta" && payload && !sawMeta) {
      sawMeta = true;
      if (isSubagentSource(payload.source)) return null;
      sessionId = str(payload.id) ?? sessionId;
      createdAt =
        isoTime(payload.timestamp) ?? isoTime(record.timestamp) ?? createdAt;
      cwd = str(payload.cwd);
      const git = isRec(payload.git) ? payload.git : null;
      gitBranch = str(git?.branch);
      parentSessionId =
        str(payload.forked_from_id) ?? str(payload.parent_thread_id);
      continue;
    }
    if (record.type === "turn_context" && payload) model ??= str(payload.model);
    const prompt = rolloutUserPrompt(record);
    if (prompt?.event) firstPrompt ??= prompt.text;
    else if (prompt) firstMessage ??= prompt.text;
  }
  for (const record of tail) {
    if (
      !isRec(record) ||
      record.type !== "turn_context" ||
      !isRec(record.payload)
    )
      continue;
    model = str(record.payload.model) ?? model;
    cwd = str(record.payload.cwd) ?? cwd;
  }
  if (!sessionId) return null;
  const prompt = firstPrompt ?? firstMessage;
  // Readable records, but no conversation: Codex made the file and no one spoke.
  if ((head.length > 0 || tail.length > 0) && !prompt) return null;
  const name = names.get(sessionId) ?? null;
  const updatedAt = new Date(mtimeMs).toISOString();
  return {
    id: sessionRecordId("codex", sessionId),
    hostId: LOCAL_HOST_ID,
    kind: "codex",
    sessionId,
    title: asTitle(name ?? prompt ?? ""),
    firstPrompt: prompt ?? "",
    cwd: cwd ?? "",
    gitBranch,
    createdAt: createdAt ?? updatedAt,
    updatedAt,
    messageCount: null,
    model,
    path,
    parentSessionId:
      parentSessionId && parentSessionId !== sessionId ? parentSessionId : null,
  };
}

/** Whether a rollout's `session_meta` says a sub-agent ran it. */
function subagentRollout(head: readonly unknown[]): boolean {
  const meta = head.find((r) => isRec(r) && r.type === "session_meta");
  return isRec(meta) && isRec(meta.payload) && isSubagentSource(meta.payload.source);
}

/**
 * The records in the first `windowBytes` of a zstd-compressed rollout, or
 * null when this Node has no zstd (it arrived in Node 22.15).
 */
async function readZstdHead(
  path: string,
  windowBytes = ROLLOUT_WINDOW_BYTES,
): Promise<unknown[] | null> {
  const createZstdDecompress = (
    zlib as { createZstdDecompress?: () => import("node:stream").Transform }
  ).createZstdDecompress;
  if (typeof createZstdDecompress !== "function") return null;
  const file = await open(path, "r");
  const input = file.createReadStream();
  const decompress = createZstdDecompress();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    input.pipe(decompress);
    for await (const chunk of decompress) {
      chunks.push(chunk as Buffer);
      total += (chunk as Buffer).length;
      if (total >= windowBytes) break;
    }
  } finally {
    input.destroy();
    decompress.destroy();
    await file.close().catch(() => undefined);
  }
  const lines = Buffer.concat(chunks)
    .subarray(0, windowBytes)
    .toString("utf8")
    .split("\n");
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // The line the window cut.
    }
  }
  return out;
}

async function dirEntries(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every rollout file under `dir`, nested by date or flat, a few levels deep. */
async function rolloutFiles(dir: string, depth = 4): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await dirEntries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth > 0)
      out.push(...(await rolloutFiles(path, depth - 1)));
    else if (entry.isFile() && isRolloutName(entry.name)) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The reader

/** No names: one map, so a rollout cached without an index stays cached. */
const NO_NAMES: ReadonlyMap<string, string> = new Map();

interface RolloutCacheEntry extends FileStamp {
  /** The index names it was summarized with; a changed index re-titles it. */
  names: ReadonlyMap<string, string>;
  summary: SessionSummary | null;
}

interface DbCache {
  db: FileStamp | null;
  wal: FileStamp | null;
  index: FileStamp | null;
  list: SessionSummary[];
}

/**
 * Codex's reader. The index is re-read only when the database, its WAL or
 * `session_index.jsonl` changed; a rollout only when its size or mtime did.
 */
export function createCodexReader(): SessionReader {
  let dbCache: DbCache | null = null;
  let indexCache: {
    stamp: FileStamp;
    names: ReadonlyMap<string, string>;
  } | null = null;
  const rolloutCache = new Map<string, RolloutCacheEntry>();

  const readNames = async (
    home: string,
  ): Promise<{
    stamp: FileStamp | null;
    names: ReadonlyMap<string, string>;
  }> => {
    const path = join(home, "session_index.jsonl");
    const at = await stamp(path);
    if (!at) return { stamp: null, names: NO_NAMES };
    if (indexCache && sameStamp(indexCache.stamp, at)) return indexCache;
    try {
      indexCache = {
        stamp: at,
        names: parseSessionIndex(await readFile(path, "utf8")),
      };
      return indexCache;
    } catch {
      return { stamp: at, names: NO_NAMES };
    }
  };

  const fromDb = async (
    dbPath: string,
    index: { stamp: FileStamp | null; names: ReadonlyMap<string, string> },
  ): Promise<SessionSummary[] | null> => {
    const sqlite = loadSqlite();
    if (!sqlite) return null;
    const db = await stamp(dbPath);
    if (!db) return null;
    const wal = await stamp(`${dbPath}-wal`);
    if (
      dbCache &&
      sameStamp(dbCache.db, db) &&
      sameStamp(dbCache.wal, wal) &&
      sameStamp(dbCache.index, index.stamp)
    ) {
      return dbCache.list;
    }
    const threads = await queryThreads(sqlite, dbPath);
    if (!threads) return null;
    const list: SessionSummary[] = [];
    for (const row of threads.rows) {
      const summary = summarizeCodexThread(row, threads.columns, index.names);
      if (summary) list.push(summary);
    }
    dbCache = { db, wal, index: index.stamp, list };
    return list;
  };

  const fromRollouts = async (
    home: string,
    names: ReadonlyMap<string, string>,
  ): Promise<SessionSummary[]> => {
    const files = [
      ...(await rolloutFiles(join(home, "sessions"))),
      ...(await rolloutFiles(join(home, "archived_sessions"))),
    ];
    const plain = new Set(files.filter((f) => f.endsWith(".jsonl")));
    const seen = new Set<string>();
    const byId = new Map<string, SessionSummary>();
    for (const path of files) {
      // Codex prefers a plain rollout over its compressed sibling.
      if (path.endsWith(".zst") && plain.has(path.slice(0, -".zst".length)))
        continue;
      const info = await stamp(path);
      if (!info) continue;
      seen.add(path);
      const cached = rolloutCache.get(path);
      let summary: SessionSummary | null;
      if (cached && sameStamp(cached, info) && cached.names === names) {
        summary = cached.summary;
      } else {
        try {
          if (path.endsWith(".zst")) {
            const head = await readZstdHead(path);
            summary = summarizeCodexRollout(
              path,
              info.mtimeMs,
              head ?? [],
              [],
              names,
            );
          } else {
            const { head, tail, capped } = await readJsonlWindows(
              path,
              info.size,
              ROLLOUT_WINDOW_BYTES,
            );
            summary = summarizeCodexRollout(
              path,
              info.mtimeMs,
              head,
              tail,
              names,
            );
            // A line too long to read is no sign no one spoke; a sub-agent's thread stays unlisted.
            const id =
              capped && !summary && !subagentRollout(head)
                ? ROLLOUT_NAME.exec(basename(path))?.[2]
                : null;
            if (id) summary = bareSummary("codex", id, path, info.mtimeMs);
          }
        } catch {
          continue; // Unreadable now; the next scan tries again.
        }
        rolloutCache.set(path, { ...info, names, summary });
        await yieldToLoop();
      }
      if (!summary) continue;
      // A reverted thread leaves more than one rollout: the newest stands for it.
      const prior = byId.get(summary.sessionId);
      if (!prior || prior.updatedAt < summary.updatedAt)
        byId.set(summary.sessionId, summary);
    }
    for (const path of rolloutCache.keys())
      if (!seen.has(path)) rolloutCache.delete(path);
    return [...byId.values()];
  };

  return {
    kind: "codex",
    async list(env) {
      const home = codexHome(env);
      const index = await readNames(home);
      const indexed = await fromDb(codexStateDb(env), index);
      if (indexed) return indexed;
      return fromRollouts(home, index.names);
    },
  };
}
