/**
 * opencode's sessions, as the lines `OpencodeDbSource` makes of their
 * database rows (`../opencode-db-source.ts`).
 *
 * Rows are updated in place, so every line is an upsert: a row read again
 * replaces what it said before, and only entries that changed are returned.
 * Entries are kept in the session's order (message, then part, by their
 * ascending ids; v2 by `seq`), whatever order the rows were updated in.
 *
 * - v1 (`message` + `part`): a `text` part is the user's or the assistant's
 *   words, by its message's role (synthetic and ignored ones are opencode's
 *   own); a `tool` part is a tool entry, named as Claude's tools are so the
 *   chat groups them alike, its status from `state.status`; a landed
 *   edit/write/patch with a diff in `state.metadata.diff` is an edit entry; a
 *   `task` tool is a task, whose child session is its transcript; a
 *   `compaction` part a notice. The newest `step-finish` part's tokens are
 *   the context size, and the newest assistant message's `modelID` the
 *   model. The turn: the newest message a user's is working, an
 *   assistant's still streaming or stopped for tool calls is working, one
 *   aborted is interrupted, else done.
 * - v2 (`session_message`): `user` and `assistant` (its `content` blocks:
 *   text, tool) as above, `shell` a shell command, `compaction` a notice,
 *   `idle` ends the turn by its `outcome`.
 *
 * Reasoning, file, snapshot and step-start parts have no entry.
 */

import { encodeChatMessage } from "../picker-keys";
import { CHAT_SUBMIT } from "../chat-keys";
import { opencodeLocator, parseOpencodeLocator } from "../../sessions/opencode-locator";
import type { ChatDiffHunk, ChatEntry, ChatSessionInfo, ChatTurnState } from "../transcript";
import type { TranscriptAdapter, TranscriptLineParser } from "./types";

type Json = Record<string, unknown>;

const MAX_DETAIL = 4000;
const MAX_HUNKS = 40;
const MAX_HUNK_LINES = 400;
const MAX_LINE_CHARS = 1000;
const MAX_EDIT_CHARS = 64 * 1024;

/** opencode's tool names as Claude's, which the chat groups and words. */
const TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  multiedit: "MultiEdit",
  write: "Write",
  patch: "Edit",
  apply_patch: "Edit",
  grep: "Grep",
  glob: "Glob",
  list: "LS",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  task: "Task",
};
const EDIT_TOOLS = new Set(["edit", "multiedit", "write", "patch", "apply_patch"]);
/** A child session's id: nothing that could step out of a locator. */
const SESSION_ID = /^ses_[A-Za-z0-9]+$/;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function iso(ms: unknown): string {
  const n = num(ms);
  if (n === undefined || n <= 0) return new Date(0).toISOString();
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0].trim();
}

/** What a model read: fresh and cached input. Null when the tokens say nothing. */
function contextSize(tokens: unknown): number | null {
  if (!isObject(tokens)) return null;
  const cache = isObject(tokens.cache) ? tokens.cache : {};
  const parts = [num(tokens.input), num(cache.read), num(cache.write)];
  if (parts.every((p) => p === undefined)) return null;
  const total = parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);
  return total > 0 ? total : null;
}

function relativeTo(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) && path.length > base.length ? path.slice(base.length) : path;
}

function summarize(tool: string, state: Json): string {
  const input = isObject(state.input) ? state.input : {};
  const title = str(state.title)?.trim();
  if (title) return firstLine(title);
  for (const key of ["description", "command", "filePath", "path", "pattern", "query", "url"]) {
    const v = str(input[key])?.trim();
    if (v) return firstLine(v);
  }
  return TOOL_NAMES[tool] ?? tool;
}

/**
 * A unified diff's hunks, or none when it has no `@@` header. A hunk takes
 * the lines its header counts, so a next file's `---`/`+++` header after it
 * is not read as a change.
 */
export function parseUnifiedDiff(diff: string): ChatDiffHunk[] {
  const hunks: ChatDiffHunk[] = [];
  let current: ChatDiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      oldLeft = current.oldLines;
      newLeft = current.newLines;
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    // "\ No newline at end of file" belongs to the line before it.
    if (line.startsWith("\\")) {
      current.lines.push(line);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    if (line.startsWith("+")) newLeft--;
    else if (line.startsWith("-")) oldLeft--;
    else if (line.startsWith(" ") || line === "") {
      oldLeft--;
      newLeft--;
    } else continue;
    current.lines.push(line === "" ? " " : line);
  }
  return hunks.filter((h) => h.lines.length > 0);
}

