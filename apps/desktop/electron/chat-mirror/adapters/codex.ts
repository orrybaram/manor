/**
 * Codex CLI's rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`),
 * read as a chat. Each line is `{timestamp, type, payload}`:
 *
 * - `session_meta` and `turn_context` give the working directory (and
 *   `session_meta.history_mode`, legacy or paginated);
 * - `response_item`s are what the model saw and said: messages, tool calls
 *   (`function_call`, `custom_tool_call`, `local_shell_call`,
 *   `web_search_call`) and their outputs by `call_id`;
 * - `event_msg`s are what the TUI showed: the prompt as typed
 *   (`user_message`), `token_count`, turn starts and ends, applied patches
 *   (`patch_apply_end`) and compaction.
 *
 * Both streams tell the conversation, so each part is read from one only:
 * the prompt from `user_message` (a user `response_item` also carries the
 * AGENTS.md and environment context Codex injects), the reply from the
 * assistant `response_item` (`agent_message` repeats it). A paginated
 * rollout writes neither event; its `item_completed` items carry the
 * messages instead, and its file changes.
 *
 * The format is private to Codex and still moving, so every field is read
 * defensively: what isn't understood is skipped, never thrown.
 * Reasoning is skipped, as Claude's thinking is.
 */

import { isCodexInjected } from "../../sessions/codex-reader";
import { CHAT_SUBMIT } from "../chat-keys";
import { encodeChatMessage } from "../picker-keys";
import {
  cappedEdit,
  MAX_DETAIL,
  relativeTo,
  type ChatDiffHunk,
  type ChatEntry,
  type ChatSkill,
  type ChatTurnState,
} from "../transcript";
import type { OversizedRecord, TranscriptAdapter, TranscriptLineParser } from "./types";

type Json = Record<string, unknown>;
type ToolEntry = Extract<ChatEntry, { kind: "tool" }>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function firstLine(s: string): string {
  return s.trim().split("\n", 1)[0].trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The text blocks of a message's `content`, joined: `input_text` and
 * `output_text` in a response item, `text` (a user's) and `Text` (an
 * agent's) in a turn item.
 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isObject)
    .filter((b) => ["input_text", "output_text", "text"].includes((str(b.type) ?? "").toLowerCase()))
    .map((b) => str(b.text) ?? "")
    .filter(Boolean)
    .join("\n");
}

/** The shell tools Codex has shipped, all shown as one: "shell". */
const SHELL_TOOLS = new Set(["shell", "container.exec", "shell_command", "exec_command", "local_shell"]);
const SHELL = "shell";
const APPLY_PATCH = "apply_patch";

/**
 * A shell call's command line. `command` is an argv (`["bash", "-lc", "…"]`,
 * the script being what matters) or a string; `exec_command` names it `cmd`.
 */
function commandLine(args: Json): string | undefined {
  const cmd = args.command ?? args.cmd;
  if (typeof cmd === "string") return cmd;
  if (!Array.isArray(cmd) || !cmd.every((a) => typeof a === "string")) return undefined;
  const argv = cmd as string[];
  if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1])) return argv[2];
  return argv.join(" ");
}

/** `apply_patch`'s files, from its patch text. */
function patchFiles(patch: string): string | undefined {
  const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  return files.length > 0 ? files.join(", ") : undefined;
}

/** A tool call's name as the chat shows it, and its one-line summary. */
function describeCall(rawName: string, args: Json, input?: string): { name: string; summary: string } {
  if (SHELL_TOOLS.has(rawName)) {
    const line = commandLine(args);
    return { name: SHELL, summary: line ? firstLine(line) : SHELL };
  }
  if (rawName === APPLY_PATCH) {
    // As a function call the patch is its `input` argument; as a custom tool call, the input itself.
    const patch = input ?? str(args.input) ?? "";
    return { name: APPLY_PATCH, summary: patchFiles(patch) ?? APPLY_PATCH };
  }
  const named = str(args.path) ?? str(args.explanation) ?? str(args.query) ?? input;
  return { name: rawName, summary: named?.trim() ? firstLine(named) : rawName };
}

/**
 * A tool's output as text, and whether it says it failed. Codex has written
 * it as a JSON string `{output, metadata: {exit_code}}`, as plain text with
 * an `Exit code: N` (or `Process exited with code N`) header, as content
 * items, and as `{content, success}`.
 */
