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
    }
  | {
      kind: "plan";
      id: string;
      ts: string;
      plan: string;
      outcome: string | null;
    };

const MAX_DETAIL = 4000;
const META_PREFIXES = ["<command-", "<local-command", "<system-reminder>"];

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function firstLine(s: string): string {
  return s.split("\n", 1)[0].trim();
}

function isMetaText(text: string): boolean {
  const t = text.trimStart();
  return META_PREFIXES.some((p) => t.startsWith(p));
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

export class TranscriptParser {
  private order: string[] = [];
  private byId = new Map<string, ChatEntry>();

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
    if (parsed.isSidechain === true) return [];
    const type = parsed.type;
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
          const e = this.resolve(block);
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

  private userText(uuid: string, ts: string, text: string): ChatEntry | null {
    if (!text.trim() || isMetaText(text)) return null;
    return this.add({ kind: "user", id: uuid, ts, text });
  }

  /** Apply a tool_result block to its pending entry. */
  private resolve(block: Json): ChatEntry | null {
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
      default:
        return null;
    }
    this.byId.set(id, next);
    return next;
  }
}
