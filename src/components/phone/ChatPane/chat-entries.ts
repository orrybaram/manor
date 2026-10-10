/**
 * The phone chat view's entry list, kept as pure functions so the view's
 * ordering and "which picker can be answered" rules are testable without a
 * DOM (ADR-215 D5, D7).
 */

import type { ChatEntry } from "../../../electron.d";

/** Add `entry`, or replace the one with its id in place. Updates keep their position. */
export function upsertEntry(
  entries: readonly ChatEntry[],
  entry: ChatEntry,
): ChatEntry[] {
  const index = entries.findIndex((e) => e.id === entry.id);
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

/**
 * Lay a fetched history under entries that arrived live before it did.
 *
 * The subscription is opened first so nothing published in between is lost
 * (ticket 4). The history is the base, in transcript order; a live entry it
 * already holds keeps the history's copy, and one it doesn't is appended.
 */
export function mergeHistory(
  history: readonly ChatEntry[],
  live: readonly ChatEntry[],
): ChatEntry[] {
  const known = new Set(history.map((e) => e.id));
  return [...history, ...live.filter((e) => !known.has(e.id))];
}

/** An open picker: a question with no answer yet, or a plan with no outcome. */
export function isOpenPicker(entry: ChatEntry): boolean {
  if (entry.kind === "question") return entry.answer === null;
  if (entry.kind === "plan") return entry.outcome === null;
  return false;
}

/**
 * The id of the one picker the chat may answer: the newest question or plan,
 * if it is still open. An older open picker is stale (the mirror refuses it
 * too), and so is everything once the newest picker has been answered.
 */
export function answerablePickerId(entries: readonly ChatEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind !== "question" && entry.kind !== "plan") continue;
    return isOpenPicker(entry) ? entry.id : null;
  }
  return null;
}