function toolOutput(output: unknown): { text: string; failed: boolean } {
  if (Array.isArray(output)) return { text: contentText(output), failed: false };
  if (isObject(output)) {
    const inner = toolOutput(output.content ?? output.output ?? "");
    return { text: inner.text, failed: inner.failed || output.success === false };
  }
  const raw = str(output) ?? "";
  const parsed = parseJson(raw);
  if (isObject(parsed) && typeof parsed.output === "string") {
    const exit = isObject(parsed.metadata) ? count(parsed.metadata.exit_code) : undefined;
    return { text: parsed.output, failed: exit !== undefined && exit !== 0 };
  }
  const exit = /^(?:Exit code:|Process exited with code) (\d+)/m.exec(raw);
  const body = /^Output:\n([\s\S]*)$/m.exec(raw);
  return {
    text: exit && body ? body[1] : raw,
    failed: exit !== null && exit[1] !== "0",
  };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The hunks of a unified diff, as `patch_apply_end` writes an update.
 * File headers (`---`/`+++`) before a hunk are skipped; each hunk runs for
 * the lines its header counts, so a removed `--- x` line inside one is kept.
 */
export function parseUnifiedDiff(diff: string): ChatDiffHunk[] {
  const out: ChatDiffHunk[] = [];
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = HUNK_HEADER.exec(lines[i]);
    i++;
    if (!m) continue;
    const hunk: ChatDiffHunk = {
      oldStart: Number(m[1]),
      oldLines: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newLines: m[4] === undefined ? 1 : Number(m[4]),
      lines: [],
    };
    let oldLeft = hunk.oldLines;
    let newLeft = hunk.newLines;
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith("\\"))) {
      const l = lines[i];
      if (l.startsWith("+")) newLeft--;
      else if (l.startsWith("-")) oldLeft--;
      else if (l.startsWith(" ") || l === "") {
        oldLeft--;
        newLeft--;
      } else if (!l.startsWith("\\")) break;
      // A context line whose trailing space was stripped still reads as one.
      hunk.lines.push(l === "" ? " " : l);
      i++;
    }
    if (hunk.lines.length > 0) out.push(hunk);
  }
  return out;
}

/** A whole file's lines, all added (`+`) or all removed (`-`), as one hunk. */
function wholeFile(content: string, sign: "+" | "-"): ChatDiffHunk[] {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return [];
  const n = lines.length;
  return [
    sign === "+"
      ? { oldStart: 0, oldLines: 0, newStart: 1, newLines: n, lines: lines.map((l) => `+${l}`) }
      : { oldStart: 1, oldLines: n, newStart: 0, newLines: 0, lines: lines.map((l) => `-${l}`) },
  ];
}

/** One file's `FileChange` (`{type: add|delete|update, …}`) as hunks, and the path it ends at. */
function changeHunks(path: string, change: Json): { path: string; hunks: ChatDiffHunk[] } {
  switch (change.type) {
    case "add":
      return { path, hunks: wholeFile(str(change.content) ?? "", "+") };
    case "delete":
      return { path, hunks: wholeFile(str(change.content) ?? "", "-") };
    case "update":
      return { path: str(change.move_path) || path, hunks: parseUnifiedDiff(str(change.unified_diff) ?? "") };
    default:
      return { path, hunks: [] };
  }
}

/**
 * A skipped output line names its call near its start (`call_id` comes
 * before `output`). Quotes inside the output are escaped, so its text can't match.
 */
const OVERSIZED_CALL_ID = /"type"\s*:\s*"(?:function|custom_tool)_call_output"\s*,\s*"call_id"\s*:\s*"([^"]+)"/;
const TOO_LARGE = "Output too large to show";

export class CodexRolloutParser implements TranscriptLineParser {
  private order: string[] = [];
  private byId = new Map<string, ChatEntry>();
  private cwd: string | undefined;
  /** A paginated rollout's messages are `item_completed` items, not events. */
  private paginated = false;
  private lastContextTokens: number | null = null;
  private turn: ChatTurnState | null = null;
  /**
   * A compaction was just shown. Codex can write it twice (the `compacted`
   * record and its `context_compacted` event); the second adds nothing.
   */
  private justCompacted = false;

