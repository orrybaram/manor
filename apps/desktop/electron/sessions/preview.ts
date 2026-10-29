/**
 * A **Session**'s conversation for the Agents modal's preview pane: its
 * last turns, read from the end of its transcript on its own host.
 *
 * Bounded on every side: a JSONL transcript is read backward from its end
 * in a window that grows to {@link MAX_WINDOW_BYTES}, opencode's database
 * gives its newest messages, and each turn is capped and stripped of
 * images and tool output. Read-only, like every reader here: nothing is
 * written to, or beside, the agent's store.
 *
 * The caller names the transcript by path, so a path is read only when it
 * sits inside that kind's store on this host ({@link resolveSessionPath}):
 * the renderer cannot point this at an arbitrary file.
 */

import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream";
import * as zlib from "node:zlib";

import type { HostId } from "../backend/types";
import { claudeAdapter } from "../chat-mirror/adapters/claude";
import type { ChatEntry } from "../chat-mirror/transcript";
import type { AgentKind } from "../terminal-host/types";
import { claudeProjectsDir } from "./claude-reader";
import { codexHome, isCodexInjected } from "./codex-reader";
import { opencodeDbPath } from "./opencode-reader";
import { piSessionsRoot } from "./pi-reader";
import { loadSqlite, readSqliteStore, type SqliteModule } from "./sqlite-store";
import type { SessionEnv } from "./types";

/** One turn of a preview. Plain data: it crosses the bridge, and a host's server, as JSON. */
export type PreviewTurn =
  /** `first`: the Session's opening prompt, from before the window the other turns came from. */
  | { role: "user"; text: string; first?: true }
  /** Markdown, as the agent wrote it. */
  | { role: "assistant"; text: string }
  /** A tool call, as one line: no input beyond that, no output. */
  | { role: "tool"; name: string; summary: string };

export interface SessionPreview {
  /** Oldest first: the opening prompt (when outside the window), then the last turns. */
  turns: PreviewTurn[];
  /** Turns between the opening prompt and the last ones were left out. */
  truncated: boolean;
}

/** Which Session to preview: a `SessionSummary`'s own fields. */
export interface SessionRef {
  hostId: HostId;
  kind: AgentKind;
  sessionId: string;
  path: string;
}

/** The most turns a preview ends with. */
export const PREVIEW_TURNS = 40;
/** A user or assistant turn's text past this is cut. */
const TEXT_MAX = 4096;
/** A tool summary past this is cut. */
const SUMMARY_MAX = 200;
/** The first window read back from a transcript's end. */
const FIRST_WINDOW_BYTES = 256 * 1024;
/** The most a window grows to. */
const MAX_WINDOW_BYTES = 4 * 1024 * 1024;
/** The most of a compressed rollout decompressed, and how long that may take. */
const ZSTD_MAX_BYTES = 64 * 1024 * 1024;
const ZSTD_TIMEOUT_MS = 10_000;

const AGENT_KINDS: ReadonlySet<string> = new Set<AgentKind>(["claude", "codex", "opencode", "pi"]);

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

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function userTurn(text: string | null): PreviewTurn | null {
  const trimmed = text?.trim();
  return trimmed ? { role: "user", text: capped(trimmed, TEXT_MAX) } : null;
}

function assistantTurn(text: string | null): PreviewTurn | null {
  const trimmed = text?.trim();
  return trimmed ? { role: "assistant", text: capped(trimmed, TEXT_MAX) } : null;
}

function toolTurn(name: string, summary: string | null): PreviewTurn {
  const line = summary?.trim().split("\n", 1)[0]?.trim();
  return { role: "tool", name, summary: capped(line || name, SUMMARY_MAX) };
}

/** A tool call's one line, from the input fields agents' tools commonly take. */
function inputSummary(input: unknown): string | null {
  if (typeof input === "string") return str(input);
  if (!isRec(input)) return null;
  for (const key of ["description", "command", "cmd", "file_path", "filePath", "path", "pattern", "query", "url", "prompt"]) {
    const value = input[key];
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      // `["bash", "-lc", "pnpm test"]`: the script, not the shell.
      const words = value as string[];
      return str(words.length === 3 && words[1] === "-lc" ? words[2] : words.join(" "));
    }
    const text = str(value);
    if (text) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation

/** `ref` as a {@link SessionRef}, or a thrown error naming what is wrong with it. */
export function assertSessionRef(ref: unknown): SessionRef {
  if (!isRec(ref)) throw new Error("sessions.transcript: expected { hostId, kind, sessionId, path }");
  const { hostId, kind, sessionId, path } = ref;
  if (typeof hostId !== "string") throw new Error("sessions.transcript: hostId must be a string");
  if (typeof kind !== "string" || !AGENT_KINDS.has(kind)) throw new Error("sessions.transcript: unknown kind");
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512)
    throw new Error("sessions.transcript: sessionId must be a string");
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("sessions.transcript: path must be absolute");
  return { hostId, kind: kind as AgentKind, sessionId, path };
}

