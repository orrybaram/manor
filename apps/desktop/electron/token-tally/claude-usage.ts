import fs from "node:fs";
import path from "node:path";

import { fileSize, scanJsonlLines } from "./jsonl-scan";
import type { UsageMarker, UsageRead, UsageReader } from "./usage-reader";

/**
 * Claude's usage, from its JSONL transcripts.
 *
 * Each assistant line carries its message's `message.usage`. Fresh tokens are
 * `input_tokens + cache_creation_input_tokens + output_tokens`; cache reads
 * are left out, since every turn re-reads the whole context from cache.
 *
 * One message is written as one line per content block, every one repeating
 * the same usage under the same `message.id`, so a message counts once. Its
 * lines are contiguous, so the marker remembers only the most recent ids.
 *
 * A session's subagents write their own transcripts, in
 * `<transcript dir>/<session id>/subagents/agent-*.jsonl`, with the same
 * usage lines. Each is a source of its own.
 */

/** Message ids a marker remembers: more than enough for contiguous lines. */
const RECENT_IDS = 32;

/** One assistant line's message id and fresh tokens, or null for any other line. */
export function claudeLineUsage(line: string): { id: string | null; fresh: number } | null {
  // Most lines are tool results and prompts: skip them before parsing.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "assistant") return null;
  const message = parsed.message;
  if (!isRecord(message) || !isRecord(message.usage)) return null;
  const usage = message.usage;
  const fresh =
    count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.output_tokens);
  return { id: typeof message.id === "string" ? message.id : null, fresh };
}

/**
 * The fresh tokens in `lines`, each message counted once, given the ids
 * already counted. Returns the ids to remember next, newest last.
 */
export function claudeFreshTokens(
  lines: Iterable<string>,
  counted: readonly string[] = [],
): { fresh: number; ids: string[] } {
  const state = { fresh: 0, ids: [...counted] };
  for (const line of lines) countLine(state, line);
  return state;
}

/** Adds one line's fresh tokens to `state`, unless its message already counted. */
function countLine(state: { fresh: number; ids: string[] }, line: string): void {
  const usage = claudeLineUsage(line);
  if (!usage) return;
  if (usage.id !== null) {
    if (state.ids.includes(usage.id)) return;
    state.ids.push(usage.id);
    if (state.ids.length > RECENT_IDS) state.ids.shift();
  }
  state.fresh += usage.fresh;
}

export const claudeUsageReader: UsageReader = {
  async sources(transcriptPath) {
    const sessionDir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"));
    const subagentDir = path.join(sessionDir, "subagents");
    let names: string[];
    try {
      names = await fs.promises.readdir(subagentDir);
    } catch {
      names = [];
    }
    const subagents = names
      .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
      .sort()
      .map((name) => path.join(subagentDir, name));
    return [transcriptPath, ...subagents];
  },

  async createdAt(source) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(source);
    } catch {
      return null;
    }
    if (stat.birthtimeMs > 0) return stat.birthtimeMs;
    // No birth time on this filesystem: the first line that says when.
    let first: number | null = null;
    await scanJsonlLines(source, 0, (line) => {
      const match = /"timestamp":"([^"]+)"/.exec(line);
      const at = match ? Date.parse(match[1]) : NaN;
      if (Number.isNaN(at)) return;
      first = at;
      return "stop";
    }).catch(() => undefined);
    return first;
  },

  async markerAtEnd(source) {
    return { offset: await fileSize(source) };
  },

  async read(marker, source): Promise<UsageRead> {
    const state = { fresh: 0, ids: [...(marker.ids ?? [])] };
    const offset = await scanJsonlLines(source, marker.offset, (line) => countLine(state, line));
    const next: UsageMarker = { offset, ...(state.ids.length > 0 ? { ids: state.ids } : {}) };
    return { fresh: state.fresh, next };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
