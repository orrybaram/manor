/**
 * **Held output**: what a terminal pane off screen has received but not yet
 * written to xterm.
 *
 * Parsing is most of what a terminal costs, and a pane nobody can see has no
 * reason to pay it as the output arrives. So while a pane is hidden its
 * chunks (and the resizes among them, in order) are held here, and written
 * when it catches up: on show, on focus or input, or straight away when a
 * terminal query arrives (see `held-output-scan.ts`).
 *
 * Holding is bounded. Past {@link HOLD_LIMIT_CHARS} the held chunks are
 * dropped and the pane catches up from the host's snapshot instead, which is
 * the screen and scrollback in a fraction of the size, and cheaper to write
 * than megabytes of replay.
 */

import { HeldOutputScanner, type HeldOutputScan } from "./held-output-scan";
import type { QueuedOutput } from "./snapshot-dedupe";

/** Chars held before the pane gives up replaying and restores from a snapshot. */
export const HOLD_LIMIT_CHARS = 1_000_000;

/** A held chunk of output, or a resize at its place among them. */
export type HeldItem =
  | { kind: "data"; chunk: QueuedOutput }
  | { kind: "resize"; cols: number; rows: number };

/** How a pane catches up on what it held. */
export type CatchUp =
  /** Write these, in order. Empty when nothing was held. */
  | { kind: "write"; items: HeldItem[] }
  /** Too much was held: restore the screen from the host's snapshot. */
  | { kind: "restore" };

export class HeldOutput {
  private items: HeldItem[] = [];
  private chars = 0;
  private overflowed = false;
  private readonly scanner = new HeldOutputScanner();

  /** Hold `chunk`; says whether it asked a query (catch up now) or set a title. */
  push(chunk: QueuedOutput): HeldOutputScan {
    if (!this.overflowed) {
      this.items.push({ kind: "data", chunk });
      this.chars += chunk.data.length;
      if (this.chars > HOLD_LIMIT_CHARS) {
        this.overflowed = true;
        this.items = [];
        this.chars = 0;
      }
    }
    return this.scanner.scan(chunk.data);
  }

  /** Hold a resize at its place in the stream. A snapshot is taken at the latest size. */
  pushResize(cols: number, rows: number): void {
    if (!this.overflowed) this.items.push({ kind: "resize", cols, rows });
  }

  /**
   * Everything held, as what to do about it; holding goes on empty. The
   * scanner keeps its place, since a sequence can straddle a catch-up.
   */
  take(): CatchUp {
    if (this.overflowed) {
      this.overflowed = false;
      return { kind: "restore" };
    }
    const items = this.items;
    this.items = [];
    this.chars = 0;
    return { kind: "write", items };
  }

  /** How much is held: chars of output, and whether it overflowed into a restore. */
  get size(): { chars: number; overflowed: boolean } {
    return { chars: this.chars, overflowed: this.overflowed };
  }
}

/** localStorage key that turns holding off (`"off"`): the kill switch. */
export const HOLD_SWITCH_KEY = "manor:holdHiddenOutput";

/** Whether hidden panes hold their output; on unless the kill switch says off. */
export function holdingEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(HOLD_SWITCH_KEY) !== "off";
  } catch {
    return true;
  }
}