/** The roots `kind`'s transcripts live under on the host `env` describes. */
async function storeRoots(kind: AgentKind, env: SessionEnv): Promise<string[]> {
  switch (kind) {
    case "claude":
      return [claudeProjectsDir(env)];
    case "codex":
      return [codexHome(env)];
    case "pi":
      return [await piSessionsRoot(env)];
    case "opencode": {
      const db = opencodeDbPath(env);
      return db ? [db] : [];
    }
  }
}

async function real(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * `ref.path` with links resolved, when it is a transcript in `ref.kind`'s
 * store on this host: under a store root (opencode: the database itself),
 * with that kind's extension. Throws otherwise, so a renderer can read
 * nothing else.
 */
export async function resolveSessionPath(ref: SessionRef, env: SessionEnv): Promise<string> {
  const path = await real(ref.path);
  if (!path) throw new Error("sessions.transcript: no such transcript");
  const roots = await storeRoots(ref.kind, env);
  for (const root of roots) {
    const resolvedRoot = await real(root);
    if (!resolvedRoot) continue;
    if (ref.kind === "opencode") {
      if (path === resolvedRoot) return path;
      continue;
    }
    const named = ref.kind === "codex" ? /\.jsonl(\.zst)?$/.test(path) : path.endsWith(".jsonl");
    if (named && isInside(resolvedRoot, path)) return path;
  }
  throw new Error(`sessions.transcript: not in this host's ${ref.kind} store`);
}

// ---------------------------------------------------------------------------
// Reading a JSONL transcript from its end

/** Byte ranges of a transcript: a file on disk, or a decompressed rollout's two ends in memory. */
interface ByteSource {
  size: number;
  read(start: number, end: number): Promise<Buffer>;
  /** Only part of the transcript could be read. */
  partial: boolean;
  close(): Promise<void>;
}

async function fileSource(path: string): Promise<ByteSource> {
  const file = await open(path, "r");
  const { size } = await file.stat();
  return {
    size,
    partial: false,
    async read(start, end) {
      const buf = Buffer.alloc(end - start);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await file.read(buf, got, buf.length - got, start + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      return buf.subarray(0, got);
    },
    close: () => file.close(),
  };
}

/**
 * A zstd-compressed rollout, decompressed as a stream: its first window and
 * its last {@link MAX_WINDOW_BYTES} are kept, the middle dropped as it goes.
 * Past {@link ZSTD_MAX_BYTES}, or {@link ZSTD_TIMEOUT_MS}, what was read
 * stands in for the whole, marked partial.
 */
async function zstdSource(path: string): Promise<ByteSource> {
  const createZstdDecompress = (zlib as { createZstdDecompress?: () => import("node:stream").Transform })
    .createZstdDecompress;
  if (typeof createZstdDecompress !== "function") {
    throw new Error(`sessions.transcript: this Node (${process.versions.node}) cannot read compressed rollouts`);
  }
  const file = await open(path, "r");
  const input = file.createReadStream();
  const decompress = createZstdDecompress();
  pipeline(input, decompress, () => undefined);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    input.destroy();
  }, ZSTD_TIMEOUT_MS);
  const head: Buffer[] = [];
  let headBytes = 0;
  let tail: Buffer[] = [];
  let tailBytes = 0;
  let total = 0;
  let partial = false;
  try {
    for await (const raw of decompress) {
      const chunk = raw as Buffer;
      total += chunk.length;
      if (headBytes < FIRST_WINDOW_BYTES) {
        head.push(chunk);
        headBytes += chunk.length;
      }
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tail.length > 1 && tailBytes - tail[0].length >= MAX_WINDOW_BYTES) {
        tailBytes -= tail[0].length;
        tail = tail.slice(1);
      }
      if (total >= ZSTD_MAX_BYTES || timedOut) {
        partial = true;
        break;
      }
    }
  } catch (err) {
    if (!timedOut) throw err;
    partial = true;
  } finally {
    clearTimeout(timer);
    input.destroy();
    decompress.destroy();
    await file.close().catch(() => undefined);
  }
  const headBuf = Buffer.concat(head).subarray(0, FIRST_WINDOW_BYTES);
  const tailBuf = Buffer.concat(tail);
  const tailStart = total - tailBuf.length;
  return {
    size: total,
    partial,
    async read(start, end) {
      if (start >= tailStart) return tailBuf.subarray(start - tailStart, end - tailStart);
      if (end <= headBuf.length) return headBuf.subarray(start, end);
      // Never asked: windows stay within the kept ends.
      return tailBuf.subarray(Math.max(0, start - tailStart), end - tailStart);
    },
    close: async () => undefined,
  };
}

