/**
 * pi's session file (`~/.pi/agent/sessions/--<cwd>--/<ts>_<id>.jsonl`,
 * format version 3), read as chat entries. The pi extension Manor installs
 * (`agent-connectors.ts`) sends its path with every hook, and pi creates it
 * only once the session has a message: until then it reads as empty.
 *
 * The format is pi's own, so this is defensive in the same way as Claude's
 * parser (`transcript.ts`): a line or block it doesn't know is skipped.
 *
 * A session is a tree: each entry names its parent, and `/tree` can continue
 * from an earlier entry. This reads the file in the order it was written, so
 * after a branch the abandoned path stays above the new one, with a notice
 * where the new one starts; the chat does not rebuild the active branch.
 *
 * Thinking blocks, system messages and extension messages are not shown.
 */

import { CHAT_SUBMIT } from "../chat-keys";
import { encodeChatMessage } from "../picker-keys";
import {
  landedEdit,
  MAX_DETAIL,
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

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * pi's built-in tools under the names Claude Code gives the same tools, so
 * the chat groups and words them alike ("Ran 2 commands"). Any other tool
 * (an extension's) keeps its own name.
 */
const TOOL_NAMES: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "LS",
};

/** The stop reasons that end pi's turn; `toolUse` goes on to the results. */
const TURN_ENDS = new Set(["stop", "length", "error"]);

/** A skill invoked with `/skill:<name>`: pi sends its body as the user message. */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/** A skipped tool result names its call; quotes inside its content are escaped. */
const OVERSIZED_CALL_ID = /"toolCallId"\s*:\s*"([^"\\]+)"/;
const TOO_LARGE = "Output too large to show";

function firstLine(s: string): string {
  return s.split("\n", 1)[0].trim();
}

function summarizeTool(name: string, args: Json): string {
  switch (name) {
    case "bash":
      return firstLine(str(args.command) ?? "") || name;
    case "read":
    case "edit":
    case "write":
      return str(args.path) || name;
    case "ls":
      return str(args.path) || ".";
    case "grep":
    case "find":
      return str(args.pattern) || name;
    default:
      return name;
  }
}

/** The text blocks of a message's `content` (a string, or blocks), joined. */
function textOf(content: unknown, sep = "\n"): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (isObject(b) && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join(sep);
}

/**
 * The hunks of a unified patch, as pi's edit tool writes it in
 * `details.patch` (jsdiff's `createTwoFilesPatch`). Each hunk is read for as
 * many lines as its header counts, so a removed line that itself starts with
 * "--" is not taken for a file header.
 */
export function parseUnifiedPatch(patch: string): ChatDiffHunk[] {
  const lines = patch.split("\n");
  const hunks: ChatDiffHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
    i++;
    if (!m) continue;
    const oldLines = m[2] === undefined ? 1 : Number(m[2]);
    const newLines = m[4] === undefined ? 1 : Number(m[4]);
    let oldLeft = oldLines;
    let newLeft = newLines;
    const body: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith("\\")) {
        body.push(l);
      } else if (oldLeft <= 0 && newLeft <= 0) {
        break;
      } else if (l.startsWith("+")) {
        newLeft--;
        body.push(l);
      } else if (l.startsWith("-")) {
        oldLeft--;
        body.push(l);
      } else if (l.startsWith(" ")) {
        oldLeft--;
        newLeft--;
        body.push(l);
      } else {
        break;
      }
      i++;
    }
    if (body.length > 0) {
      hunks.push({ oldStart: Number(m[1]), oldLines, newStart: Number(m[3]), newLines, lines: body });
    }
  }
  return hunks;
}

/** A file `write` put down: every line added. pi says nothing of what it replaced. */
function writtenHunks(content: string): ChatDiffHunk[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return [];
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
}

class PiTranscriptParser implements TranscriptLineParser {
  private order: string[] = [];
  private byId = new Map<string, ChatEntry>();
  /** Each tool call's pi name and arguments, for its result to read. */
  private calls = new Map<string, { name: string; args: Json }>();
  private cwd: string | undefined;
  /** The entry written last: the next one's parent unless the session branched. */
  private lastEntryId: string | null = null;
  private lastContextTokens: number | null = null;
  private turn: ChatTurnState | null = null;

