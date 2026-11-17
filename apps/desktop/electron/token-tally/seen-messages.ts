import { createHash } from "node:crypto";

/**
 * Fresh tokens counted per message, for a reader whose source can report one
 * message's usage more than once (Claude's per-block lines, opencode's rows
 * updated in place). A marker's `seen`: the most recent messages, oldest
 * first, each a short hash of its id and what it has counted so far.
 */
export interface CountState {
  fresh: number;
  seen: [string, number][];
}

export function countState(seen: readonly [string, number][] | undefined): CountState {
  return { fresh: 0, seen: (seen ?? []).map(([id, n]) => [id, n]) };
}

/**
 * Adds a message's usage to `state`: all of it the first time, then only an
 * increase. `limit` is how many messages are remembered.
 */
export function countMessage(state: CountState, id: string, fresh: number, limit: number): void {
  const key = idHash(id);
  const entry = state.seen.find(([seen]) => seen === key);
  if (entry) {
    if (fresh > entry[1]) {
      state.fresh += fresh - entry[1];
      entry[1] = fresh;
    }
    return;
  }
  state.seen.push([key, fresh]);
  if (state.seen.length > limit) state.seen.shift();
  state.fresh += fresh;
}

/** A message id as a marker keeps it: a short hash, never the id. */
function idHash(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}