/** An edit entry from a landed tool's hunks: counted over all, then capped. */
function editEntry(id: string, ts: string, name: string, path: string, all: ChatDiffHunk[]): ChatEntry | null {
  if (all.length === 0) return null;
  let added = 0;
  let removed = 0;
  for (const h of all) {
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  let truncated = all.length > MAX_HUNKS;
  let budget = MAX_EDIT_CHARS;
  const hunks: ChatDiffHunk[] = [];
  for (const h of all.slice(0, MAX_HUNKS)) {
    if (h.lines.length > MAX_HUNK_LINES) truncated = true;
    const lines: string[] = [];
    for (const raw of h.lines.slice(0, MAX_HUNK_LINES)) {
      let l = raw;
      if (l.length > MAX_LINE_CHARS) {
        truncated = true;
        l = `${l.slice(0, MAX_LINE_CHARS)}…`;
      }
      if (l.length > budget) {
        budget = 0;
        break;
      }
      budget -= l.length;
      lines.push(l);
    }
    if (lines.length > 0) hunks.push({ ...h, lines });
    if (budget === 0) {
      truncated = true;
      break;
    }
  }
  if (hunks.length === 0) return null;
  return { kind: "edit", id, ts, name, path, hunks, added, removed, truncated };
}

/** A tool's output as text: v1's string, v2's content blocks. */
function outputText(state: Json): string {
  const out = state.output;
  if (typeof out === "string") return out;
  const content = Array.isArray(state.content) ? state.content : [];
  return content
    .filter(isObject)
    .map((b) => (b.type === "text" ? (str(b.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The entry a tool call makes, in either schema: `tool` is opencode's name,
 * `state` its `{status, input, output|content, title, metadata, error}`.
 */
function toolEntry(id: string, ts: string, tool: string, state: Json, cwd: string | undefined): ChatEntry {
  const status = str(state.status);
  const done = status === "completed";
  const failed = status === "error";
  const input = isObject(state.input) ? state.input : {};
  const metadata = isObject(state.metadata) ? state.metadata : {};
  const name = TOOL_NAMES[tool] ?? tool;

  if (tool === "task") {
    const child = str(metadata.sessionId) ?? str(metadata.sessionID);
    const result = done ? outputText(state) : failed ? (str(state.error) ?? outputText(state)) : "";
    return {
      kind: "task",
      id,
      ts,
      taskKind: "agent",
      title: str(input.description)?.trim() || str(input.subagent_type) || "Task",
      agentType: str(input.subagent_type),
      background: false,
      status: done ? "ok" : failed ? "error" : "running",
      ...(result ? { result: result.slice(0, MAX_DETAIL) } : {}),
      ...(child ? { taskRef: child } : {}),
    };
  }

  if (done && EDIT_TOOLS.has(tool)) {
    const file = str(input.filePath) ?? str(metadata.filepath) ?? "";
    const diff = str(metadata.diff);
    let hunks = diff ? parseUnifiedDiff(diff) : [];
    const content = str(input.content);
    if (hunks.length === 0 && tool === "write" && content) {
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
    }
    const edit = editEntry(id, ts, name, relativeTo(file, cwd), hunks);
    if (edit) return edit;
  }

  const text = failed ? (str(state.error) ?? outputText(state)) : done ? outputText(state) : "";
  return {
    kind: "tool",
    id,
    ts,
    name,
    summary: summarize(tool, state),
    status: done ? "ok" : failed ? "error" : "pending",
    ...(text ? { detail: text.slice(0, MAX_DETAIL) } : {}),
  };
}

/** A v1 message, as much of it as the parser needs. */
interface Message {
  role: "user" | "assistant" | "other";
  created: number;
  cwd?: string;
  /** Still streaming: no `time.completed`. */
  open: boolean;
  finish?: string;
  aborted: boolean;
}

interface Part {
  messageId: string;
  data: Json;
  created: number;
}

class OpencodeParser implements TranscriptLineParser {
  /** Each entry by id, and the key that orders it. */
  private readonly byId = new Map<string, { entry: ChatEntry; key: string }>();
  private sorted: ChatEntry[] | null = [];
  private readonly messages = new Map<string, Message>();
  /** v1 parts by id, and each message's part ids. */
  private readonly parts = new Map<string, Part>();
  private readonly partsOf = new Map<string, Set<string>>();
  /** Context size by the key of what said it, the newest key winning. */
  private context: { key: string; tokens: number } | null = null;
  /** The turn by the key of what said it, the newest key winning. */
  private turn: { key: string; state: ChatTurnState } | null = null;
  /** The model by the key of the v1 assistant message that named it, the newest key winning. */
  private model: { key: string; id: string } | null = null;

  push(line: string): ChatEntry[] {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(row)) return [];
    switch (row.t) {
      case "message":
        return this.message(row);
      case "part":
        return this.part(row);
      case "session_message":
        return this.sessionMessage(row);
      case "unsupported":
        return this.set("opencode-unsupported", "", {
          kind: "notice",
          id: "opencode-unsupported",
          ts: new Date().toISOString(),
          text: `This host's Node (${str(row.node) ?? "unknown"}) has no node:sqlite, so opencode's chat can't be read here. Node 22.13 or later has it.`,
          status: "error",
        });
      default:
        return [];
    }
  }

  entries(): ChatEntry[] {
    if (!this.sorted) {
      this.sorted = [...this.byId.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((v) => v.entry);
    }
    return this.sorted;
  }

  entry(id: string): ChatEntry | undefined {
    return this.byId.get(id)?.entry;
  }

  contextTokens(): number | null {
    return this.context?.tokens ?? null;
  }

  turnState(): ChatTurnState | null {
    return this.turn?.state ?? null;
  }

  /** Only the model: opencode's rows name no effort or git branch. */
  sessionInfo(): ChatSessionInfo {
    return { model: this.model?.id ?? null, effort: null, gitBranch: null };
  }

  skills(): [] {
    return [];
  }

  hasSkillListing(): boolean {
    return false;
  }

  /** Upsert `entry` under `key`; it is returned only if it changed. */
  private set(id: string, key: string, entry: ChatEntry): ChatEntry[] {
    const had = this.byId.get(id);
    if (had && had.key === key && JSON.stringify(had.entry) === JSON.stringify(entry)) return [];
    this.byId.set(id, { entry, key });
    this.sorted = null;
    return [entry];
  }

  private drop(id: string): void {
    if (this.byId.delete(id)) this.sorted = null;
  }

  private sayContext(key: string, tokens: unknown): void {
    const size = contextSize(tokens);
    if (size !== null && (!this.context || key >= this.context.key)) this.context = { key, tokens: size };
  }

  private sayTurn(key: string, state: ChatTurnState): void {
    if (!this.turn || key >= this.turn.key) this.turn = { key, state };
  }

  // ── v1 ──

  private message(row: Json): ChatEntry[] {
    const id = str(row.id);
    const data = isObject(row.data) ? row.data : null;
    if (!id || !data) return [];
    const time = isObject(data.time) ? data.time : {};
    const error = isObject(data.error) ? data.error : null;
    const role = data.role === "user" || data.role === "assistant" ? data.role : "other";
    const msg: Message = {
      role,
      created: num(time.created) ?? num(row.time_created) ?? 0,
      cwd: isObject(data.path) ? str(data.path.cwd) : undefined,
      open: role === "assistant" && num(time.completed) === undefined && !error,
      finish: str(data.finish),
      aborted: str(error?.name) === "MessageAbortedError",
    };
    this.messages.set(id, msg);
    const key = `m:${id}`;
    if (role === "user") this.sayTurn(key, "working");
    else if (role === "assistant") {
      this.sayContext(key, data.tokens);
      const model = str(data.modelID);
      if (model && (!this.model || key >= this.model.key)) this.model = { key, id: model };
      const state: ChatTurnState = msg.aborted
        ? "interrupted"
        : msg.open || msg.finish === "tool-calls"
          ? "working"
          : "done";
      this.sayTurn(key, state);
    }
    // Its parts may have come first, or its role changes what they are.
    const out: ChatEntry[] = [];
    for (const partId of this.partsOf.get(id) ?? []) out.push(...this.partEntry(partId));
    return out;
  }

  private part(row: Json): ChatEntry[] {
    const id = str(row.id);
    const messageId = str(row.message_id);
    const data = isObject(row.data) ? row.data : null;
    if (!id || !messageId || !data) return [];
    this.parts.set(id, { messageId, data, created: num(row.time_created) ?? 0 });
    let ids = this.partsOf.get(messageId);
    if (!ids) this.partsOf.set(messageId, (ids = new Set()));
    ids.add(id);
    if (data.type === "step-finish") {
      this.sayContext(`m:${messageId}:${id}`, data.tokens);
    }
    return this.partEntry(id);
  }

  /** The entry part `id` makes now, if any. */
  private partEntry(id: string): ChatEntry[] {
    const part = this.parts.get(id);
    if (!part) return [];
    const msg = this.messages.get(part.messageId);
    const { data } = part;
    const key = `m:${part.messageId}:${id}`;
    const time = isObject(data.time) ? data.time : {};
    const ts = iso(num(time.start) ?? num(time.created) ?? msg?.created ?? part.created);
    switch (data.type) {
      case "text": {
        const text = str(data.text)?.trim();
        if (!msg || msg.role === "other" || !text || data.synthetic === true || data.ignored === true) {
          this.drop(id);
          return [];
        }
        return this.set(id, key, { kind: msg.role, id, ts, text });
      }
      case "tool": {
        const tool = str(data.tool) ?? "tool";
        const state = isObject(data.state) ? data.state : {};
        const stateTime = isObject(state.time) ? state.time : {};
        const at = num(stateTime.start) ? iso(stateTime.start) : ts;
        return this.set(id, key, toolEntry(id, at, tool, state, msg?.cwd));
      }
      case "compaction":
        return this.set(id, key, { kind: "notice", id, ts, text: "Conversation compacted", status: "ok" });
      default:
        return [];
    }
  }

  // ── v2 ──

  private sessionMessage(row: Json): ChatEntry[] {
    const id = str(row.id);
    const data = isObject(row.data) ? row.data : null;
    if (!id || !data) return [];
    const type = str(row.type) ?? str(data.type);
    const seq = String(num(row.seq) ?? 0).padStart(12, "0");
    const key = `s:${seq}`;
    const time = isObject(data.time) ? data.time : {};
    const ts = iso(num(time.created) ?? row.time_created);
    switch (type) {
      case "user": {
        this.sayTurn(key, "working");
        const text = str(data.text)?.trim();
        return text ? this.set(id, key, { kind: "user", id, ts, text }) : [];
      }
      case "assistant": {
        this.sayContext(key, data.tokens);
        this.sayTurn(key, "working");
        const content = Array.isArray(data.content) ? data.content : [];
        const out: ChatEntry[] = [];
        content.forEach((block, i) => {
          if (!isObject(block)) return;
          const blockKey = `${key}:${String(i).padStart(6, "0")}`;
          if (block.type === "text") {
            const text = str(block.text)?.trim();
            const blockId = `${id}:${i}`;
            if (text) out.push(...this.set(blockId, blockKey, { kind: "assistant", id: blockId, ts, text }));
          } else if (block.type === "tool") {
            const blockId = str(block.id) ?? `${id}:${i}`;
            const state = isObject(block.state) ? { ...block.state } : {};
            // v2 says what failed in an error object.
            if (isObject(state.error)) state.error = str(state.error.message) ?? str(state.error.name);
            out.push(...this.set(blockId, blockKey, toolEntry(blockId, ts, str(block.name) ?? "tool", state, undefined)));
          }
        });
        return out;
      }
      case "shell": {
        const command = str(data.command) ?? "";
        const output = isObject(data.output) ? str(data.output.text) : str(data.output);
        return this.set(id, key, {
          kind: "command",
          id,
          ts,
          name: command,
          args: "",
          shell: true,
          ...(output ? { output: output.slice(0, MAX_DETAIL) } : {}),
        });
      }
      case "compaction":
        if (data.status === "completed") {
          return this.set(id, key, { kind: "notice", id, ts, text: "Conversation compacted", status: "ok" });
        }
        if (data.status === "failed") {
          return this.set(id, key, { kind: "notice", id, ts, text: "Compaction failed", status: "error" });
        }
        return [];
      case "idle":
        this.sayTurn(key, data.outcome === "interrupted" ? "interrupted" : "done");
        return [];
      default:
        return [];
    }
  }
}

export const opencodeAdapter: TranscriptAdapter = {
  createParser: () => new OpencodeParser(),
  /** A task's own session, in the same database: `<db>#<child session id>`. */
  childTranscriptPath: (parentPath, task) => {
    const parent = parseOpencodeLocator(parentPath);
    if (!parent || task.taskKind !== "agent" || !task.taskRef || !SESSION_ID.test(task.taskRef)) return null;
    return opencodeLocator(parent.db, task.taskRef);
  },
  // The text as one bracketed paste, so its newlines stay newlines in
  // opencode's composer rather than submitting it line by line; then Enter
  // as its own write, which submits. (A long paste shows in the composer as
  // "[Pasted ~N lines]"; opencode still sends all of it.)
  promptWrites: (text) => [`${BRACKETED_PASTE_START}${encodeChatMessage(text)}${BRACKETED_PASTE_END}`, CHAT_SUBMIT],
};