  entries(): ChatEntry[] {
    const out: ChatEntry[] = [];
    for (const id of this.order) {
      const e = this.byId.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  entry(id: string): ChatEntry | undefined {
    return this.byId.get(id);
  }

  /** The context size from the newest `token_count`, or null before one. */
  contextTokens(): number | null {
    return this.lastContextTokens;
  }

  turnState(): ChatTurnState | null {
    return this.turn;
  }

  /** Codex lists no skills in its rollout; its chat offers no `/` menu. */
  skills(): ChatSkill[] {
    return [];
  }

  hasSkillListing(): boolean {
    return false;
  }

  push(line: string, offset?: number): ChatEntry[] {
    try {
      return this.pushInner(line, offset);
    } catch {
      return [];
    }
  }

  /** A tool output too long to read settles its call, so it doesn't spin forever. */
  oversized(record: OversizedRecord): ChatEntry[] {
    const id = OVERSIZED_CALL_ID.exec(record.head)?.[1];
    const existing = id ? this.byId.get(id) : undefined;
    if (existing?.kind !== "tool" || existing.status !== "pending") return [];
    const next: ChatEntry = { ...existing, status: "error", detail: TOO_LARGE };
    this.byId.set(existing.id, next);
    return [next];
  }

  private add(entry: ChatEntry): ChatEntry[] {
    if (this.byId.has(entry.id)) return [];
    this.justCompacted = false;
    this.byId.set(entry.id, entry);
    this.order.push(entry.id);
    return [entry];
  }

  /** Replace an entry in place; consumers compare by identity. */
  private replace(entry: ChatEntry): ChatEntry[] {
    this.byId.set(entry.id, entry);
    return [entry];
  }

  private pushInner(line: string, offset?: number): ChatEntry[] {
    if (!line.trim()) return [];
    const record = parseJson(line);
    if (!isObject(record) || !isObject(record.payload)) return [];
    const payload = record.payload;
    const ts = str(record.timestamp) ?? "";
    const lineId = offset !== undefined ? `@${offset}` : `line-${this.order.length}`;
    switch (record.type) {
      case "session_meta":
        this.cwd = str(payload.cwd) ?? this.cwd;
        this.paginated = payload.history_mode === "paginated";
        return [];
      case "turn_context":
        this.cwd = str(payload.cwd) ?? this.cwd;
        return [];
      case "compacted":
        return this.compaction(lineId, ts);
      case "response_item":
        return this.responseItem(payload, lineId, ts);
      case "event_msg":
        return this.event(payload, lineId, ts);
      default:
        return [];
    }
  }

  private responseItem(item: Json, lineId: string, ts: string): ChatEntry[] {
    switch (item.type) {
      case "message": {
        // The prompt is read from its event; a user item also carries injected context.
        if (item.role !== "assistant" || this.paginated) return [];
        const text = contentText(item.content);
        if (!text.trim()) return [];
        return this.add({ kind: "assistant", id: lineId, ts, text });
      }
      case "function_call": {
        const callId = str(item.call_id);
        const name = str(item.name);
        if (!callId || !name) return [];
        const args = parseJson(str(item.arguments) ?? "");
        return this.call(callId, ts, describeCall(name, isObject(args) ? args : {}));
      }
      case "custom_tool_call": {
        const callId = str(item.call_id);
        const name = str(item.name);
        if (!callId || !name) return [];
        return this.call(callId, ts, describeCall(name, {}, str(item.input) ?? ""));
      }
      case "local_shell_call": {
        const callId = str(item.call_id) ?? str(item.id);
        if (!callId) return [];
        const action = isObject(item.action) ? item.action : {};
        return this.call(callId, ts, describeCall("local_shell", action));
      }
      case "web_search_call": {
        // Hosted by the API: it has no output of its own to wait for.
        const action = isObject(item.action) ? item.action : {};
        const query = str(action.query);
        this.setTurn("working");
        return this.add({
          kind: "tool",
          id: str(item.id) ?? lineId,
          ts,
          name: "web_search",
          summary: query ? firstLine(query) : "web_search",
          status: "ok",
        });
      }
      case "function_call_output":
      case "custom_tool_call_output":
        return this.output(str(item.call_id), item.output);
      default:
        // reasoning and anything newer: not shown
        return [];
    }
  }

  private call(id: string, ts: string, call: { name: string; summary: string }): ChatEntry[] {
    this.setTurn("working");
    return this.add({ kind: "tool", id, ts, name: call.name, summary: call.summary, status: "pending" });
  }

  /** Settle a pending call with its output. An edit already landed stays as it is. */
  private output(callId: string | undefined, raw: unknown): ChatEntry[] {
    const existing = callId ? this.byId.get(callId) : undefined;
    if (existing?.kind !== "tool" || existing.status !== "pending") return [];
    this.setTurn("working");
    const { text, failed } = toolOutput(raw);
    const detail = text.trim() ? text.slice(0, MAX_DETAIL) : undefined;
    return this.replace({ ...existing, status: failed ? "error" : "ok", detail });
  }

  private event(ev: Json, lineId: string, ts: string): ChatEntry[] {
    switch (ev.type) {
      case "user_message":
        return this.userText(lineId, ts, str(ev.message) ?? "");
      case "task_started":
      case "turn_started":
        this.setTurn("working");
        return [];
      case "task_complete":
      case "turn_complete":
        this.setTurn("done");
        return [];
      case "turn_aborted":
        this.setTurn("interrupted");
        return [
          ...this.settleStopped(),
          ...this.add({ kind: "notice", id: lineId, ts, text: "Interrupted", status: "error" }),
        ];
      case "token_count": {
        const usage = isObject(ev.info) ? ev.info.last_token_usage : undefined;
        if (!isObject(usage)) return [];
        // What the last request held, as Codex counts its context window.
        const total = count(usage.total_tokens);
        const size = total ?? (count(usage.input_tokens) ?? 0) + (count(usage.output_tokens) ?? 0);
        if (size > 0) this.lastContextTokens = size;
        return [];
      }
      case "patch_apply_end":
        return this.patchApplied(str(ev.call_id), ev.success === true, ev.changes, str(ev.stderr));
      case "context_compacted":
        return this.compaction(lineId, ts);
      case "item_completed":
        return isObject(ev.item) ? this.completedItem(ev.item, lineId, ts) : [];
      default:
        // agent_message repeats the assistant item; reasoning is not shown.
        return [];
    }
  }

  /** A paginated rollout's turn item. */
  private completedItem(item: Json, lineId: string, ts: string): ChatEntry[] {
    switch (item.type) {
      case "UserMessage":
        return this.paginated ? this.userText(str(item.id) ?? lineId, ts, contentText(item.content)) : [];
      case "AgentMessage": {
        if (!this.paginated) return [];
        const text = contentText(item.content);
        return text.trim() ? this.add({ kind: "assistant", id: str(item.id) ?? lineId, ts, text }) : [];
      }
      case "FileChange":
        return this.patchApplied(
          str(item.id),
          item.status === undefined || item.status === "completed",
          item.changes,
          str(item.stderr),
        );
      case "ContextCompaction":
        return this.compaction(str(item.id) ?? lineId, ts);
      default:
        return [];
    }
  }

  /** A stopped turn's calls never get an output: they failed, not still running. */
  private settleStopped(): ChatEntry[] {
    const out: ChatEntry[] = [];
    for (const e of this.byId.values()) {
      if (e.kind === "tool" && e.status === "pending") out.push(...this.replace({ ...e, status: "error" }));
    }
    return out;
  }

  private userText(id: string, ts: string, text: string): ChatEntry[] {
    if (!text.trim() || isCodexInjected(text)) return [];
    this.setTurn("working");
    return this.add({ kind: "user", id, ts, text });
  }

  /**
   * A patch landed: its call becomes an edit card per file, the first in
   * the call's place, the rest (`<call_id>#<n>`) right after it. A patch
   * that failed or was declined settles its call as an error instead.
   */
  private patchApplied(
    callId: string | undefined,
    success: boolean,
    changes: unknown,
    stderr: string | undefined,
  ): ChatEntry[] {
    if (!callId) return [];
    const existing = this.byId.get(callId);
    if (existing?.kind !== "tool") return [];
    this.setTurn("working");
    if (!success) {
      const detail = stderr?.trim() ? stderr.slice(0, MAX_DETAIL) : existing.detail;
      return this.replace({ ...existing, status: "error", detail });
    }
    const out: ChatEntry[] = [];
    const files = isObject(changes) ? Object.entries(changes) : [];
    let n = 0;
    for (const [path, change] of files) {
      if (!isObject(change)) continue;
      const file = changeHunks(path, change);
      const id = n === 0 ? callId : `${callId}#${n}`;
      const edit = cappedEdit(
        { id, ts: existing.ts, name: existing.name, path: relativeTo(file.path, this.cwd) },
        file.hunks,
      );
      if (!edit) continue;
      out.push(...(n === 0 ? this.replace(edit) : this.add(edit)));
      n++;
    }
    // Nothing to draw (an empty patch): the call still landed.
    if (n === 0) return this.replace({ ...existing, status: "ok" } satisfies ToolEntry);
    return out;
  }

  private compaction(id: string, ts: string): ChatEntry[] {
    if (this.justCompacted) return [];
    const out = this.add({ kind: "notice", id, ts, text: "Conversation compacted", status: "ok" });
    this.justCompacted = out.length > 0;
    return out;
  }

  private setTurn(state: ChatTurnState): void {
    this.turn = state;
  }
}

/** Bracketed paste: what a terminal wraps pasted text in. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export const codexAdapter: TranscriptAdapter = {
  createParser: () => new CodexRolloutParser(),
  // Codex writes sub-agent rollouts (the Stop hook's `agent_transcript_path`),
  // but its tool calls don't name them yet: no task drill-in.
  childTranscriptPath: () => null,
  /**
   * The text as one bracketed paste, then Enter on its own. Codex's composer
   * takes a paste whole, newlines and all, and clears its paste-burst
   * window after one, so the Enter submits. Typed as plain keys instead,
   * text arriving in one burst is held as a paste by that heuristic, and an
   * Enter within its 120ms window becomes a newline, not a submit.
   * `encodeChatMessage` drops Esc and other control bytes, so the text
   * can't close the paste early.
   */
  promptWrites: (text) => [`${PASTE_START}${encodeChatMessage(text)}${PASTE_END}`, CHAT_SUBMIT],
};
