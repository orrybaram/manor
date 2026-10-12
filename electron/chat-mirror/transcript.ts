/**
 * Pure parser for Claude Code's JSONL transcript (ADR-215 D3).
 *
 * The transcript format is private to Claude Code, so everything here is
 * defensive: malformed lines, unknown line types and unknown block types are
 * skipped silently. A format change must make the chat lossy, not broken.
 */

import type { PickerQuestion } from "./picker-keys";

export type ChatEntry =
  | { kind: "user"; id: string; ts: string; text: string }
  | { kind: "assistant"; id: string; ts: string; text: string }
  | {
      kind: "tool";
      id: string;
      ts: string;
      name: string;
      summary: string;
      status: "pending" | "ok" | "error";
      detail?: string;
    }
  | {
      kind: "question";
      id: string;
      ts: string;
      questions: PickerQuestion[];
      answer: string | null;
      /**
       * Set by the mirror (`mirror.ts`), never by the parser: the chat sent an
       * answer and no `tool_result` followed in time (ADR-215 D5).
       */
      needsTerminal?: boolean;
    }
  | {
      kind: "plan";
      id: string;
      ts: string;
      plan: string;
      outcome: string | null;
      /** As on `question`. */
      needsTerminal?: boolean;
    }
  | {
      kind: "command";
      id: string;
      ts: string;
      /** Slash command name, without the leading `/`. */
      name: string;
      args: string;
      /** The command's local stdout, attached when it follows the command. */
      output?: string;
    }
  | {
      /** Delegated or background work: an agent, or a shell command (ADR-224 D2). */
      kind: "task";
      /** The launching tool_use id. */
      id: string;
      ts: string;
      taskKind: "agent" | "shell" | "other";
      /** One line: the description, else the command's first line. */
      title: string;
      /** e.g. "implementer", "Explore". Agent tasks only. */
      agentType?: string;
      model?: string;
      background: boolean;
      status: "running" | "ok" | "error" | "killed";
      /** The final summary or result text, capped at MAX_DETAIL. */
      result?: string;
      /** The agent's own id for this task, when it has one. */
      taskRef?: string;
      /** True when `childTranscriptPath` can resolve a transcript for it. */
      hasTranscript: boolean;
    }
  | {
      /** A background task finishing, e.g. `Agent "Map mobile state sync" finished`. */
      kind: "notice";
      id: string;
      ts: string;
      text: string;
      status: "ok" | "error";
    };

export type ChatTaskEntry = Extract<ChatEntry, { kind: "task" }>;

/**
 * The session's context size in tokens (ADR-223 D4). Published by the mirror
 * when it changes; never a `ChatEntry`, never drawn.
 */
export type ChatUsage = {
  kind: "usage";
  id: "usage";
  ts: string;
  contextTokens: number;
};

/** What the `chat.entry` channel carries: an entry or a context-size update. */
export type ChatPush = ChatEntry | ChatUsage;

/** A skill from Claude Code's `skill_listing` attachment (ADR-217 D1). */
export type ChatSkill = { name: string; description: string };

const MAX_DETAIL = 4000;
const META_PREFIXES = ["<command-", "<local-command", "<system-reminder>"];

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function tokenCount(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Context size from a message's `usage`: everything the model read, fresh
 * or cached. Output tokens are excluded. Null when none of it is there.
 */
function contextSize(usage: unknown): number | null {
  if (!isObject(usage)) return null;
  const parts = [
    tokenCount(usage.input_tokens),
    tokenCount(usage.cache_creation_input_tokens),
    tokenCount(usage.cache_read_input_tokens),
  ];
  if (parts.every((p) => p === undefined)) return null;
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);
}

/** Claude Code writes `run_in_background` as the string "true" as often as a boolean. */
function isTrue(v: unknown): boolean {
  return v === true || v === "true";
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0].trim();
}

