/**
 * Which of the chat's items are mounted. A long session has thousands, and
 * each costs markdown parsing on open and layout on the phone, so the chat
 * mounts only the newest ones and adds earlier ones as the user scrolls up.
 *
 * The window runs from its first item to the newest. It is anchored by that
 * first item's id rather than a count from the end, so entries landing at the
 * bottom never push items out of the top while the user is reading. No
 * anchor means "the newest `WINDOW_ITEMS`": the chat at the bottom, sliding
 * as entries land.
 */

import type { ChatItem } from "./chat-entries";

/** Items mounted at the bottom of the chat. */
export const WINDOW_ITEMS = 150;

/** Items added above the window each time the user nears its top. */
export const EARLIER_ITEMS = 100;

/**
 * The index of the window's first item. An anchor that's gone (it can't be,
 * as ids only ever upsert, but the chat must still draw) falls back to the
 * newest items.
 */
export function windowStart(items: readonly ChatItem[], anchorId: string | null): number {
  if (anchorId !== null) {
    const index = items.findIndex((item) => item.id === anchorId);
    if (index !== -1) return index;
  }
  return Math.max(0, items.length - WINDOW_ITEMS);
}

/** The anchor that adds up to `EARLIER_ITEMS` above a window starting at `start`. */
export function earlierAnchor(items: readonly ChatItem[], start: number): string | null {
  return items[Math.max(0, start - EARLIER_ITEMS)]?.id ?? null;
}
