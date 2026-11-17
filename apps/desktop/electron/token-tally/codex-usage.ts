import { count, isRecord, jsonlCreatedAt, scanJsonlLines } from "./jsonl-scan";
import type { UsageMarker, UsageRead, UsageReader } from "./usage-reader";

/**
 * Codex's usage, from its rollout JSONL.
 *
 * Each `event_msg` `token_count` carries `info.total_token_usage`, the
 * session's cumulative usage so far. Fresh tokens are
 * `input_tokens − cached_input_tokens + output_tokens` of that total, and a
 * read counts how far it rose past the marker's `total`: a repeated
 * token_count adds nothing. A total that fell (Codex started counting again)
 * counts from zero.
 *
 * Totals dated before the marker's `floor` (a forked session's copied
 * history) move the marker's `total` without counting.
 */

/** A `token_count` line's cumulative fresh total and time, or null for any other line. */
export function codexLineTotal(line: string): { total: number; at: number | null } | null {
  if (!line.includes('"token_count"')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.type !== "event_msg") return null;
  const payload = parsed.payload;
  if (!isRecord(payload) || payload.type !== "token_count" || !isRecord(payload.info)) return null;
  const usage = payload.info.total_token_usage;
  if (!isRecord(usage)) return null;
  const total = Math.max(0, count(usage.input_tokens) - count(usage.cached_input_tokens)) + count(usage.output_tokens);
  const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
  return { total, at: Number.isNaN(at) ? null : at };
}

/** Counts one line's rise past `state.total`, and moves the total. */
function countTotals(
  state: { fresh: number; total: number | undefined },
  line: string,
  floor: number | undefined,
): void {
  const usage = codexLineTotal(line);
  if (!usage) return;
  const previous = state.total ?? 0;
  state.total = usage.total;
  if (floor !== undefined && usage.at !== null && usage.at < floor) return;
  state.fresh += usage.total >= previous ? usage.total - previous : usage.total;
}

export const codexUsageReader: UsageReader = {
  async sources(transcriptPath) {
    return [transcriptPath];
  },

  createdAt: jsonlCreatedAt,

  async markerAtEnd(source) {
    // The total so far, so the next token_count counts only its rise.
    const state: { fresh: number; total: number | undefined } = { fresh: 0, total: undefined };
    const offset = await scanJsonlLines(source, 0, (line) => countTotals(state, line, undefined));
    return { offset, ...(state.total !== undefined ? { total: state.total } : {}) };
  },

  async read(marker, source): Promise<UsageRead> {
    const state = { fresh: 0, total: marker.total };
    const offset = await scanJsonlLines(source, marker.offset, (line) => countTotals(state, line, marker.floor));
    const next: UsageMarker = { ...marker, offset, ...(state.total !== undefined ? { total: state.total } : {}) };
    return { fresh: state.fresh, next };
  },
};
