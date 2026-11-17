import { count, isRecord, fileSize, jsonlCreatedAt, scanJsonlLines } from "./jsonl-scan";
import { countMessage, countState, type CountState } from "./seen-messages";
import type { UsageMarker, UsageRead, UsageReader } from "./usage-reader";

/**
 * pi's usage, from its session JSONL: each assistant `message` entry carries
 * `message.usage`. Fresh tokens are `input + cacheWrite + output`; cache reads
 * are left out. Counted once per entry id, should an entry be written again,
 * and not before the marker's `floor`.
 */

const RECENT_IDS = 32;

/** One assistant entry's id, fresh tokens and time, or null for any other line. */
export function piLineUsage(line: string): { id: string | null; fresh: number; at: number | null } | null {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "message") return null;
  const message = parsed.message;
  if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return null;
  const usage = message.usage;
  const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
  return {
    id: typeof parsed.id === "string" ? parsed.id : null,
    fresh: count(usage.input) + count(usage.cacheWrite) + count(usage.output),
    at: Number.isNaN(at) ? null : at,
  };
}

function countLine(state: CountState, line: string, floor: number | undefined): void {
  const usage = piLineUsage(line);
  if (!usage) return;
  if (floor !== undefined && usage.at !== null && usage.at < floor) return;
  if (usage.id === null) state.fresh += usage.fresh;
  else countMessage(state, usage.id, usage.fresh, RECENT_IDS);
}

export const piUsageReader = {
  async sources(transcriptPath) {
    return [transcriptPath];
  },

  createdAt: jsonlCreatedAt,

  async markerAtEnd(source) {
    return { offset: await fileSize(source) };
  },

  async read(marker, source): Promise<UsageRead> {
    const state = countState(marker.seen);
    const offset = await scanJsonlLines(source, marker.offset, (line) => countLine(state, line, marker.floor));
    const next: UsageMarker = { ...marker, offset, ...(state.seen.length > 0 ? { seen: state.seen } : {}) };
    return { fresh: state.fresh, next };
  },
} satisfies UsageReader;