  push(line: string, offset?: number): ChatEntry[] {
    try {
      return this.pushInner(line, offset);
    } catch {
      return [];
    }
  }

  /** A tool result too long to read settles its call as an error, so it doesn't spin. */
  oversized(record: OversizedRecord): ChatEntry[] {
    const id = OVERSIZED_CALL_ID.exec(record.head)?.[1] ?? OVERSIZED_CALL_ID.exec(record.tail)?.[1];
    const existing = id ? this.byId.get(id) : undefined;
    if (!id || existing?.kind !== "tool" || existing.status !== "pending") return [];
    const next: ChatEntry = { ...existing, status: "error", detail: TOO_LARGE };
    this.byId.set(id, next);
    return [next];
  }

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

  /** The newest assistant message's context: input plus cache read and written. */
  contextTokens(): number | null {
    return this.lastContextTokens;
  }

  turnState(): ChatTurnState | null {
    return this.turn;
  }

  // pi's skills are not listed in its session file.
  skills(): ChatSkill[] {
    return [];
  }

  hasSkillListing(): boolean {
    return false;
  }

  private add(entry: ChatEntry, out: ChatEntry[]): void {
    if (this.byId.has(entry.id)) return;
    this.byId.set(entry.id, entry);
    this.order.push(entry.id);
    out.push(entry);
  }

  private pushInner(line: string, offset?: number): ChatEntry[] {
    if (!line || !line.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(parsed)) return [];
    const type = parsed.type;
    if (type === "session") {
      this.cwd = str(parsed.cwd);
      return [];
    }
    const ts = str(parsed.timestamp) ?? "";
    const id = str(parsed.id) ?? (offset !== undefined ? `@${offset}` : `line-${this.order.length}`);
    const out: ChatEntry[] = [];

    // Continuing from anything but the entry before it is a branch (`/tree`).
    // A branch summary is its own notice.
    const parentId = parsed.parentId === null ? null : str(parsed.parentId);
    if (parentId !== undefined && this.lastEntryId !== null && parentId !== this.lastEntryId) {
      if (type !== "branch_summary") {
        this.add({ kind: "notice", id: `${id}:branch`, ts, text: "Branched from an earlier message", status: "ok" }, out);
      }
    }
    if (str(parsed.id)) this.lastEntryId = str(parsed.id)!;

    if (type === "compaction") {
      this.add({ kind: "notice", id, ts, text: "Conversation compacted", status: "ok" }, out);
      return out;
    }
    if (type === "branch_summary") {
      this.add({ kind: "notice", id, ts, text: "Branched from an earlier message", status: "ok" }, out);
      return out;
    }
    if (type !== "message" || !isObject(parsed.message)) return out;
    const message = parsed.message;
    switch (message.role) {
      case "user":
        this.user(id, ts, message, out);
        break;
      case "assistant":
        this.assistant(id, ts, message, out);
        break;
      case "toolResult":
        this.toolResult(message, out);
        break;
      case "bashExecution":
        this.bash(id, ts, message, out);
        break;
      // system, custom and anything newer: not shown
    }
    return out;
  }

  private user(id: string, ts: string, message: Json, out: ChatEntry[]): void {
    // An attached image leaves its text; a message of images alone shows nothing.
    const text = textOf(message.content);
    if (!text.trim()) return;
    this.turn = "working";
    const skill = SKILL_BLOCK.exec(text);
    if (skill) {
      this.add({ kind: "command", id, ts, name: `skill:${skill[1]}`, args: (skill[2] ?? "").trim() }, out);
      return;
    }
    this.add({ kind: "user", id, ts, text }, out);
  }

