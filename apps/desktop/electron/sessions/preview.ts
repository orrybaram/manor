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
import { isAbsolute, join, relative } from "node:path";
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
import { createSqliteCopyCache, loadSqlite, readSqliteStore, type SqliteModule } from "./sqlite-store";
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
  /**
   * The transcript was too large to read to its end (a compressed rollout
   * past the decompression cap): the turns are not its latest.
   */
  partial?: true;
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
      return [join(codexHome(env), "sessions"), join(codexHome(env), "archived_sessions")];
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
  /** Decompression stopped at its cap: `size` is where it stopped, not the transcript's end. */
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

/** A compressed rollout's kept ends, decompressed. */
interface ZstdEnds {
  /** Its first {@link MAX_WINDOW_BYTES}: the head a first prompt is read from. */
  head: Buffer;
  /** Its last {@link MAX_WINDOW_BYTES} up to where decompression stopped. */
  tail: Buffer;
  total: number;
  partial: boolean;
}

/** Rollouts decompressed lately, by path, kept while their size and mtime hold: arrowing back reads none again. */
const ZSTD_CACHE_SIZE = 4;
const zstdCache = new Map<string, { stamp: string; ends: Promise<ZstdEnds> }>();

/**
 * A zstd-compressed rollout, decompressed as a stream: its first and last
 * {@link MAX_WINDOW_BYTES} are kept, the middle dropped as it goes. Past
 * {@link ZSTD_MAX_BYTES}, or {@link ZSTD_TIMEOUT_MS}, it stops, marked
 * partial: what it holds then is not the transcript's end.
 */
async function decompressEnds(path: string): Promise<ZstdEnds> {
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
      if (headBytes < MAX_WINDOW_BYTES) {
        head.push(chunk);
        headBytes += chunk.length;
      }
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tail.length > 1 && tailBytes - tail[0].length >= MAX_WINDOW_BYTES) {
        tailBytes -= tail[0].length;
        tail = tail.slice(1);
      }
      if (total >= zstdLimits.maxBytes || timedOut) {
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
  return { head: Buffer.concat(head).subarray(0, MAX_WINDOW_BYTES), tail: Buffer.concat(tail), total, partial };
}

/** How far a compressed rollout is decompressed; a test lowers it. */
export const zstdLimits = { maxBytes: ZSTD_MAX_BYTES };

/** A compressed rollout's ends: from the cache, from a decompression already running, or decompressed now. */
async function zstdSource(path: string): Promise<ByteSource> {
  const info = await stat(path);
  const stamp = `${info.size}:${info.mtimeMs}`;
  let entry = zstdCache.get(path);
  if (entry?.stamp !== stamp) {
    const ends = decompressEnds(path);
    entry = { stamp, ends };
    // A failure is not kept: the next preview tries again.
    ends.catch(() => {
      if (zstdCache.get(path)?.ends === ends) zstdCache.delete(path);
    });
  }
  // Newest last, so the first key is the one to drop.
  zstdCache.delete(path);
  zstdCache.set(path, entry);
  while (zstdCache.size > ZSTD_CACHE_SIZE) zstdCache.delete(zstdCache.keys().next().value as string);
  const { head, tail, total, partial } = await entry.ends;
  const tailStart = total - tail.length;
  return {
    size: total,
    partial,
    async read(start, end) {
      if (start >= tailStart) return tail.subarray(start - tailStart, end - tailStart);
      // The head: windows stay within the kept ends.
      return head.subarray(start, Math.min(end, head.length));
    },
    close: async () => undefined,
  };
}

/** A line and the byte it starts at. */
interface Line {
  text: string;
  offset: number;
}

/**
 * The lines of `bytes`, which start at byte `base`: less the first when the
 * window cut it, and the last when it ends mid-file.
 */
function lineSpans(bytes: Buffer, base: number, cutStart: boolean, cutEnd: boolean): Line[] {
  const out: Line[] = [];
  let at = 0;
  if (cutStart) {
    const nl = bytes.indexOf(NEWLINE);
    if (nl < 0) return out;
    at = nl + 1;
  }
  while (at < bytes.length) {
    let nl = bytes.indexOf(NEWLINE, at);
    if (nl < 0) {
      if (cutEnd) break;
      nl = bytes.length;
    }
    if (nl > at) out.push({ text: bytes.toString("utf8", at, nl), offset: base + at });
    at = nl + 1;
  }
  return out;
}

