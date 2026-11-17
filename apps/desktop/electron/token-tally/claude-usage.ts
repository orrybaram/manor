import { createHash } from "node:crypto";
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
 * the same usage under the same `message.id`, so a message counts once. A
 * later line may report more output than an earlier one; only the increase
 * is added. A message's lines are contiguous, so the marker remembers only
 * the most recent ids, hashed.
 *
 * A forked session's transcript opens with the original's lines, timestamps
 * and all: usage dated before the marker's `floor` doesn't count.
 *
 * A session's subagents write their own transcripts, in
 * `<transcript dir>/<session id>/subagents/agent-*.jsonl`, with the same
 * usage lines. Each is a source of its own.
 */

/** Message ids a marker remembers: more than enough for contiguous lines. */
const RECENT_IDS = 32;

interface ClaudeLineUsage {
  id: string | null;
  fresh: number;
  /** The line's own `timestamp`, epoch ms; null when it has none. */
  at: number | null;
}

/** One assistant line's message id, fresh tokens and time, or null for any other line. */
export function claudeLineUsage(line: string): ClaudeLineUsage | null {
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
  const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
  return {
    id: typeof message.id === "string" ? message.id : null,
    fresh,
    at: Number.isNaN(at) ? null : at,
  };
}

interface CountState {
  fresh: number;
  seen: [string, number][];
}

/**
 * The fresh tokens in `lines`, each message counted once (and topped up when
 * a later line reports more), given what `seen` already counted. Usage dated
 * before `floor` is left out. Returns what to remember next, newest last.
 */
export function claudeFreshTokens(
  lines: Iterable<string>,
  seen: readonly [string, number][] = [],
  floor?: number,
): CountState {
  const state: CountState = { fresh: 0, seen: seen.map(([id, n]) => [id, n]) };
  for (const line of lines) countLine(state, line, floor);
  return state;
}

/** Adds one line's fresh tokens to `state`, less what its message already counted. */
function countLine(state: CountState, line: string, floor: number | undefined): void {
  const usage = claudeLineUsage(line);
  if (!usage) return;
  if (floor !== undefined && usage.at !== null && usage.at < floor) return;
  if (usage.id === null) {
    state.fresh += usage.fresh;
    return;
  }
  const key = idHash(usage.id);
  const entry = state.seen.find(([id]) => id === key);
  if (entry) {
    if (usage.fresh > entry[1]) {
      state.fresh += usage.fresh - entry[1];
      entry[1] = usage.fresh;
    }
    return;
  }
  state.seen.push([key, usage.fresh]);
  if (state.seen.length > RECENT_IDS) state.seen.shift();
  state.fresh += usage.fresh;
}

/** A message id as the marker keeps it: a short hash, never the id. */
function idHash(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
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
    const state: CountState = { fresh: 0, seen: (marker.seen ?? []).map(([id, n]) => [id, n]) };
    const offset = await scanJsonlLines(source, marker.offset, (line) =>
      countLine(state, line, marker.floor),
    );
    const next: UsageMarker = {
      ...marker,
      offset,
      ...(state.seen.length > 0 ? { seen: state.seen } : {}),
    };
    return { fresh: state.fresh, next };
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