  private assistant(id: string, ts: string, message: Json, out: ChatEntry[]): void {
    const usage = message.usage;
    if (isObject(usage)) {
      // An aborted or failed message can carry zeroed usage: no context to tell.
      const size = count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite);
      if (size > 0) this.lastContextTokens = size;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((block, i) => {
      if (!isObject(block)) return;
      if (block.type === "text") {
        const text = str(block.text);
        if (text && text.trim()) this.add({ kind: "assistant", id: `${id}:${i}`, ts, text }, out);
      } else if (block.type === "toolCall") {
        const callId = str(block.id);
        const name = str(block.name);
        if (!callId || !name) return;
        const args = isObject(block.arguments) ? block.arguments : {};
        this.calls.set(callId, { name, args });
        this.add(
          { kind: "tool", id: callId, ts, name: TOOL_NAMES[name] ?? name, summary: summarizeTool(name, args), status: "pending" },
          out,
        );
      }
      // thinking and unknown blocks: dropped
    });
    const stop = str(message.stopReason);
    if (stop === "aborted") {
      this.turn = "interrupted";
      this.add({ kind: "notice", id: `${id}:stop`, ts, text: "Interrupted", status: "error" }, out);
    } else if (stop !== undefined && TURN_ENDS.has(stop)) {
      this.turn = "done";
      const error = stop === "error" ? firstLine(str(message.errorMessage) ?? "") : "";
      if (error) {
        this.add({ kind: "notice", id: `${id}:stop`, ts, text: error.slice(0, MAX_DETAIL), status: "error" }, out);
      }
    } else {
      this.turn = "working";
    }
  }

  private toolResult(message: Json, out: ChatEntry[]): void {
    this.turn = "working";
    const callId = str(message.toolCallId);
    const existing = callId ? this.byId.get(callId) : undefined;
    if (!callId || existing?.kind !== "tool") return;
    const isError = message.isError === true;
    const call = this.calls.get(callId);
    const edit = !isError && existing.status === "pending" && call ? this.edit(existing, call, message.details) : null;
    const text = textOf(message.content).trim();
    const next: ChatEntry = edit ?? {
      ...existing,
      status: isError ? "error" : "ok",
      detail: text ? text.slice(0, MAX_DETAIL) : undefined,
    };
    this.byId.set(callId, next);
    out.push(next);
  }

  /** A landed `edit` or `write` as its diff, or null to leave it a tool row. */
  private edit(tool: ToolEntry, call: { name: string; args: Json }, details: unknown): ChatEntry | null {
    const path = str(call.args.path);
    if (call.name === "edit") {
      const patch = isObject(details) ? str(details.patch) : undefined;
      return patch ? landedEdit(tool, parseUnifiedPatch(patch), path, this.cwd) : null;
    }
    if (call.name === "write") {
      return landedEdit(tool, writtenHunks(str(call.args.content) ?? ""), path, this.cwd);
    }
    return null;
  }

  /** A `!` (or `!!`) command the user ran from pi's prompt, with what it printed. */
  private bash(id: string, ts: string, message: Json, out: ChatEntry[]): void {
    const command = str(message.command)?.trim();
    if (!command) return;
    // Leading spaces can mean something (`git status --short`); blank lines don't.
    const printed = (str(message.output) ?? "").replace(/^\n+/, "").trimEnd();
    const status = message.cancelled === true ? "(cancelled)" : "";
    const output = [printed, status].filter(Boolean).join("\n");
    this.add(
      {
        kind: "command",
        id,
        ts,
        name: command,
        args: "",
        shell: true,
        ...(output ? { output: output.slice(0, MAX_DETAIL) } : {}),
      },
      out,
    );
  }
}

export const piAdapter: TranscriptAdapter = {
  createParser: () => new PiTranscriptParser(),
  // pi has no delegated tasks with transcripts of their own.
  childTranscriptPath: () => null,
  /**
   * The text as one bracketed paste, then Enter on its own. pi's editor
   * (`pi-tui` `Editor`) takes a paste whole: its new lines stay new lines
   * rather than submitting, and a long one becomes a `[paste #1 …]` marker
   * that is expanded again on submit. The text is cleaned first so it
   * can't end the paste early (no Esc) or carry a CR.
   */
  promptWrites: (text) => [`\x1b[200~${encodeChatMessage(text)}\x1b[201~`, CHAT_SUBMIT],
};
