/**
 * The seam between the agent-neutral mirror (offsets, tailing, sources,
 * watching, pickers) and a transcript format that belongs to one agent.
 * An adapter only has to map its agent's format onto the shared
 * `ChatEntry` union.
 */

import type { ChatEntry, ChatSkill, ChatTaskEntry } from "../transcript";

/** Reads one transcript, a line at a time. */
export interface TranscriptLineParser {
  /**
   * Feed one line; `offset` is its starting byte in the file, which names a
   * line that carries no id of its own.
   */
  push(line: string, offset?: number): ChatEntry[];
  /**
   * A line too long to read was stepped over at `offset`; `head` is its
   * first few KiB, likely cut mid-JSON. Returns entries it settled, if it
   * can tell what the line was. Optional: without it the line is just gone.
   */
  oversized?(head: string, offset: number): ChatEntry[];
  entries(): ChatEntry[];
  /** The entry with `id`, as it stands now. */
  entry(id: string): ChatEntry | undefined;
  contextTokens(): number | null;
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
}