function isMetaText(text: string): boolean {
  const t = text.trimStart();
  return META_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Parse `- <name>: <description>` lines. Names may carry a plugin prefix
 * (`anthropic-skills:pdf`), so split on the first ": ", not the first ":".
 */
export function parseSkillLines(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of content.split("\n")) {
    const l = raw.trim();
    if (!l.startsWith("- ")) continue;
    const rest = l.slice(2);
    const i = rest.indexOf(": ");
    const name = (i === -1 ? rest : rest.slice(0, i)).trim();
    if (!name) continue;
    out.set(name, i === -1 ? "" : rest.slice(i + 2).trim());
  }
  return out;
}

function tagText(text: string, tag: string): string | undefined {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : undefined;
}

function summarizeTool(name: string, input: Json): string {
  switch (name) {
    case "Bash": {
      const desc = str(input.description)?.trim();
      if (desc) return desc;
      const cmd = str(input.command);
      if (cmd && cmd.trim()) return firstLine(cmd);
      return name;
    }
    case "Read":
    case "Edit":
    case "Write":
      return str(input.file_path) || name;
    case "Grep":
    case "Glob":
      return str(input.pattern) || name;
    default:
      return name;
  }
}

function parseQuestions(input: Json): PickerQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  const out: PickerQuestion[] = [];
  for (const q of raw) {
    if (!isObject(q)) continue;
    const options = Array.isArray(q.options)
      ? q.options.filter(isObject).map((o) => ({
          label: str(o.label) ?? "",
          description: str(o.description) ?? "",
        }))
      : [];
    out.push({
      question: str(q.question) ?? "",
      header: str(q.header) ?? "",
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return out;
}

/** Flatten a tool_result `content` (string or block array) to plain text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (isObject(b) && b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/** How a `TranscriptParser` reads. */
export interface TranscriptParserOptions {
  /**
   * Keep `isSidechain` lines. A subagent's own transcript is all sidechain
   * (ADR-224 D3); in the pane's transcript such lines are dropped.
   */
  sidechain?: boolean;
}

export class TranscriptParser {
  private readonly sidechain: boolean;
  private order: string[] = [];
  private byId = new Map<string, ChatEntry>();
  private skillMap = new Map<string, string>();
  private sawSkillListing = false;
  private lastCommandId: string | null = null;
  private lastContextTokens: number | null = null;
  /** Notifications already turned into a notice; one may arrive in two forms. */
  private seenNotices = new Set<string>();

  constructor(opts: TranscriptParserOptions = {}) {
    this.sidechain = opts.sidechain === true;
  }

  /**
   * The context size of the newest main-thread assistant line, or null if
   * none carried a usable `usage`. Claude Code writes one line per content
   * block, each with the whole message's usage, so the newest is right.
   */
  contextTokens(): number | null {
    return this.lastContextTokens;
  }

  /** Skills from the transcript's skill listings, sorted by name. */
  skills(): ChatSkill[] {
    return [...this.skillMap.entries()]
      .map(([name, description]) => ({ name, description }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** True once any `skill_listing` attachment has been seen. */
  hasSkillListing(): boolean {
    return this.sawSkillListing;
  }

  /** All entries seen so far, in transcript order. */
  entries(): ChatEntry[] {
    const out: ChatEntry[] = [];
    for (const id of this.order) {
      const e = this.byId.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  /** Feed one JSONL line; returns entries that are new or updated by it. */
  push(line: string): ChatEntry[] {
    try {
      return this.pushInner(line);
    } catch {
      return [];
    }
  }

  private add(entry: ChatEntry): ChatEntry | null {
    if (this.byId.has(entry.id)) return null;
    this.byId.set(entry.id, entry);
    this.order.push(entry.id);
    return entry;
  }

  private pushInner(line: string): ChatEntry[] {
    if (!line || !line.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(parsed)) return [];
    if (parsed.isSidechain === true && !this.sidechain) return [];
    const type = parsed.type;
    if (type === "attachment") {
      const att = parsed.attachment;
      if (
        isObject(att) &&
        att.type === "queued_command" &&
        typeof att.prompt === "string" &&
        (att.commandMode === "task-notification" ||
          att.prompt.trimStart().startsWith("<task-notification>"))
      ) {
        const e = this.notification(
          str(parsed.uuid) ?? `line-${this.order.length}`,
          str(parsed.timestamp) ?? "",
          att.prompt,
        );
        return e ? [e] : [];
      }
      this.skillListing(att);
      return [];
    }
    if (type !== "user" && type !== "assistant") return [];
    const message = parsed.message;
    if (!isObject(message)) return [];

    const ts = str(parsed.timestamp) ?? "";
    const uuid = str(parsed.uuid) ?? `line-${this.order.length}`;
    const content = message.content;
    const out: ChatEntry[] = [];

    if (type === "user") {
      if (parsed.isMeta === true) return [];
      if (typeof content === "string") {
        const e = this.userText(uuid, ts, content);
        if (e) out.push(e);
        return out;
      }
      if (!Array.isArray(content)) return [];
      const texts: string[] = [];
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block.type === "tool_result") {
          const e = this.resolve(block, parsed.toolUseResult);
          if (e) out.push(e);
        } else if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) {
        const e = this.userText(uuid, ts, texts.join("\n"));
        if (e) out.push(e);
      }
      return out;
    }

    // assistant
    // Claude Code's own synthetic lines (an API error, an interrupt) carry
    // zeroed usage that says nothing about the context.
    if (message.model !== "<synthetic>") {
      const size = contextSize(message.usage);
      if (size !== null) this.lastContextTokens = size;
    }
    if (!Array.isArray(content)) return [];
    content.forEach((block, i) => {
      if (!isObject(block)) return;
      if (block.type === "text") {
        const text = str(block.text);
        if (!text || !text.trim()) return;
        const e = this.add({
          kind: "assistant",
          id: `${uuid}:${i}`,
          ts,
          text,
        });
        if (e) out.push(e);
      } else if (block.type === "tool_use") {
        const id = str(block.id);
        const name = str(block.name);
        if (!id || !name) return;
        const input = isObject(block.input) ? block.input : {};
        let entry: ChatEntry;
        if (name === "AskUserQuestion") {
          entry = {
            kind: "question",
            id,
            ts,
            questions: parseQuestions(input),
            answer: null,
          };
        } else if (name === "ExitPlanMode") {
          entry = {
            kind: "plan",
            id,
            ts,
            plan: str(input.plan) ?? "",
            outcome: null,
          };
        } else if (name === "Agent" || name === "Task") {
          entry = {
            kind: "task",
            id,
            ts,
            taskKind: "agent",
            title:
              str(input.description)?.trim() ||
              str(input.subagent_type) ||
              "Agent",
            agentType: str(input.subagent_type),
            model: str(input.model),
            background: isTrue(input.run_in_background),
            status: "running",
            hasTranscript: false,
          };
        } else if (name === "Bash" && isTrue(input.run_in_background)) {
          entry = {
            kind: "task",
            id,
            ts,
            taskKind: "shell",
            title: summarizeTool(name, input),
            background: true,
            status: "running",
            hasTranscript: false,
          };
        } else {
          entry = {
            kind: "tool",
            id,
            ts,
            name,
            summary: summarizeTool(name, input),
            status: "pending",
          };
        }
        const e = this.add(entry);
        if (e) out.push(e);
      }
      // thinking and unknown block types: dropped
    });
    return out;
  }

  private skillListing(attachment: unknown): void {
    if (!isObject(attachment) || attachment.type !== "skill_listing") return;
    const listed = parseSkillLines(str(attachment.content) ?? "");
    const next = new Map<string, string>();
    if (Array.isArray(attachment.names)) {
      for (const n of attachment.names) {
        if (typeof n === "string" && n) next.set(n, listed.get(n) ?? "");
      }
    } else {
      for (const [n, d] of listed) next.set(n, d);
    }
    this.sawSkillListing = true;
    if (attachment.isInitial === true) this.skillMap.clear();
    for (const [n, d] of next) this.skillMap.set(n, d);
  }

  private userText(uuid: string, ts: string, text: string): ChatEntry | null {
    if (!text.trim()) return null;
    const cmd = tagText(text, "command-name")?.trim();
    if (cmd && cmd.startsWith("/") && cmd.length > 1) {
      const args = tagText(text, "command-args")?.trim() ?? "";
      const e = this.add({
        kind: "command",
        id: uuid,
        ts,
        name: cmd.slice(1),
        args,
      });
      if (e) this.lastCommandId = uuid;
      return e;
    }
    if (text.trimStart().startsWith("<local-command-stdout>")) {
      const out = (tagText(text, "local-command-stdout") ?? "").trim();
      const existing = this.lastCommandId
        ? this.byId.get(this.lastCommandId)
        : undefined;
      if (!out || !existing || existing.kind !== "command") return null;
      const next: ChatEntry = { ...existing, output: out.slice(0, MAX_DETAIL) };
      this.byId.set(existing.id, next);
      return next;
    }
    // A background task finishing lands as a user turn the user never typed.
    if (text.trimStart().startsWith("<task-notification>")) {
      return this.notification(uuid, ts, text);
    }
    if (isMetaText(text)) return null;
    return this.add({ kind: "user", id: uuid, ts, text });
  }

  /**
   * A `<task-notification>`: settle the task it names, else fall back to a
   * notice. It can arrive as a queued attachment and again as a user line, so
   * updating a task twice is fine and a notice is made once.
   */
  private notification(uuid: string, ts: string, text: string): ChatEntry | null {
    const summary = tagText(text, "summary")?.trim();
    if (!summary) return null;
    const status = tagText(text, "status")?.trim();
    const target = tagText(text, "tool-use-id")?.trim();
    const task = target ? this.byId.get(target) : undefined;
    if (task && task.kind === "task") {
      const next: ChatEntry = {
        ...task,
        status:
          status === "failed"
            ? "error"
            : status === "killed"
              ? "killed"
              : "ok",
        result: summary.slice(0, MAX_DETAIL),
      };
      this.byId.set(task.id, next);
      return next;
    }
    const id = tagText(text, "task-id")?.trim() || target;
    if (id) {
      const key = `${id}:${status ?? ""}`;
      if (this.seenNotices.has(key)) return null;
      this.seenNotices.add(key);
    }
    return this.add({
      kind: "notice",
      id: uuid,
      ts,
      text: summary,
      status: status === "failed" || status === "killed" ? "error" : "ok",
    });
  }

  /** Apply a tool_result block to its pending entry. */
  private resolve(block: Json, toolUseResult?: unknown): ChatEntry | null {
    const id = str(block.tool_use_id);
    if (!id) return null;
    const existing = this.byId.get(id);
    if (!existing) return null;
    const text = resultText(block.content);
    const isError = block.is_error === true;

    // Entries are replaced with new objects so consumers can compare by identity.
    let next: ChatEntry;
    switch (existing.kind) {
      case "tool":
        next = {
          ...existing,
          status: isError ? "error" : "ok",
          detail: text ? text.slice(0, MAX_DETAIL) : undefined,
        };
        break;
      case "question":
        next = { ...existing, answer: text };
        break;
      case "plan":
        next = { ...existing, outcome: text };
        break;
      case "task": {
        const info = isObject(toolUseResult) ? toolUseResult : {};
        const ref = str(info.agentId) ?? str(info.backgroundTaskId);
        next = { ...existing };
        if (info.isAsync === true) next.background = true;
        if (ref) next.taskRef = ref;
        if (str(info.agentId) && existing.taskKind === "agent") {
          next.hasTranscript = true;
        }
        // A launch, not a finish: the notification settles it later.
        if (!next.background) {
          next.status = isError ? "error" : "ok";
          next.result = text ? text.slice(0, MAX_DETAIL) : undefined;
        }
        break;
      }
      default:
        return null;
    }
    this.byId.set(id, next);
    return next;
  }
}