/** `last`, opened with the Session's first prompt, marked, unless it is already among them. */
function withOpening(first: PreviewTurn | undefined, last: PreviewTurn[]): PreviewTurn[] {
  if (first?.role !== "user") return last;
  if (last.some((t) => t.role === "user" && t.text === first.text)) return last;
  return [{ ...first, first: true }, ...last];
}

/** The lines of `bytes`, less the first when the window cut it. */
function lines(bytes: Buffer, cutStart: boolean, cutEnd: boolean): string[] {
  const out = bytes.toString("utf8").split("\n");
  if (cutStart) out.shift();
  if (cutEnd) out.pop();
  return out.filter((line) => line.length > 0);
}

/** A kind's JSONL lines, in file order, as turns. */
type LineParser = (lines: readonly string[]) => PreviewTurn[];

/**
 * The last turns of a JSONL transcript. The window reads back from the end,
 * growing until it holds more than {@link PREVIEW_TURNS} turns, reaches the
 * start, or reaches {@link MAX_WINDOW_BYTES}; the opening prompt, when the
 * window misses it, comes from the head.
 */
async function previewJsonl(source: ByteSource, parse: LineParser): Promise<SessionPreview> {
  const { size } = source;
  let window = FIRST_WINDOW_BYTES;
  let start: number;
  let turns: PreviewTurn[];
  for (;;) {
    start = Math.max(0, size - window);
    turns = parse(lines(await source.read(start, size), start > 0, false));
    if (start === 0 || turns.length > PREVIEW_TURNS || window >= MAX_WINDOW_BYTES) break;
    window = Math.min(window * 4, MAX_WINDOW_BYTES);
    await yieldToLoop();
  }
  const last = turns.slice(-PREVIEW_TURNS);
  const dropped = turns.length > last.length || start > 0 || source.partial;
  if (!dropped) return { turns: last, truncated: false };
  let first: PreviewTurn | undefined;
  if (start === 0) {
    first = turns.find((t) => t.role === "user");
  } else {
    const end = Math.min(size, FIRST_WINDOW_BYTES);
    first = parse(lines(await source.read(0, end), false, end < size)).find((t) => t.role === "user");
  }
  return { turns: withOpening(first, last), truncated: true };
}

// ---------------------------------------------------------------------------
// Claude: the chat mirror's parser