const NEWLINE = 0x0a;

/** Reads one kind's JSONL lines, in file order, into turns. */
interface LineParser {
  push(line: string): void;
  turns(): PreviewTurn[];
}

function parseAll(make: () => LineParser, input: readonly Line[]): PreviewTurn[] {
  const parser = make();
  for (const line of input) parser.push(line.text);
  return parser.turns();
}

/**
 * The Session's first prompt and the byte its line starts at. The head
 * window grows, up to {@link MAX_WINDOW_BYTES}, while no prompt is found:
 * a first message carrying a pasted image can be one long line.
 */
async function openingPrompt(
  source: ByteSource,
  make: () => LineParser,
): Promise<{ turn: PreviewTurn; offset: number } | null> {
  let end = Math.min(source.size, FIRST_WINDOW_BYTES);
  for (;;) {
    const parser = make();
    let seen = 0;
    for (const line of lineSpans(await source.read(0, end), 0, false, end < source.size)) {
      parser.push(line.text);
      const turns = parser.turns();
      const turn = turns.slice(seen).find((t) => t.role === "user");
      if (turn) return { turn, offset: line.offset };
      seen = turns.length;
    }
    if (end >= source.size || end >= MAX_WINDOW_BYTES) return null;
    end = Math.min(end * 4, MAX_WINDOW_BYTES, source.size);
    await yieldToLoop();
  }
}

/**
 * The last turns of a JSONL transcript. The window reads back from the end,
 * growing until it holds more than {@link PREVIEW_TURNS} turns, reaches the
 * start, or reaches {@link MAX_WINDOW_BYTES}; the opening prompt, when the
 * window misses it, comes from the head. A window holding no whole line (one
 * record longer than the cap) still gives the opening prompt.
 */
