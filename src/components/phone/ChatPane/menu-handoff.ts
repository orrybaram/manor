/**
 * A menu handoff (ADR-218 D3) as pure data: the chat sent a command that
 * opens a TUI menu, and the pane shows the terminal until the menu closes.
 * Kept apart from the store so the rules are testable without one.
 */

import type { ChatEntry } from "../../../electron.d";

/** A menu command the chat sent and handed to the terminal (ADR-218 D3). */
export type MenuHandoff = {
  /** The command's name, without the `/`. */
  name: string;
  /** When it was sent, in ms since the epoch. */
  startedAt: number;
  /** The transcript the pane was on when it was sent (null for an agent
   *  with none yet). A different one, as `/resume` brings, ends it. */
  transcript: string | null;
};

/** Clock slack between this device's send and the transcript's timestamp. */
const HANDOFF_SLACK_MS = 2_000;

/**
 * Whether `entry` means the TUI menu `handoff` waits on has closed (ADR-218
 * D3): the handoff's command, logged at or after it was sent. A menu
 * command's transcript line is written when the menu completes, not when it
 * opens. A `ts` that doesn't parse never ends it.
 */
export function endsMenuHandoff(handoff: MenuHandoff, entry: ChatEntry): boolean {
  if (entry.kind !== "command" || entry.name !== handoff.name) return false;
  const ts = Date.parse(entry.ts);
  return !Number.isNaN(ts) && ts >= handoff.startedAt - HANDOFF_SLACK_MS;
}

/** `handoff` if it is still live for a pane now on `transcript`, else null. */
export function liveMenuHandoff(
  handoff: MenuHandoff | undefined,
  transcript: string | null,
): MenuHandoff | null {
  return handoff && handoff.transcript === transcript ? handoff : null;
}
