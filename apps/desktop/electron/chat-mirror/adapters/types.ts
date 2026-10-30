/**
 * The seam between the agent-neutral mirror (offsets, tailing, sources,
 * watching, pickers) and a transcript format that belongs to one agent.
 * An adapter only has to map its agent's format onto the shared
 * `ChatEntry` union.
 */

import type { ChatEntry, ChatSkill, ChatTaskEntry, ChatTurnState } from "../transcript";

/** The first and last few KiB of a line too long to read. */
export interface OversizedRecord {
  head: string;
  tail: string;
}

/** Reads one transcript, a line at a time. */
export interface TranscriptLineParser {
  /**
   * Feed one line; `offset` is its starting byte in the file, which names a
   * line that carries no id of its own.
   */
  push(line: string, offset?: number): ChatEntry[];
  /**
   * A line too long to read was stepped over at `offset`; `record` is its
   * two ends, likely cut mid-JSON. Returns entries it settled, if it can
   * tell what the line was. Optional: without it the line is just gone.
   */
  oversized?(record: OversizedRecord, offset: number): ChatEntry[];
  entries(): ChatEntry[];
  /** The entry with `id`, as it stands now. */
  entry(id: string): ChatEntry | undefined;
  contextTokens(): number | null;
  /** The main thread's turn as the transcript tells it; null until it says. */
  turnState(): ChatTurnState | null;
  skills(): ChatSkill[];
  hasSkillListing(): boolean;
}

export interface TranscriptAdapter {
  /**
   * A fresh line parser for one transcript. `child` marks the transcript of a
   * delegated task rather than the pane's own.
   */
  createParser(opts?: { child?: boolean }): TranscriptLineParser;
  /**
   * Where a task's own transcript lives, given the parent's path and the
   * task entry. Null when the agent writes none, or this task has none.
   */
  childTranscriptPath(parentPath: string, task: ChatTaskEntry): string | null;
  /**
   * The PTY writes that type `text` into the agent's prompt and submit it,
   * as one prompt even across lines. Sent in order with a pause between
   * each (`chat.send`), so the last can land as its own keypress.
   */
  promptWrites(text: string): string[];
}