async function previewJsonl(source: ByteSource, make: () => LineParser): Promise<SessionPreview> {
  const { size } = source;
  let window = FIRST_WINDOW_BYTES;
  let start: number;
  let turns: PreviewTurn[];
  for (;;) {
    start = Math.max(0, size - window);
    turns = parseAll(make, lineSpans(await source.read(start, size), start, start > 0, false));
    if (start === 0 || turns.length > PREVIEW_TURNS || window >= MAX_WINDOW_BYTES) break;
    window = Math.min(window * 4, MAX_WINDOW_BYTES);
    await yieldToLoop();
  }
  const last = turns.slice(-PREVIEW_TURNS);
  const partial = source.partial ? ({ partial: true } as const) : {};
  if (turns.length === last.length && start === 0 && !source.partial) return { turns: last, truncated: false };
  const opening = await openingPrompt(source, make);
  if (!opening) return { turns: last, truncated: true, ...partial };
  // Whether the opening line is among the window's lines (the window's cut first line is not),
  // and then whether its turn survived the cut to the last turns: by position, not by text.
  const inWindow = start === 0 || opening.offset > start;
  const shown = inWindow && turns.findIndex((t) => t.role === "user") >= turns.length - last.length;
  return { turns: shown ? last : [{ ...opening.turn, first: true } as PreviewTurn, ...last], truncated: true, ...partial };
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

function claudeParser(): LineParser {
  const parser = claudeAdapter.createParser();
  return {
    push: (line) => void parser.push(line),
    turns: () => parser.entries().flatMap((entry) => claudeTurn(entry) ?? []),
  };
}

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
      // `apply_patch` as a function call carries its patch as `input`.
      const patch = isRec(args) && typeof args.input === "string" ? patchSummary(args.input) : null;
      return toolTurn(name, patch ?? inputSummary(args));
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

function codexParser(): LineParser {
  const out: PreviewTurn[] = [];
  return {
    push(line) {
      const record = json(line);
      if (!isRec(record) || record.type !== "response_item" || !isRec(record.payload)) return;
      const turn = codexTurn(record.payload);
      if (turn) out.push(turn);
    },
    turns: () => out,
  };
}

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

function piParser(): LineParser {
  const out: PreviewTurn[] = [];
  return {
    push(line) {
      const record = json(line);
      if (!isRec(record) || record.type !== "message" || !isRec(record.message)) return;
      const { role, content } = record.message;
      if (role === "user") out.push(...blockTurns(content, userTurn, () => null));
      else if (role === "assistant") {
        out.push(
          ...blockTurns(content, assistantTurn, (block) =>
            block.type === "toolCall" ? toolTurn(str(block.name) ?? "tool", inputSummary(block.arguments)) : null,
          ),
        );
      }
    },
    turns: () => out,
  };
}

// ---------------------------------------------------------------------------
// opencode: the database's newest messages

type Row = Record<string, unknown>;

/** The most messages one preview examines, newest first or oldest first. */
const OPENCODE_SCAN_MAX = 200;

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

/**
 * v1 `part` rows, with only the fields a turn needs pulled out in SQL: a
 * tool part's output, which can run to megabytes, is never parsed here.
 */
const V1_PARTS = `
  SELECT
    json_extract(data, '$.type') AS type,
    substr(json_extract(data, '$.text'), 1, ${TEXT_MAX + 1}) AS text,
    json_extract(data, '$.tool') AS tool,
    substr(coalesce(
      json_extract(data, '$.state.title'),
      json_extract(data, '$.state.input.description'),
      json_extract(data, '$.state.input.command'),
      json_extract(data, '$.state.input.filePath'),
      json_extract(data, '$.state.input.path'),
      json_extract(data, '$.state.input.pattern'),
      json_extract(data, '$.state.input.query'),
      json_extract(data, '$.state.input.url')
    ), 1, ${SUMMARY_MAX * 4}) AS summary,
    json_extract(data, '$.synthetic') AS synthetic,
    json_extract(data, '$.ignored') AS ignored
  FROM part WHERE message_id = ? AND json_valid(data) ORDER BY id`;

/** v1: a `message` row's role, its words and tool calls in its parts. */
function v1Turns(role: unknown, parts: Row[]): PreviewTurn[] {
  const blocks = parts
    .filter((p) => !p.synthetic && !p.ignored)
    .map((p) => ({ type: p.type, text: p.text, tool: p.tool, summary: p.summary }) as Rec);
  if (role === "user") return blockTurns(blocks, userTurn, () => null);
  if (role !== "assistant") return [];
  return blockTurns(blocks, assistantTurn, (block) =>
    block.type === "tool" ? toolTurn(str(block.tool) ?? "tool", str(block.summary)) : null,
  );
}

/** A turn and the message it came from. */
interface KeyedTurn {
  turn: PreviewTurn;
  key: string;
}

/**
 * Turns from messages read newest first, put back in order: the newest
 * `PREVIEW_TURNS`, each with its message's key, and whether more exist.
 */
function newestTurns(
  rows: Iterable<Row>,
  turnsOf: (row: Row) => PreviewTurn[],
  keyOf: (row: Row) => string,
): { turns: KeyedTurn[]; more: boolean } {
  const batches: KeyedTurn[][] = [];
  let count = 0;
  let examined = 0;
  let more = false;
  for (const row of rows) {
    if (++examined > OPENCODE_SCAN_MAX) {
      more = true;
      break;
    }
    const turns = turnsOf(row);
    if (turns.length === 0) continue;
    // A message with turns beyond the newest ones says there is more.
    if (count >= PREVIEW_TURNS) {
      more = true;
      break;
    }
    const key = keyOf(row);
    batches.push(turns.map((turn) => ({ turn, key })));
    count += turns.length;
  }
  const turns = batches.reverse().flat();
  if (turns.length > PREVIEW_TURNS) more = true;
  return { turns: turns.slice(-PREVIEW_TURNS), more };
}

/** One schema's newest turns, and how to find its first prompt. */
interface OpencodeRead {
  turns: KeyedTurn[];
  more: boolean;
  first: () => KeyedTurn | undefined;
}

/** The first user turn among the oldest messages. */
function firstUser(rows: Iterable<Row>, turnsOf: (row: Row) => PreviewTurn[], keyOf: (row: Row) => string): KeyedTurn | undefined {
  let examined = 0;
  for (const row of rows) {
    if (++examined > OPENCODE_SCAN_MAX) return undefined;
    const turn = turnsOf(row).find((t) => t.role === "user");
    if (turn) return { turn, key: keyOf(row) };
  }
  return undefined;
}

function readV2(db: DatabaseSync, sessionId: string): OpencodeRead | null {
  const cols = tableColumns(db, "session_message");
  if (!["id", "session_id", "type", "seq", "data"].every((c) => cols.has(c))) return null;
  const turnsOf = (row: Row): PreviewTurn[] => v2Turns(row.type, json(row.data));
  const keyOf = (row: Row): string => String(row.id);
  const rows = db
    .prepare(`SELECT id, type, data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT ${OPENCODE_SCAN_MAX + 1}`)
    .iterate(sessionId) as Iterable<Row>;
  const result = newestTurns(rows, turnsOf, keyOf);
  if (result.turns.length === 0) return null;
  const ascending = db.prepare(
    `SELECT id, type, data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT ${OPENCODE_SCAN_MAX + 1}`,
  );
  return { ...result, first: () => firstUser(ascending.iterate(sessionId) as Iterable<Row>, turnsOf, keyOf) };
}

function readV1(db: DatabaseSync, sessionId: string, tables: Set<string>): OpencodeRead | null {
  if (!tables.has("message") || !tables.has("part")) return null;
  const message = tableColumns(db, "message");
  const part = tableColumns(db, "part");
  if (!["id", "session_id", "data"].every((c) => message.has(c)) || !part.has("message_id") || !part.has("data"))
    return null;
  const order = message.has("time_created") ? "time_created DESC, id DESC" : "id DESC";
  const parts = db.prepare(V1_PARTS);
  const turnsOf = (row: Row): PreviewTurn[] => {
    const id = str(row.id);
    return id ? v1Turns(row.role, parts.all(id) as Row[]) : [];
  };
  const keyOf = (row: Row): string => String(row.id);
  const select = `SELECT id, CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END AS role FROM message WHERE session_id = ?`;
  const rows = db
    .prepare(`${select} ORDER BY ${order} LIMIT ${OPENCODE_SCAN_MAX + 1}`)
    .iterate(sessionId) as Iterable<Row>;
  const result = newestTurns(rows, turnsOf, keyOf);
  const ascending = db.prepare(`${select} ORDER BY ${order.replace(/ DESC/g, "")} LIMIT ${OPENCODE_SCAN_MAX + 1}`);
  return { ...result, first: () => firstUser(ascending.iterate(sessionId) as Iterable<Row>, turnsOf, keyOf) };
}

function readOpencode(db: DatabaseSync, sessionId: string): SessionPreview {
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => String(r.name)),
  );
  const found = (tables.has("session_message") ? readV2(db, sessionId) : null) ?? readV1(db, sessionId, tables);
  if (!found) return { turns: [], truncated: false };
  const turns = found.turns.map((t) => t.turn);
  if (!found.more) return { turns, truncated: false };
  const first = found.first();
  // By position: the first prompt's own message, not a later prompt with the same words.
  const shown = first && found.turns.some((t) => t.key === first.key && t.turn.role === "user");
  return { turns: first && !shown ? [{ ...first.turn, first: true } as PreviewTurn, ...turns] : turns, truncated: true };
}

// ---------------------------------------------------------------------------

export interface PreviewDeps {
  /** `node:sqlite`; null where this Node lacks it. */
  sqlite?: SqliteModule | null;
}

/** Copies of a locked opencode database, kept a while and shared by previews. */
const opencodeCopies = createSqliteCopyCache();

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
      copies: opencodeCopies,
    });
  }
  if (!(await stat(path)).isFile()) throw new Error("sessions.transcript: not a file");
  const make = ref.kind === "claude" ? claudeParser : ref.kind === "codex" ? codexParser : piParser;
  const source = path.endsWith(".zst") ? await zstdSource(path) : await fileSource(path);
  try {
    return await previewJsonl(source, make);
  } finally {
    await source.close();
  }
}
