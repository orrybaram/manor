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
  /**
   * Too much was held: restore the screen from the host's snapshot, then
   * write `queries`, the terminal queries (and kitty keyboard changes) in
   * the output that was dropped, so xterm still answers them.
   */
  | { kind: "restore"; queries: string[] };

/** Queries kept from dropped output, at most; a flood of them keeps the latest. */
export const MAX_KEPT_QUERIES = 64;

export class HeldOutput {
  private items: HeldItem[] = [];
  private chars = 0;
  private overflowed = false;
  /** Queries in output dropped since the hold overflowed. */
  private queries: string[] = [];
  private scanner = new HeldOutputScanner();

  /** Hold `chunk`; says whether it asked a query (catch up now) or set a title. */
  push(chunk: QueuedOutput): HeldOutputScan {
    const scan = this.scanner.scan(chunk.data);
    if (!this.overflowed) {
      this.items.push({ kind: "data", chunk });
      this.chars += chunk.data.length;
      if (this.chars > HOLD_LIMIT_CHARS) {
        this.overflowed = true;
        this.items = [];
        this.chars = 0;
      }
    }
    // Dropped output's drawing is in the snapshot, but its queries are not.
    // (Held chunks before this one asked none: a query catches up at once.)
    if (this.overflowed) this.keepQueries(scan.queries);
    return scan;
  }

  private keepQueries(queries: readonly string[]): void {
    if (queries.length === 0) return;
    this.queries.push(...queries);
    if (this.queries.length > MAX_KEPT_QUERIES) this.queries.splice(0, this.queries.length - MAX_KEPT_QUERIES);
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
      const queries = this.queries;
      this.queries = [];
      // The snapshot starts the stream afresh; so does reading it.
      this.scanner = new HeldOutputScanner();
      return { kind: "restore", queries };
    }
    const items = this.items;
    this.items = [];
    this.chars = 0;
    return { kind: "write", items };
  }

  /** Drop everything held: an attach's snapshot is about to cover it. */
  clear(): void {
    this.items = [];
    this.chars = 0;
    this.overflowed = false;
    this.queries = [];
    this.scanner = new HeldOutputScanner();
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