function claudeTurn(entry: ChatEntry): PreviewTurn | null {
  switch (entry.kind) {
    case "user":
      return userTurn(entry.text.replace(/\[Image #\d+\]/g, ""));
    case "assistant":
      return assistantTurn(entry.text);
    case "tool":
      return toolTurn(entry.name, entry.summary);
    case "edit":
      return toolTurn(entry.name, entry.path);
    case "task":
      return toolTurn(entry.taskKind === "agent" ? (entry.agentType ?? "Agent") : "Bash", entry.title);
    case "command":
      return userTurn(entry.shell ? `!${entry.name}` : `/${entry.name} ${entry.args}`);
    case "question":
      return toolTurn("AskUserQuestion", entry.questions[0]?.question ?? null);
    case "plan":
      return assistantTurn(entry.plan);
    case "notice":
      return null;
  }
}

const parseClaudeLines: LineParser = (input) => {
  const parser = claudeAdapter.createParser();
  for (const line of input) parser.push(line);
  return parser.entries().flatMap((entry) => claudeTurn(entry) ?? []);
};

// ---------------------------------------------------------------------------
// Codex: rollout `response_item`s

function codexText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter(isRec)
    .filter((b) => (b.type === "input_text" || b.type === "output_text" || b.type === "text") && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** `apply_patch`'s files, from its patch text. */
function patchSummary(patch: string): string | null {
  const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  return files.length > 0 ? files.join(", ") : null;
}

function codexTurn(payload: Rec): PreviewTurn | null {
  switch (payload.type) {
    case "message": {
      const text = codexText(payload.content);
      if (payload.role === "user") return text && !isCodexInjected(text) ? userTurn(text) : null;
      if (payload.role === "assistant") return assistantTurn(text);
      return null;
    }
    case "function_call": {
      const name = str(payload.name) ?? "tool";
      const args = json(payload.arguments);
      return toolTurn(name, inputSummary(args) ?? (typeof payload.arguments === "string" ? patchSummary(payload.arguments) : null));
    }
    case "custom_tool_call": {
      const name = str(payload.name) ?? "tool";
      const input = typeof payload.input === "string" ? payload.input : null;
      return toolTurn(name, input ? (patchSummary(input) ?? input) : null);
    }
    case "local_shell_call":
      return toolTurn("shell", isRec(payload.action) ? inputSummary(payload.action) : null);
    case "web_search_call":
      return toolTurn("web_search", isRec(payload.action) ? inputSummary(payload.action) : null);
    default:
      return null;
  }
}

const parseCodexLines: LineParser = (input) => {
  const out: PreviewTurn[] = [];
  for (const line of input) {
    const record = json(line);
    if (!isRec(record) || record.type !== "response_item" || !isRec(record.payload)) continue;
    const turn = codexTurn(record.payload);
    if (turn) out.push(turn);
  }
  return out;
};

// ---------------------------------------------------------------------------
// pi: `message` entries

/** Text blocks merged, and each tool call its own turn, in block order. */
function blockTurns(
  content: unknown,
  asText: (text: string) => PreviewTurn | null,
  tool: (block: Rec) => PreviewTurn | null,
): PreviewTurn[] {
  if (typeof content === "string") return [asText(content)].filter((t): t is PreviewTurn => t !== null);
  if (!Array.isArray(content)) return [];
  const out: PreviewTurn[] = [];
  let texts: string[] = [];
  const flush = (): void => {
    const turn = texts.length > 0 ? asText(texts.join("\n\n")) : null;
    if (turn) out.push(turn);
    texts = [];
  };
  for (const block of content) {
    if (!isRec(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
      continue;
    }
    const turn = tool(block);
    if (turn) {
      flush();
      out.push(turn);
    }
  }
  flush();
  return out;
}

const parsePiLines: LineParser = (input) => {
  const out: PreviewTurn[] = [];
  for (const line of input) {
    const record = json(line);
    if (!isRec(record) || record.type !== "message" || !isRec(record.message)) continue;
    const { role, content } = record.message;
    if (role === "user") out.push(...blockTurns(content, userTurn, () => null));
    else if (role === "assistant") {
      out.push(
        ...blockTurns(content, assistantTurn, (block) =>
          block.type === "toolCall" ? toolTurn(str(block.name) ?? "tool", inputSummary(block.arguments)) : null,
        ),
      );
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// opencode: the database's newest messages

type Row = Record<string, unknown>;

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Row[];
  return new Set(cols.map((c) => String(c.name)));
}

function opencodeToolTurn(name: unknown, state: unknown): PreviewTurn {
  const s = isRec(state) ? state : {};
  return toolTurn(str(name) ?? "tool", str(s.title) ?? inputSummary(json(s.input)));
}

/** v2: one `session_message` row per message, `data` the whole message. */
function v2Turns(type: unknown, data: unknown): PreviewTurn[] {
  if (!isRec(data)) return [];
  if (type === "user") return [userTurn(str(data.text))].filter((t): t is PreviewTurn => t !== null);
  if (type === "shell") return [toolTurn("shell", str(data.command))];
  if (type !== "assistant") return [];
  return blockTurns(data.content, assistantTurn, (block) =>
    block.type === "tool" ? opencodeToolTurn(block.name, block.state) : null,
  );
}

/** v1: a `message` row's role, its words and tool calls in `part` rows. */
function v1Turns(role: unknown, parts: unknown[]): PreviewTurn[] {
  const blocks = parts.filter((p): p is Rec => isRec(p) && !p.synthetic && !p.ignored);
  if (role === "user") return blockTurns(blocks, userTurn, () => null);
  if (role !== "assistant") return [];
  return blockTurns(blocks, assistantTurn, (block) =>
    block.type === "tool" ? opencodeToolTurn(block.tool, block.state) : null,
  );
}

/** Turns from messages read newest first, put back in order: the newest `PREVIEW_TURNS`, and whether more exist. */
function newestTurns(rows: Iterable<Row>, turnsOf: (row: Row) => PreviewTurn[]): { turns: PreviewTurn[]; more: boolean } {
  const batches: PreviewTurn[][] = [];
  let count = 0;
  let more = false;
  for (const row of rows) {
    if (count >= PREVIEW_TURNS) {
      // One more message with turns says there is more.
      if (turnsOf(row).length > 0) {
        more = true;
        break;
      }
      continue;
    }
    const turns = turnsOf(row);
    batches.push(turns);
    count += turns.length;
  }
  const turns = batches.reverse().flat();
  if (turns.length > PREVIEW_TURNS) more = true;
  return { turns: turns.slice(-PREVIEW_TURNS), more };
}

function readOpencode(db: DatabaseSync, sessionId: string): SessionPreview {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => String(r.name)),
  );
  let found: { turns: PreviewTurn[]; more: boolean; first: () => PreviewTurn | undefined } | null = null;
  if (tables.has("session_message") && ["session_id", "type", "seq", "data"].every((c) => tableColumns(db, "session_message").has(c))) {
    const rows = db
      .prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq DESC")
      .iterate(sessionId) as Iterable<Row>;
    const result = newestTurns(rows, (row) => v2Turns(row.type, json(row.data)));
    if (result.turns.length > 0) {
      const firstUser = db.prepare(
        "SELECT type, data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq",
      );
      found = {
        ...result,
        first: () => {
          for (const row of firstUser.iterate(sessionId) as Iterable<Row>) {
            const turn = v2Turns(row.type, json(row.data))[0];
            if (turn) return turn;
          }
          return undefined;
        },
      };
    }
  }
  if (!found && tables.has("message")) {
    const message = tableColumns(db, "message");
    const part = tables.has("part") ? tableColumns(db, "part") : new Set<string>();
    if (["id", "session_id", "data"].every((c) => message.has(c)) && part.has("message_id") && part.has("data")) {
      const order = message.has("time_created") ? "time_created DESC, id DESC" : "id DESC";
      const parts = db.prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id");
      const turnsOf = (row: Row): PreviewTurn[] => {
        const data = json(row.data);
        const id = str(row.id);
        if (!isRec(data) || !id) return [];
        return v1Turns(data.role, (parts.all(id) as Row[]).map((p) => json(p.data)));
      };
      const rows = db
        .prepare(`SELECT id, data FROM message WHERE session_id = ? ORDER BY ${order}`)
        .iterate(sessionId) as Iterable<Row>;
      const result = newestTurns(rows, turnsOf);
      const ascending = db.prepare(
        `SELECT id, data FROM message WHERE session_id = ? ORDER BY ${order.replace(/ DESC/g, "")}`,
      );
      found = {
        ...result,
        first: () => {
          for (const row of ascending.iterate(sessionId) as Iterable<Row>) {
            const turn = turnsOf(row).find((t) => t.role === "user");
            if (turn) return turn;
          }
          return undefined;
        },
      };
    }
  }
  if (!found) return { turns: [], truncated: false };
  if (!found.more) return { turns: found.turns, truncated: false };
  return { turns: withOpening(found.first(), found.turns), truncated: true };
}

// ---------------------------------------------------------------------------

export interface PreviewDeps {
  /** `node:sqlite`; null where this Node lacks it. */
  sqlite?: SqliteModule | null;
}

/**
 * The preview of the Session `ref` names, in this host's store as `env`
 * describes it. Throws for a path outside that store, or a transcript that
 * can't be read.
 */
export async function readSessionPreview(
  ref: SessionRef,
  env: SessionEnv,
  deps: PreviewDeps = {},
): Promise<SessionPreview> {
  const path = await resolveSessionPath(ref, env);
  if (ref.kind === "opencode") {
    const sqlite = deps.sqlite === undefined ? loadSqlite() : deps.sqlite;
    if (!sqlite) throw new Error(`sessions.transcript: this Node (${process.versions.node}) has no node:sqlite`);
    return readSqliteStore(sqlite, path, (db) => readOpencode(db, ref.sessionId), {
      tempPrefix: "manor-opencode-",
    });
  }
  if (!(await stat(path)).isFile()) throw new Error("sessions.transcript: not a file");
  const parse = ref.kind === "claude" ? parseClaudeLines : ref.kind === "codex" ? parseCodexLines : parsePiLines;
  const source = path.endsWith(".zst") ? await zstdSource(path) : await fileSource(path);
  try {
    return await previewJsonl(source, parse);
  } finally {
    await source.close();
  }
}
